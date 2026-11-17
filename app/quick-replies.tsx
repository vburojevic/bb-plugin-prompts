// Quick replies: the next messages worth sending, one tap above the composer.
//
// When a turn finishes in the thread on screen, the thread's own provider
// reads the end of the conversation with its fastest model and suggests what
// to send next, mixed with the user's habits and snippets when they fit. The
// row shows the user's usual chips at once and swaps in the model's picks when
// they land. The best next step leads as a solid chip, and the card above the
// chips shows exactly what the hovered, focused or long-pressed chip sends and
// why.
//
// Other moments: a failed turn leads with Retry, an interrupted one with
// Continue; while the agent works, chips queue for the end of the turn; a
// draft narrows the row to chips that complete it; while the agent waits on
// an answer the row hides, because the answer form owns the composer.
//
// Nothing sends without a tap or its shortcut. With a draft in the composer a
// chip joins the draft instead, so a half-written prompt is never sent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads,
  useComposer,
  useRpc,
  useSdk,
  useSettings,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { AiReplyDto, rpcContract } from "../lib/contract";
import {
  DEFAULT_AFTER_STOP,
  DEFAULT_ANY_TIME,
  defaultFocus,
  parseReplyLines,
  quickReplyState,
  replyKey,
  rowFor,
  shortLabel,
  turnOutcomeFromEvents,
  type AiStatus,
  type QuickReply,
  type QuickReplyState,
  type RowItem,
  type RowKind,
  type TurnOutcome,
} from "../lib/quick-replies";
import { composerThreadIdFromScope, useComposerThreadId, usePromptSignal } from "./shared";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Event types that say how the latest turn ended. */
const TURN_EVENT_TYPES = [
  "turn/started",
  "turn/completed",
  "system/thread/interrupted",
] as const;

const KIND_ICON: Record<RowKind, IconName | null> = {
  answer: "ArrowTurnBackward",
  ai: "Sparkles",
  habit: "History",
  snippet: "Bookmark",
  any: null,
  retry: "ArrowReloadHorizontal",
};

const KIND_NAME: Record<RowKind, string> = {
  answer: "Answer",
  ai: "Suggested",
  habit: "Your habit",
  snippet: "Snippet",
  any: "Your chip",
  retry: "Retry",
};

/** Chips the keyboard reaches: Option or Alt plus 1 to this. */
export const QUICK_REPLY_SHORTCUTS = 5;

// ---------------------------------------------------------------------------
// Keyboard: bb runs a composer command in the composer holding the caret; the
// row on screen for that thread registers how to run its chips.

const runners = new Map<string, (index: number) => void>();

/** Run chip `index` of the row above `composer`. */
export function runQuickReply(composer: PluginComposerApi, index: number): void {
  const threadId = composerThreadIdFromScope(composer.scope);
  if (threadId !== null) runners.get(threadId)?.(index);
}

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function shortcutFor(index: number) {
  const key = String(index + 1);
  return { ariaKeyshortcuts: `Alt+${key}`, label: IS_MAC ? `⌥${key}` : `Alt+${key}` };
}

/** A keycap for a chip's shortcut; hidden on touch, where there is no keyboard. */
function Keycap({ index, className }: { index: number; className?: string }) {
  return (
    <kbd
      aria-hidden
      className={cn(
        "rounded-[4px] px-1 font-mono text-[10px] leading-4 tracking-tight shadow-[inset_0_0_0_1px_currentColor] opacity-60",
        "max-md:pointer-coarse:hidden",
        className,
      )}
    >
      {shortcutFor(index).label}
    </kbd>
  );
}

// ---------------------------------------------------------------------------
// Data.

/**
 * How the thread's latest turn ended. Read from the event log when the
 * thread's status changes, never polled: bb announces status changes, and the
 * outcome cannot change without one.
 */
