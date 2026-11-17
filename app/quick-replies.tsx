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
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type { ReplyTopic } from "../lib/reply-topics";
import {
  DEFAULT_AFTER_STOP,
  DEFAULT_ANY_TIME,
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
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon, type IconName } from "@/components/ui/icon";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
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

/** A chip's icon says what it asks for; the card's eyebrow says where it came from. */
const TOPIC_ICON: Record<ReplyTopic, IconName> = {
  continue: "Play",
  status: "Activity",
  done: "CircleCheck",
  yes: "Check",
  no: "X",
  ask: "MessageQuestion",
  explain: "Idea",
  test: "Beaker",
  fix: "Bug",
  run: "Terminal",
  commit: "GitCommit",
  pr: "GitPullRequest",
  branch: "GitBranch",
  review: "Eye",
  search: "Search",
  release: "Rocket",
  docs: "FileText",
  visual: "Image",
  plan: "ListTodo",
  refactor: "Code",
  undo: "Undo",
  error: "AlertTriangle",
  delete: "Trash2",
  summary: "AlignLeft",
  wait: "Pause",
  speed: "Zap",
  install: "Download",
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
const AI_OFF: AiState = { ...AI_IDLE, status: "off" };

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

  // A new turn starts: the last read answered the turn before it, and must
  // not come back when this one ends, before its own read lands.
  useEffect(() => {
    if (outcome === null) {
      latest.current += 1;
      setRead(AI_IDLE);
    }
  }, [outcome]);
  useEffect(() => load(false), [load]);
  usePromptSignal(
    ["quick-replies"],
    threadId === null ? null : { threadId, projectId: null },
    () => load(false),
    { debounceMs: 60 },
  );

  const current = read.threadId === threadId && outcome !== null ? read : AI_IDLE;
  // Asking again clears the old picks at once: the row shows the loading
  // line until the new ones land together.
  const refresh = useCallback(() => {
    setRead((last) => ({ ...last, status: "pending", replies: [], error: null }));
    load(true);
  }, [load]);
  return { ...current, refresh };
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

/** Focus that came from the keyboard: the browser shows its ring. */
function isKeyboardFocus(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    // A browser without :focus-visible: treat focus as keyboard focus.
    return true;
  }
}
const LONG_PRESS_MS = 420;

/**
 * The loading line's motion: a highlight that sweeps the words and a sparkle
 * that breathes. Named for this plugin so nothing else in bb picks them up;
 * still under reduced motion.
 */
