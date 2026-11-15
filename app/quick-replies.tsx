// Quick replies: a row of one-tap prompts above a thread's composer.
//
// The row follows the thread: after a failed or interrupted turn it leads with
// Continue, after a finished turn it offers the follow-ups the user types
// most, and the any-time chips (Status) stay at the end in every state. It
// hides while the agent waits on an answer, because the answer form owns the
// composer then.
//
// Nothing sends without a tap. A tap sends at once (or fills the composer, by
// setting); with a draft already in the composer the chip joins the draft
// instead, so a half-written prompt is never sent by accident.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads,
  useComposer,
  useRpc,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../lib/contract";
import {
  chipsFor,
  DEFAULT_AFTER_STOP,
  DEFAULT_ANY_TIME,
  parseReplyLines,
  quickReplyState,
  shortLabel,
  turnOutcomeFromEvents,
  type Chip,
  type QuickReply,
  type TurnOutcome,
} from "../lib/quick-replies";
import { useComposerThreadId, usePromptSignal } from "./shared";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Event types that say how the latest turn ended. */
const TURN_EVENT_TYPES = [
  "turn/started",
  "turn/completed",
  "system/thread/interrupted",
] as const;

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

/** The learned follow-ups, refreshed when a history scan finishes. */
function useLearnedReplies(enabled: boolean): QuickReply[] {
  const rpc = useRpc<typeof rpcContract>();
  const [learned, setLearned] = useState<QuickReply[]>([]);

  const load = useCallback(() => {
    if (!enabled) return;
    void rpc
      .call("quickReplies", null)
      .then((result) => setLearned(result.learned))
      .catch(() => {
        // Fallback chips cover a failed read.
      });
  }, [rpc, enabled]);

  useEffect(load, [load]);
  usePromptSignal(["suggestions"], null, load);
  return learned;
}

function settingText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function QuickReplies() {
  const composer = useComposer();
  const sdk = useSdk();
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

  const enabled = !isLoading && values.quickReplies !== false && threadId !== null;
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
  const learned = useLearnedReplies(enabled && config.afterDone.length === 0);
  const state = quickReplyState({
    status,
    isRunning: composer.isRunning,
    hasPendingInteraction: thread?.hasPendingInteraction ?? false,
    outcome,
  });
  const chips = useMemo(() => chipsFor(state, config, learned), [state, config, learned]);

  const [busy, setBusy] = useState(false);

  const fill = useCallback(
    (text: string) => {
      composer.insert(text, { at: "end", block: true });
      composer.focus();
    },
    [composer],
  );

  const send = useCallback(
    async (text: string) => {
      composer.replace({ text, mentions: [] });
      await composer.submit();
    },
    [composer],
  );

  const run = useCallback(
    async (chip: Chip) => {
      if (busy || threadId === null) return;
      // A draft is the user's writing in progress: join it, never send it.
      if (fillOnly || !composer.isEmpty) {
        fill(chip.text);
        return;
      }
      setBusy(true);
      try {
        if (chip.retry) {
          try {
            await sdk.threads.retry({ threadId, reason: "Quick reply" });
            return;
          } catch {
            // One live retry per failed turn: when one is already queued (a
            // retry plugin, an earlier tap), send the text instead.
          }
        }
        await send(chip.text);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not send the quick reply");
      } finally {
        setBusy(false);
      }
    },
    [busy, threadId, fillOnly, composer, fill, send, sdk],
  );

  if (!enabled || chips.length === 0) return null;

  return (
    <div
      role="toolbar"
      aria-label="Quick replies"
      data-quick-replies={state}
      // Bleeds to the composer's edges on a phone so the row can scroll the
      // full width; the scrollbar is hidden, the cut-off chip says "more".
      className="mb-1.5 flex gap-1.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {chips.map((chip) => {
        const fills = fillOnly || !composer.isEmpty;
        // A tap that fills the composer does not retry, so it must not say so.
        const retries = chip.retry && !fills;
        return (
        <button
          key={`${chip.retry ? "retry:" : ""}${chip.text}`}
          type="button"
          disabled={busy || composer.isSubmitting}
          onClick={() => void run(chip)}
          title={retries ? "Retry the failed turn" : chip.text}
          aria-label={
            retries
              ? `${chip.label}: retry the failed turn`
              : fills
                ? `Add to draft: ${chip.text}`
                : `Send: ${chip.text}`
          }
          className={cn(
            "flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-xs transition-colors",
            "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "disabled:pointer-events-none disabled:opacity-50",
            "max-md:pointer-coarse:h-10 max-md:pointer-coarse:px-3.5 max-md:pointer-coarse:text-sm",
            chip.primary
              ? "border-primary/40 text-primary hover:bg-primary/10"
              : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
          )}
        >
          {retries ? (
            <Icon
              name="ArrowReloadHorizontal"
              className="size-3.5 shrink-0 max-md:pointer-coarse:size-4"
              aria-hidden
            />
          ) : null}
          {shortLabel(chip.label)}
        </button>
        );
      })}
    </div>
  );
}