function useTurnOutcome(threadId: string | null, status: string | null): TurnOutcome {
  const sdk = useSdk();
  const [outcome, setOutcome] = useState<{ threadId: string | null; value: TurnOutcome }>({
    threadId: null,
    value: "none",
  });
  const generation = useRef(0);

  const load = useCallback(() => {
    if (threadId === null) return;
    const mine = ++generation.current;
    void sdk.threads.events
      .list({ threadId, order: "desc", limit: "20", types: [...TURN_EVENT_TYPES] })
      .then((rows) => {
        if (generation.current !== mine) return;
        setOutcome({ threadId, value: turnOutcomeFromEvents(rows) });
      })
      .catch(() => {
        // An unreadable log leaves the row on its any-time chips.
        if (generation.current === mine) setOutcome({ threadId, value: "none" });
      });
  }, [sdk, threadId]);

  // A status change is the moment a turn ends or starts.
  useEffect(() => {
    load();
  }, [load, status]);

  // An interrupt can land as its own event after the status settled.
  useEffect(() => {
    if (threadId === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        if (
          !event.changes.includes("status-changed") &&
          !event.changes.includes("events-appended")
        )
          return;
        if (timer !== null) return;
        timer = setTimeout(() => {
          timer = null;
          load();
        }, 400);
      },
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [sdk, threadId, load]);

  return outcome.threadId === threadId ? outcome.value : "none";
}

interface Pool {
  learned: QuickReply[];
  snippets: QuickReply[];
}

const EMPTY_POOL: Pool = { learned: [], snippets: [] };

/** Habits and snippets, refreshed when a history scan or the library changes. */
function useQuickReplyPool(enabled: boolean, projectId: string | null): Pool {
  const rpc = useRpc<typeof rpcContract>();
  const [pool, setPool] = useState<Pool>(EMPTY_POOL);

  const load = useCallback(() => {
    if (!enabled) return;
    void rpc
      .call("quickReplies", { projectId })
      .then((result) => setPool({ learned: result.learned, snippets: result.snippets }))
      .catch(() => {
        // The fallback chips cover a failed read.
      });
  }, [rpc, enabled, projectId]);

  useEffect(load, [load]);
  usePromptSignal(["suggestions", "snippets"], null, load);
  return pool;
}

interface AiState {
  threadId: string | null;
  status: AiStatus;
  turnKey: string | null;
  replies: AiReplyDto[];
  error: string | null;
}

const AI_IDLE: AiState = { threadId: null, status: "idle", turnKey: null, replies: [], error: null };

/**
 * The model's suggestions for the thread's latest turn. Asks when a turn ends
 * in the thread on screen (or when it opens on a turn with none yet); the
 * server answers from its cache or starts one generation and announces the
 * replies over realtime.
 */
function useAiReplies(threadId: string | null, state: QuickReplyState) {
  const rpc = useRpc<typeof rpcContract>();
  const [read, setRead] = useState<AiState>(AI_IDLE);
  const outcome = state === "finished" ? "finished" : state === "interrupted" ? "interrupted" : null;
  const latest = useRef(0);

  const load = useCallback(
    (refresh: boolean) => {
      if (threadId === null || outcome === null) return;
      const mine = ++latest.current;
      void rpc
        .call("aiQuickReplies", { threadId, outcome, refresh })
        .then((result) => {
          if (latest.current !== mine) return;
          setRead({
            threadId,
            status: result.status,
            turnKey: result.turnKey,
            replies: result.replies,
            error: result.error,
          });
        })
        .catch((error: unknown) => {
          if (latest.current !== mine) return;
          setRead({
            threadId,
            status: "error",
            turnKey: null,
            replies: [],
            error: error instanceof Error ? error.message : "Could not reach the plugin",
          });
        });
    },
    [rpc, threadId, outcome],
  );

  useEffect(() => load(false), [load]);
  usePromptSignal(
    ["quick-replies"],
    threadId === null ? null : { threadId, projectId: null },
    () => load(false),
    { debounceMs: 60 },
  );

  const current = read.threadId === threadId && outcome !== null ? read : AI_IDLE;
  return { ...current, refresh: useCallback(() => load(true), [load]) };
}

function settingText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Whether the Option or Alt key is down: every chip shows its shortcut then. */
function useAltHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => setHeld(event.altKey);
    const up = (event: KeyboardEvent) => setHeld(event.altKey);
    const blur = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return held;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();
const LONG_PRESS_MS = 420;

// ---------------------------------------------------------------------------
// The row.

export function QuickReplies() {
  const composer = useComposer();
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const threadId = useComposerThreadId();
  const settings = useSettings();
  const isLoading = settings.isLoading;
  const values: Record<string, unknown> = settings.values ?? {};
  const { threads } = experimental_useSidebarThreads();
  const thread = useMemo(
    () => (threadId === null ? null : threads.find((row) => row.id === threadId) ?? null),
    [threads, threadId],
  );
  const status = thread?.status ?? null;
  const projectId = thread?.projectId ?? null;

  const enabled = !isLoading && values.quickReplies !== false && threadId !== null;
  const aiOn = values.quickRepliesAi !== "off";
  const config = useMemo(
    () => ({
      afterStop: parseReplyLines(settingText(values.quickRepliesAfterStop, DEFAULT_AFTER_STOP)),
      afterDone: parseReplyLines(settingText(values.quickRepliesAfterDone, "")),
      anyTime: parseReplyLines(settingText(values.quickRepliesAnyTime, DEFAULT_ANY_TIME)),
    }),
    [values.quickRepliesAfterStop, values.quickRepliesAfterDone, values.quickRepliesAnyTime],
  );
  const fillOnly = values.quickReplyTap === "fill";

  const outcome = useTurnOutcome(enabled ? threadId : null, status);
  const state = quickReplyState({
    status,
    isRunning: composer.isRunning,
    hasPendingInteraction: thread?.hasPendingInteraction ?? false,
    outcome,
  });
  const pool = useQuickReplyPool(enabled, projectId);
  const ai = useAiReplies(enabled && aiOn ? threadId : null, state);

  // Dismissals hide a chip for this turn; the server remembers them for the
  // project, so the model stops offering them.
  const [dismissed, setDismissed] = useState<{ turnKey: string | null; keys: Set<string> }>({
    turnKey: null,
    keys: new Set(),
  });
  const dismissedKeys = dismissed.turnKey === ai.turnKey ? dismissed.keys : EMPTY_KEYS;

  // The model's picks wait while the pointer or focus is on the row, so a
  // chip never moves out from under a tap that is already on its way.
  const [interacting, setInteracting] = useState(false);
  const held = useRef<{ status: AiStatus; replies: AiReplyDto[] }>({ status: ai.status, replies: ai.replies });
  if (!interacting) held.current = { status: ai.status, replies: ai.replies };
  const shownAi = held.current;

  const draft = composer.text;
  const row = useMemo(
    () =>
      rowFor({
        state,
        config,
        learned: pool.learned,
        snippets: pool.snippets,
        ai: shownAi,
        draft,
        dismissed: dismissedKeys,
      }),
    [state, config, pool, shownAi, draft, dismissedKeys],
  );

  // What the card shows: the hovered, focused or long-pressed chip, else the
  // best one. A new set of chips starts over at the best one.
  // Focus belongs to one set of chips: a new set reads as unfocused at once,
  // with no effect in between that could undo a hover landing in that tick.
  const rowKey = `${row.mode}|${row.items.map((entry) => entry.text).join("\u0000")}`;
  const rowKeyRef = useRef(rowKey);
  rowKeyRef.current = rowKey;
  const [focusState, setFocusState] = useState<{ rowKey: string; index: number | null }>({
    rowKey,
    index: null,
  });
  const focus = focusState.rowKey === rowKey ? focusState.index : null;
  const setFocus = useCallback(
    (index: number | null) => setFocusState({ rowKey: rowKeyRef.current, index }),
    [],
  );
  const shown = focus !== null && focus < row.items.length ? focus : defaultFocus(row.items);
  const focused = row.items[shown] ?? null;

  const [busy, setBusy] = useState(false);
  const altHeld = useAltHeld();

  const feedback = useCallback(
    (text: string, action: "tap" | "dismiss") => {
      void rpc.call("quickReplyFeedback", { projectId, text, action }).catch(() => {});
    },
    [rpc, projectId],
  );

  const putInComposer = useCallback(
    (text: string, replaceDraft: boolean) => {
      if (replaceDraft || composer.isEmpty) composer.replace({ text, mentions: [] });
      else composer.insert(text, { at: "end", block: true });
      composer.focus();
    },
    [composer],
  );

  const run = useCallback(
    async (chip: RowItem) => {
      if (busy || threadId === null) return;
      const learns = chip.kind !== "retry" && chip.kind !== "any";
      if (chip.action === "complete" || chip.action === "fill") {
        putInComposer(chip.text, chip.action === "complete");
        if (learns) feedback(chip.text, "tap");
        return;
      }
      if (chip.action === "queue") {
        setBusy(true);
        try {
          const result = await rpc.call("addPrompt", {
            scope: "thread",
            threadId,
            projectId,
            text: chip.text,
            autoSend: true,
          });
          if (result.error) throw new Error(result.error);
          toast.success(`Queued: ${shortLabel(chip.label)}. It sends when this turn ends.`);
          if (learns) feedback(chip.text, "tap");
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not queue the quick reply");
        } finally {
          setBusy(false);
        }
        return;
      }
      // A draft is the user's writing in progress: join it, never send it.
      if (fillOnly || !composer.isEmpty) {
        putInComposer(chip.text, false);
        if (learns) feedback(chip.text, "tap");
        return;
      }
      setBusy(true);
      try {
        if (chip.action === "retry") {
          try {
            await sdk.threads.retry({ threadId, reason: "Quick reply" });
            return;
          } catch {
            // One live retry per failed turn: when one is already queued (a
            // retry plugin, an earlier tap), send the text instead.
          }
        }
        composer.replace({ text: chip.text, mentions: [] });
        await composer.submit();
        if (learns) feedback(chip.text, "tap");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not send the quick reply");
      } finally {
        setBusy(false);
      }
    },
    [busy, threadId, projectId, fillOnly, composer, putInComposer, feedback, rpc, sdk],
  );

  const edit = useCallback(
    (chip: RowItem) => {
      putInComposer(chip.text, false);
    },
    [putInComposer],
  );

  const dismiss = useCallback(
    (chip: RowItem) => {
      const key = replyKey(chip.text);
      setDismissed((current) => ({
        turnKey: ai.turnKey,
        keys: new Set([...(current.turnKey === ai.turnKey ? current.keys : []), key]),
      }));
      setFocus(null);
      if (chip.kind !== "retry") feedback(chip.text, "dismiss");
    },
    [ai.turnKey, feedback],
  );

  // The keyboard shortcuts reach this row's chips through the registry.
  const rowRef = useRef(row);
  rowRef.current = row;
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (threadId === null) return;
    const runner = (index: number) => {
      const chip = rowRef.current.items[index];
      if (chip && rowRef.current.mode !== "hidden") void runRef.current(chip);
    };
    runners.set(threadId, runner);
    return () => {
      if (runners.get(threadId) === runner) runners.delete(threadId);
    };
  }, [threadId]);

  // Long-press on touch: show what a chip sends without sending it.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef(false);
  const clearPress = () => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(() => clearPress, []);

  const toolbar = useRef<HTMLDivElement | null>(null);
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Escape") return;
    event.preventDefault();
    if (event.key === "Escape") {
      composer.focus();
      return;
    }
    const chips = Array.from(toolbar.current?.querySelectorAll<HTMLButtonElement>("[data-chip]") ?? []);
    const at = chips.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowRight" ? at + 1 : at - 1;
    chips[Math.max(0, Math.min(chips.length - 1, next))]?.focus();
  };

  if (!enabled || row.mode === "hidden" || row.items.length === 0) return null;

  const canRegenerate =
    aiOn && (state === "finished" || state === "interrupted") && ai.status !== "off" && ai.status !== "empty";
  const loading = ai.status === "pending";
  const touchHint = "max-md:pointer-coarse:h-10 max-md:pointer-coarse:px-3.5 max-md:pointer-coarse:text-sm";

  return (
    <div
      className="mb-2 flex flex-col gap-1.5"
      data-quick-replies={row.mode}
      onMouseEnter={() => setInteracting(true)}
      onMouseLeave={() => {
        setInteracting(false);
        setFocus(null);
      }}
      onFocus={() => setInteracting(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteracting(false);
      }}
    >
      {row.spotlight ? (
        <Spotlight
          chip={loading && row.mode === "loading" ? null : focused}
          index={shown}
          mode={row.mode}
          busy={busy || composer.isSubmitting}
          onRun={(chip) => void run(chip)}
          onEdit={edit}
          onDismiss={dismiss}
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5">
        <div
          ref={toolbar}
          role="toolbar"
          aria-label="Quick replies"
          onKeyDown={moveFocus}
          // Bleeds to the composer's edges on a phone so the row can scroll the
          // full width; the scrollbar is hidden, the faded edge says "more".
          className={cn(
            "-my-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto overscroll-x-contain py-1 pl-0.5 pr-6",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "[mask-image:linear-gradient(90deg,#000_calc(100%-24px),transparent)]",
          )}
        >
          {row.items.map((chip, index) => {
            const fills =
              (chip.action === "send" || chip.action === "retry") && (fillOnly || !composer.isEmpty);
            const retries = chip.action === "retry" && !fills;
            const verb =
              chip.action === "queue"
                ? "Queue"
                : chip.action === "complete" || chip.action === "fill" || fills
                  ? "Add to draft"
                  : retries
                    ? "Retry the failed turn"
                    : "Send";
            const icon: IconName | null = chip.action === "queue" ? "Clock" : KIND_ICON[chip.kind];
            const showHint = index < QUICK_REPLY_SHORTCUTS && (chip.best || altHeld);
            return (
              <button
                key={`${row.mode}:${chip.kind}:${chip.text}`}
                data-chip
                type="button"
                disabled={busy || composer.isSubmitting}
                onClick={() => {
                  if (pressed.current) {
                    pressed.current = false;
                    return;
                  }
                  void run(chip);
                }}
                onMouseEnter={() => setFocus(index)}
                onFocus={() => setFocus(index)}
                onPointerDown={(event) => {
                  if (event.pointerType !== "touch") return;
                  pressed.current = false;
                  clearPress();
                  pressTimer.current = setTimeout(() => {
                    pressed.current = true;
                    setFocus(index);
                  }, LONG_PRESS_MS);
                }}
                onPointerUp={clearPress}
                onPointerCancel={clearPress}
                onPointerLeave={clearPress}
                onContextMenu={(event) => {
                  if (pressed.current) event.preventDefault();
                }}
                title={chip.text}
                aria-label={`${verb}: ${chip.text}`}
                aria-keyshortcuts={index < QUICK_REPLY_SHORTCUTS ? shortcutFor(index).ariaKeyshortcuts : undefined}
                style={{ animationDelay: `${Math.min(index, 6) * 55}ms` }}
                className={cn(
                  "group flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs",
                  "transition-[background-color,color,box-shadow,opacity] duration-150",
                  "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  "disabled:pointer-events-none disabled:opacity-50",
                  "animate-in fade-in-0 slide-in-from-bottom-1 zoom-in-95 fill-mode-both duration-300 ease-out motion-reduce:animate-none",
                  touchHint,
                  chip.best
                    ? "bg-foreground text-background hover:bg-foreground/90"
                    : chip.primary
                      ? "border border-primary/40 text-primary hover:bg-primary/10"
                      : "border border-border text-foreground/85 hover:bg-state-hover hover:text-foreground",
                  index === shown && row.spotlight && row.mode !== "loading" && !chip.best
                    ? "bg-state-hover text-foreground"
                    : "",
                )}
              >
                {retries ? (
                  <Icon name="ArrowReloadHorizontal" className="size-3.5 shrink-0" aria-hidden />
                ) : icon ? (
                  <Icon
                    name={icon}
                    className={cn("size-3.5 shrink-0", chip.best ? "opacity-80" : "text-muted-foreground")}
                    aria-hidden
                  />
                ) : null}
                <span>{shortLabel(chip.label)}</span>
                {showHint ? <Keycap index={index} /> : null}
              </button>
            );
          })}
        </div>
        {canRegenerate ? (
          <button
            type="button"
            onClick={() => ai.refresh()}
            disabled={loading}
            title={ai.status === "error" && ai.error ? `Could not suggest: ${ai.error}. Try again` : "Suggest again"}
            aria-label={ai.status === "error" ? "Try suggesting again" : "Suggest again"}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground",
              "transition-colors duration-150 hover:bg-state-hover hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              "disabled:pointer-events-none max-md:pointer-coarse:size-10",
              ai.status === "error" ? "text-destructive" : "",
            )}
          >
            <Icon
              name="RotateCcw"
              className={cn("size-3.5", loading ? "animate-spin [animation-direction:reverse]" : "")}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card above the chips.

function Spotlight({
  chip,
  index,
  mode,
  busy,
  onRun,
  onEdit,
  onDismiss,
}: {
  chip: RowItem | null;
  index: number;
  mode: string;
  busy: boolean;
  onRun(chip: RowItem): void;
  onEdit(chip: RowItem): void;
  onDismiss(chip: RowItem): void;
}) {
  if (chip === null)
    return (
      <div
        role="status"
        className="flex h-[60px] items-center gap-2 rounded-xl bg-muted/50 px-3.5 text-[13px] text-muted-foreground animate-in fade-in-0 duration-200 max-md:pointer-coarse:h-[92px] max-md:pointer-coarse:text-sm"
      >
        <Icon name="Sparkles" className="size-3.5 shrink-0" aria-hidden />
        <span className="animate-pulse">Reading the last reply</span>
      </div>
    );

  const icon = KIND_ICON[chip.kind];
  const eyebrow =
    mode === "filter" && chip.best
      ? "Completes your draft"
      : chip.best
        ? "Best next step"
        : KIND_NAME[chip.kind];
  const verb =
    chip.action === "complete" || chip.action === "fill" ? "Use" : chip.action === "queue" ? "Queue" : "Send";
  return (
    <div className="rounded-xl bg-muted/50" aria-live="polite">
      <div
        key={`${index}:${chip.text}`}
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 pl-3.5 pr-2.5",
          "animate-in fade-in-0 duration-200 motion-reduce:animate-none",
          "max-md:pointer-coarse:grid-cols-1 max-md:pointer-coarse:gap-2.5 max-md:pointer-coarse:p-3.5",
        )}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground max-md:pointer-coarse:flex-wrap max-md:pointer-coarse:gap-y-0.5 max-md:pointer-coarse:text-[13px]">
            {icon ? <Icon name={icon} className="size-3.5 shrink-0" aria-hidden /> : null}
            <span className="shrink-0 font-medium text-foreground">{eyebrow}</span>
            {chip.why ? (
              <>
                <span aria-hidden className="max-md:pointer-coarse:hidden">·</span>
                {/* On a phone the why gets its own line instead of an ellipsis. */}
                <span className="truncate max-md:pointer-coarse:basis-full max-md:pointer-coarse:whitespace-normal">
                  {chip.why}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-foreground max-md:pointer-coarse:line-clamp-3 max-md:pointer-coarse:text-[15px]">
            {chip.text}
          </p>
        </div>
        <div className="flex items-center gap-1 max-md:pointer-coarse:grid max-md:pointer-coarse:grid-cols-[auto_auto_1fr] max-md:pointer-coarse:gap-2">
          {chip.kind !== "retry" ? (
            <button
              type="button"
              onClick={() => onDismiss(chip)}
              aria-label={`Dismiss: ${chip.label}`}
              title="Dismiss. Quick replies learn from it"
              className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:pointer-coarse:size-10"
            >
              <Icon name="X" className="size-3.5" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onEdit(chip)}
            title="Put it in the composer to change it first"
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:pointer-coarse:h-10 max-md:pointer-coarse:px-3 max-md:pointer-coarse:text-sm"
          >
            <Icon name="Edit" className="size-3.5" aria-hidden />
            Edit
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRun(chip)}
            className="flex h-7 items-center justify-center gap-2 rounded-lg bg-foreground px-2.5 text-xs font-medium text-background transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 max-md:pointer-coarse:h-10 max-md:pointer-coarse:text-sm"
          >
            {verb}
            {index < QUICK_REPLY_SHORTCUTS ? <Keycap index={index} /> : null}
          </button>
        </div>
      </div>
    </div>
  );
}