const ROW_MOTION_CSS = `
@keyframes bb-prompts-qr-shimmer { from { background-position: 150% 0 } to { background-position: -50% 0 } }
@keyframes bb-prompts-qr-breathe { 0%, 100% { opacity: .45; transform: scale(.9) } 50% { opacity: 1; transform: scale(1) } }
.bb-prompts-qr-shimmer {
  color: transparent;
  background: linear-gradient(90deg, var(--muted-foreground) 40%, var(--foreground) 50%, var(--muted-foreground) 60%) 0 0 / 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  animation: bb-prompts-qr-shimmer 2.2s cubic-bezier(.4, 0, .2, 1) infinite;
}
.bb-prompts-qr-breathe { animation: bb-prompts-qr-breathe 2.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .bb-prompts-qr-shimmer { animation: none; background: none; color: var(--muted-foreground); }
  .bb-prompts-qr-breathe { animation: none; }
}`;
/** A hover this long opens a chip's details; moving between chips is instant. */
const HOVER_OPEN_MS = 350;
/** Grace to move the pointer from a chip into its details. */
const HOVER_CLOSE_MS = 160;

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

  // With suggestions off, the row is the user's own chips, never "loading".
  const aiForRow = aiOn ? ai : AI_OFF;

  const draft = composer.text;
  const row = useMemo(
    () =>
      rowFor({
        state,
        config,
        learned: pool.learned,
        snippets: pool.snippets,
        ai: aiForRow,
        draft,
        dismissed: dismissedKeys,
      }),
    [state, config, pool, aiForRow, draft, dismissedKeys],
  );

  // The chip whose details are open: after a short hover, on keyboard focus,
  // or on a long press. It belongs to one set of chips: a new set starts
  // closed, with no effect in between that could undo a hover in that tick.
  const rowKey = `${row.mode}|${row.items.map((entry) => entry.text).join("\u0000")}`;
  const rowKeyRef = useRef(rowKey);
  rowKeyRef.current = rowKey;
  const [previewState, setPreviewState] = useState<{ rowKey: string; index: number | null }>({
    rowKey,
    index: null,
  });
  const preview = previewState.rowKey === rowKey ? previewState.index : null;
  const setPreview = useCallback(
    (index: number | null) => setPreviewState({ rowKey: rowKeyRef.current, index }),
    [],
  );
  const previewChip = preview !== null ? (row.items[preview] ?? null) : null;
  const compact = useIsCompactViewport();
  const whyId = useId();
  const chipEls = useRef<(HTMLButtonElement | null)[]>([]);
  const anchor = useRef<{ getBoundingClientRect(): DOMRect } | null>(null);
  const previewVia = useRef<"hover" | "focus" | "press">("hover");
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPreviewTimers = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => clearPreviewTimers, []);
  const showPreview = useCallback(
    (index: number, via: "hover" | "focus" | "press", delay: number) => {
      clearPreviewTimers();
      const open = () => {
        const el = chipEls.current[index];
        if (el) anchor.current = { getBoundingClientRect: () => el.getBoundingClientRect() };
        previewVia.current = via;
        setPreview(index);
      };
      if (delay <= 0) open();
      else
        openTimer.current = setTimeout(() => {
          openTimer.current = null;
          open();
        }, delay);
    },
    [setPreview],
  );
  const hidePreview = useCallback(
    (delay: number) => {
      clearPreviewTimers();
      if (delay <= 0) {
        setPreview(null);
        return;
      }
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        setPreview(null);
      }, delay);
    },
    [setPreview],
  );
  const keepPreview = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

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
      // A card about to open over the row stays closed: the chip is used.
      hidePreview(0);
      const learns = chip.kind !== "retry" && chip.kind !== "any";
      if (chip.action === "complete" || chip.action === "fill") {
        putInComposer(chip.text, chip.action === "complete");
        if (learns) feedback(chip.text, "tap");
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
    [busy, threadId, projectId, fillOnly, composer, putInComposer, feedback, rpc, sdk, hidePreview],
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
      setPreview(null);
      if (chip.kind !== "retry") feedback(chip.text, "dismiss");
    },
    [ai.turnKey, feedback, setPreview],
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
  // The element in the row a keyboard user is on. When the chips change and
  // take it away (the picks landed, a Dismiss), focus moves to the row's
  // first chip, or the composer, instead of falling to the page. Nothing
  // moves for a mouse user, or once focus has gone anywhere else.
  const keyboardFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const lost = keyboardFocus.current;
    if (lost === null || lost.isConnected) return;
    keyboardFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const first = toolbar.current?.querySelector<HTMLButtonElement>("[data-chip]");
    if (first) first.focus();
    else composer.focus();
  });
  const backToComposer = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // The first Escape closes a chip's details (the popover takes it), the
    // next goes back to the composer.
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    composer.focus();
  };
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const chips = Array.from(toolbar.current?.querySelectorAll<HTMLButtonElement>("[data-chip]") ?? []);
    const at = chips.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowRight" ? at + 1 : at - 1;
    chips[Math.max(0, Math.min(chips.length - 1, next))]?.focus();
  };

  const loading = row.mode === "loading";
  if (!enabled || row.mode === "hidden" || (row.items.length === 0 && !loading)) return null;

  const canRegenerate =
    aiOn && (state === "finished" || state === "interrupted") && ai.status !== "off" && ai.status !== "empty";
  const touchHint = "max-md:pointer-coarse:h-10 max-md:pointer-coarse:px-3.5 max-md:pointer-coarse:text-sm";

  return (
    <div
      // First in the composer's banner stack, above every other plugin's:
      // bb lays the banners out as one grid and wraps each in a
      // display:contents element, so this root is the grid item `order` moves.
      className="order-first mb-2 flex flex-col gap-1.5"
      data-quick-replies={row.mode}
      onKeyDown={backToComposer}
      onFocus={(event) => {
        keyboardFocus.current = isKeyboardFocus(event.target) ? event.target : null;
      }}
      onBlur={(event) => {
        // Focus left for something else, a focusable element or the page
        // itself (a click on text). An element the chips took away is no
        // longer connected by the time this runs, and keeps its claim.
        const left = event.target;
        queueMicrotask(() => {
          if (keyboardFocus.current === left && left.isConnected) keyboardFocus.current = null;
        });
      }}
      onMouseLeave={() => {
        if (previewVia.current === "hover") hidePreview(HOVER_CLOSE_MS);
      }}
    >
      <style>{ROW_MOTION_CSS}</style>
      <div className="flex min-w-0 items-center gap-1.5">
        {loading ? (
          // Holds the row while the model reads the turn: nothing older shows
          // first, and the picks take this place together when they land.
          // The line shows only once the model is at work; picks already
          // saved for this turn land in its place without it flashing first.
          ai.status === "pending" ? (
            <div
              role="status"
              className="flex h-7 min-w-0 flex-1 items-center gap-1.5 pl-1 text-xs animate-in fade-in-0 fill-mode-both duration-500 motion-reduce:animate-none"
              style={{ animationDelay: "150ms" }}
            >
              <Icon name="Sparkles" className="bb-prompts-qr-breathe size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="bb-prompts-qr-shimmer truncate">Suggesting replies</span>
            </div>
          ) : (
            <div className="h-7 min-w-0 flex-1" aria-hidden />
          )
        ) : (
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
              chip.action === "complete" || chip.action === "fill" || fills
                ? "Add to draft"
                : retries
                  ? "Retry the failed turn"
                  : "Send";
            const icon: IconName | null = chip.topic ? TOPIC_ICON[chip.topic] : KIND_ICON[chip.kind];
            const showHint = index < QUICK_REPLY_SHORTCUTS && (chip.best || altHeld);
            return (
              <button
                key={`${chip.kind}:${chip.text}`}
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
                ref={(el) => {
                  chipEls.current[index] = el;
                }}
                // A mouse only: a tap on a touch screen enters a chip too.
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse" && !compact)
                    showPreview(index, "hover", preview === null ? HOVER_OPEN_MS : 0);
                }}
                onPointerLeave={(event) => {
                  clearPress();
                  if (event.pointerType === "mouse" && !compact && previewVia.current === "hover")
                    hidePreview(HOVER_CLOSE_MS);
                }}
                onFocus={(event) => {
                  // On a phone the details are a sheet over the page: not for every chip tabbed past.
                  if (!compact && isKeyboardFocus(event.currentTarget)) showPreview(index, "focus", 0);
                }}
                onBlur={(event) => {
                  const next = event.relatedTarget as Element | null;
                  if (previewVia.current !== "focus") return;
                  if (next?.closest("[data-chip], [data-quick-reply-details]")) return;
                  hidePreview(0);
                }}
                onKeyDown={(event) => {
                  // E edits the focused chip, Delete or Backspace dismisses it.
                  if (event.key === "e" || event.key === "E") {
                    event.preventDefault();
                    hidePreview(0);
                    edit(chip);
                  } else if ((event.key === "Delete" || event.key === "Backspace") && chip.kind !== "retry") {
                    event.preventDefault();
                    dismiss(chip);
                  }
                }}
                onPointerDown={(event) => {
                  // A press is not a hover: details about to open stay closed.
                  if (openTimer.current !== null) clearPreviewTimers();
                  if (event.pointerType !== "touch") return;
                  pressed.current = false;
                  clearPress();
                  pressTimer.current = setTimeout(() => {
                    pressed.current = true;
                    showPreview(index, "press", 0);
                  }, LONG_PRESS_MS);
                }}
                onPointerUp={clearPress}
                onPointerCancel={clearPress}
                onContextMenu={(event) => {
                  if (pressed.current) event.preventDefault();
                }}
                aria-label={`${verb}: ${chip.text}`}
                aria-describedby={chip.why ? `${whyId}-${index}` : undefined}
                // A narrow window has no hover card: the full message as a tooltip.
                title={compact ? chip.text : undefined}
                aria-expanded={index === preview}
                aria-keyshortcuts={index < QUICK_REPLY_SHORTCUTS ? shortcutFor(index).ariaKeyshortcuts : undefined}
                // The picks arrive one after another: a short rise out of a soft blur.
                style={{ animationDelay: `${Math.min(index, 6) * 70}ms` }}
                className={cn(
                  "group flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs",
                  "transition-[background-color,color,box-shadow,opacity] duration-150",
                  "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  "disabled:pointer-events-none disabled:opacity-50",
                  "animate-in fade-in-0 slide-in-from-bottom-2 zoom-in-95 fill-mode-both duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] [--tw-enter-blur:6px] motion-reduce:animate-none",
                  touchHint,
                  chip.best
                    ? "bg-foreground text-background hover:bg-foreground/90"
                    : chip.primary
                      ? "border border-primary/40 text-primary hover:bg-primary/10"
                      : "border border-border text-foreground/85 hover:bg-state-hover hover:text-foreground",
                  index === preview && !chip.best ? "bg-state-hover text-foreground" : "",
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
        )}
        <div hidden>
          {row.items.map((chip, index) =>
            chip.why ? (
              <span key={`${chip.kind}:${chip.text}`} id={`${whyId}-${index}`}>
                {chip.why}
              </span>
            ) : null,
          )}
        </div>
        {canRegenerate ? (
          <button
            type="button"
            onClick={() => {
              if (!loading) ai.refresh();
            }}
            // Not `disabled`: a disabled button drops keyboard focus to the page.
            aria-disabled={loading}
            title={ai.status === "error" && ai.error ? `Could not suggest: ${ai.error}. Try again` : "Suggest again"}
            aria-label={ai.status === "error" ? "Try suggesting again" : "Suggest again"}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground",
              "transition-colors duration-150 hover:bg-state-hover hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              "aria-disabled:cursor-default aria-disabled:opacity-40 max-md:pointer-coarse:size-10",
              ai.status === "error" ? "text-destructive" : "",
            )}
          >
            <Icon
              name="RotateCcw"
              className="size-3.5"
              aria-hidden
            />
          </button>
        ) : null}
      </div>
      <Popover
        open={previewChip !== null}
        onOpenChange={(open) => {
          if (!open) hidePreview(0);
        }}
      >
        <PopoverAnchor virtualRef={anchor} />
        {previewChip !== null && preview !== null ? (
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={8}
            // The desktop card's size; the phone sheet keeps bb's own.
            className={compact ? undefined : "w-80 p-3"}
            mobileTitle={previewChip.label}
            // Details, not a dialog: focus stays where it was.
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            // Focus stays on the chip that opened the details, which is
            // outside them; the chip's own blur closes them when focus leaves.
            onFocusOutside={(event) => event.preventDefault()}
            onMouseEnter={keepPreview}
            onMouseLeave={() => {
              if (previewVia.current === "hover") hidePreview(HOVER_CLOSE_MS);
            }}
          >
            <ChipDetails
              chip={previewChip}
              index={preview}
              mode={row.mode}
              compact={compact}
              busy={busy || composer.isSubmitting}
              fills={fillOnly || !composer.isEmpty}
              onRun={(chip) => {
                hidePreview(0);
                void run(chip);
              }}
              onEdit={(chip) => {
                hidePreview(0);
                edit(chip);
              }}
              onDismiss={dismiss}
            />
          </PopoverContent>
        ) : null}
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A chip's details: what it sends, why, and what to do with it.

function ChipDetails({
  chip,
  index,
  mode,
  compact,
  busy,
  fills,
  onRun,
  onEdit,
  onDismiss,
}: {
  chip: RowItem;
  index: number;
  mode: string;
  compact: boolean;
  busy: boolean;
  /** A tap adds to the draft instead of sending (a draft, or the fill setting). */
  fills: boolean;
  onRun(chip: RowItem): void;
  onEdit(chip: RowItem): void;
  onDismiss(chip: RowItem): void;
}) {
  // The chip shows what it asks for; the card adds where it came from.
  const icon = KIND_ICON[chip.kind];
  const eyebrow =
    mode === "filter" && chip.best ? "Completes your draft" : chip.best ? "Best next step" : KIND_NAME[chip.kind];
  const verb =
    chip.action === "complete" || chip.action === "fill"
      ? "Use"
      : chip.action === "retry" && !fills
        ? "Retry"
        : fills
          ? "Add to draft"
          : "Send";
  const canDismiss = chip.kind !== "retry";
  const button =
    "flex items-center justify-center gap-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";
  return (
    <div data-quick-reply-details className="flex flex-col">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon ? <Icon name={icon} className="size-3.5 shrink-0" aria-hidden /> : null}
        <span className="font-medium text-foreground">{eyebrow}</span>
      </div>
      {compact ? <p className="mt-1.5 text-lg font-semibold leading-snug text-foreground">{chip.label}</p> : null}
      <p className={cn("mt-1.5 leading-snug text-foreground", compact ? "text-[15px]" : "text-[13px]")}>
        {chip.text}
      </p>
      {chip.why ? (
        <p className={cn("mt-1.5 leading-snug text-muted-foreground", compact ? "text-[13px]" : "text-xs")}>
          {chip.why}
        </p>
      ) : null}
      {compact ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onRun(chip)}
            className={cn(button, "col-span-2 h-11 rounded-full bg-foreground text-[15px] font-medium text-background")}
          >
            {verb}
          </button>
          <button
            type="button"
            onClick={() => onEdit(chip)}
            className={cn(button, "h-11 rounded-full bg-muted text-[15px] text-foreground", canDismiss ? "" : "col-span-2")}
          >
            <Icon name="Edit" className="size-4" aria-hidden />
            Edit
          </button>
          {canDismiss ? (
            <button
              type="button"
              onClick={() => onDismiss(chip)}
              className={cn(button, "h-11 rounded-full bg-muted text-[15px] text-foreground")}
            >
              <Icon name="X" className="size-4" aria-hidden />
              Dismiss
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-1 border-t border-border pt-2">
          {canDismiss ? (
            <button
              type="button"
              onClick={() => onDismiss(chip)}
              aria-label={`Dismiss: ${chip.label}`}
              title="Dismiss. Quick replies learn from it"
              className={cn(button, "size-7 rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground")}
            >
              <Icon name="X" className="size-3.5" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onEdit(chip)}
            title="Put it in the composer to change it first"
            className={cn(button, "h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground")}
          >
            <Icon name="Edit" className="size-3.5" aria-hidden />
            Edit
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRun(chip)}
            className={cn(button, "ml-auto h-7 gap-2 rounded-md bg-foreground px-2.5 text-xs font-medium text-background hover:opacity-90")}
          >
            {verb}
            {index < QUICK_REPLY_SHORTCUTS ? <Keycap index={index} /> : null}
          </button>
        </div>
      )}
    </div>
  );
}
