// Composer surfaces: the two pills, and the banner that appears while armed
// prompts are waiting on a running agent.
import {
  forwardRef,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { useBbNavigate, useComposer, useComposerView } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { describeQueue, type PillTone } from "./queue-state";
import { QueueView } from "./queue-view";
import {
  previewText,
  useComposerProjectId,
  useComposerThreadId,
  useQueue,
  usePromptSignal,
} from "./shared";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { cn } from "@/lib/utils";

/**
 * The composer trigger both buttons use. One shape, one size, one hover — two
 * buttons sitting side by side in the composer row have to read as a pair, not
 * as two plugins that happened to land next to each other.
 */
/**
 * Surface per tone. `muted` is the resting state and stays as quiet as any
 * other composer control; the rest tint the whole pill so the queue's state is
 * readable from across the row, without the pill ever leaving its 28px box.
 */
const PILL_TONE: Record<PillTone, { pill: string; chip: string }> = {
  muted: {
    pill: "border-input text-muted-foreground hover:text-foreground",
    chip: "bg-muted text-muted-foreground",
  },
  neutral: {
    pill: "border-input text-foreground",
    chip: "bg-muted text-foreground",
  },
  accent: {
    pill: "border-primary/35 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
    chip: "bg-primary/20 text-primary",
  },
  danger: {
    pill:
      "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
    chip: "bg-destructive/20 text-destructive",
  },
};

export const ComposerPill = forwardRef<
  HTMLButtonElement,
  {
    icon: Parameters<typeof Icon>[0]["name"];
    label: string;
    open: boolean;
    /** 0 hides the badge and keeps the pill square. */
    count?: number;
    tone?: PillTone;
    /** Slow pulse on the glyph: something is going to fire on its own. */
    pulse?: boolean;
    /** Held state: same colours, but the outline reads as "not running". */
    dashed?: boolean;
  } & ComponentPropsWithoutRef<"button">
>(function ComposerPill(
  {
    icon,
    label,
    open,
    count = 0,
    tone = "muted",
    pulse = false,
    dashed = false,
    className,
    ...props
  },
  ref,
) {
  const styles = PILL_TONE[tone];
  return (
    <button
      ref={ref}
      type="button"
      // Self-contained pill: the count lives INSIDE the 28px-tall bounds, so
      // the composer row's clamping can never clip it.
      //
      // 28px is a mouse target. On a touch composer it is the smallest control
      // in the row — bb's own prompt-actions button is 40px tall there — and an
      // icon-only pill would be a 28x28 tap target, under both the iOS (44pt)
      // and Android (48dp) minimums. Grow to 40px on a coarse pointer, matching
      // the host's own controls; the fine-pointer size is untouched.
      className={cn(
        "flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:pointer-coarse:h-10",
        count > 0
          ? "pl-1.5 pr-1 max-md:pointer-coarse:pl-2.5 max-md:pointer-coarse:pr-2"
          : "w-7 max-md:pointer-coarse:w-10",
        styles.pill,
        dashed && "border-dashed",
        tone === "muted" || tone === "neutral" ? "hover:bg-state-hover" : null,
        open && "bg-state-hover",
        className,
      )}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon
        name={icon}
        className={cn(
          COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
          pulse && "animate-pulse",
        )}
        aria-hidden
      />
      {count > 0 ? (
        <span
          className={cn(
            "flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-medium leading-none tabular-nums",
            styles.chip,
          )}
          style={{ fontSize: 10 }}
          aria-hidden
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
});

/** Append text to the composer draft; false when the composer refused it. */
function useInsertText(close: () => void) {
  const composer = useComposer();
  return useCallback(
    (text: string): boolean => {
      try {
        composer.updateText((current) =>
          current.trim() ? `${current.trimEnd()}\n\n${text}` : text,
        );
        composer.focus();
      } catch {
        return false;
      }
      close();
      return true;
    },
    [composer, close],
  );
}

export function QueueButton() {
  const navigate = useBbNavigate();
  const view = useComposerView();
  const threadId = useComposerThreadId();
  const projectId = useComposerProjectId();
  const [open, setOpen] = useState(false);
  const { data } = useQueue({ threadId, projectId });
  const insertText = useInsertText(useCallback(() => setOpen(false), []));

  // Surface auto-send failures as toasts wherever a composer is mounted.
  const toasted = useRef<string | null>(null);
  usePromptSignal(
    ["queue"],
    { threadId, projectId },
    (signal) => {
      if (signal.kind === "promoted" && signal.message) {
        toast(signal.message, { description: "Find them under Project." });
        return;
      }
      if (signal.kind !== "send-failed") return;
      const key = `${signal.threadId}:${signal.message}`;
      if (toasted.current === key) return;
      toasted.current = key;
      toast.error(
        signal.message ?? "Auto-send failed — the prompt stayed queued",
      );
    },
    { debounceMs: 0 },
  );

  // Everything the pill needs to say, in one ordered description.
  const state = describeQueue(data, { isRunning: view.run.isRunning });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ComposerPill
          icon={state.icon}
          count={state.pending}
          label={state.label}
          open={open}
          tone={state.tone}
          pulse={state.pulse}
          dashed={state.kind === "paused"}
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 overflow-hidden p-0 duration-200"
        // Grow from the corner nearest the button instead of zooming from the
        // center — Radix points this var at the anchor.
        style={{
          transformOrigin: "var(--radix-popover-content-transform-origin)",
        }}
        mobileRepositionInputs
      >
        <QueueView
          threadId={threadId}
          projectId={projectId}
          onInsertText={insertText}
          fixedHeight
          surface="queue"
          onOpenManager={() => {
            setOpen(false);
            navigate.toPluginPanel("manager");
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The snippet library, as its own composer button.
 *
 * Split out from the queue button because the two are different verbs: the
 * queue is "what happens next in this thread", the library is "text I keep".
 * One popover with a tab strip made every insert cost a tab hop first.
 */
export function SnippetsButton() {
  const navigate = useBbNavigate();
  const threadId = useComposerThreadId();
  const projectId = useComposerProjectId();
  const [open, setOpen] = useState(false);
  const insertText = useInsertText(useCallback(() => setOpen(false), []));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ComposerPill
          icon="Explore"
          label="Snippets — reusable prompts"
          open={open}
          tone="muted"
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 overflow-hidden p-0 duration-200"
        style={{
          transformOrigin: "var(--radix-popover-content-transform-origin)",
        }}
        mobileRepositionInputs
      >
        <QueueView
          threadId={threadId}
          projectId={projectId}
          onInsertText={insertText}
          fixedHeight
          surface="snippets"
          onOpenManager={() => {
            setOpen(false);
            navigate.toPluginPanel("manager", { subPath: "snippets" });
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function ArmedBanner() {
  const view = useComposerView();
  const threadId = useComposerThreadId();
  const projectId = useComposerProjectId();
  const { data, refresh, rpc } = useQueue({ threadId, projectId }, threadId !== null);

  const armed = useMemo(
    () => data.threadPrompts.filter((prompt) => prompt.autoSend),
    [data.threadPrompts],
  );
  // Paused is worth showing even when the thread is not running: that is
  // exactly the state a failed thread leaves behind, and it is the only
  // on-screen explanation for why nothing is sending.
  if (threadId === null || armed.length === 0) return null;
  if (!view.run.isRunning && !data.paused) return null;

  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
      <Icon
        name={data.paused ? "Pause" : "TimeSchedule"}
        className="size-3.5 shrink-0 text-primary"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">
        {data.paused
          ? `${armed.length} armed prompt${armed.length === 1 ? "" : "s"} on hold`
          : armed.length === 1
            ? `“${previewText(armed[0]!.text).slice(0, 80)}” will auto-send when the agent finishes`
            : `${armed.length} queued prompts will auto-send when the agent finishes`}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 shrink-0 px-1.5 text-xs"
        onClick={() =>
          void rpc
            .call("setPaused", { threadId, paused: !data.paused })
            .then(refresh)
        }
      >
        {data.paused ? "Resume" : "Pause"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 shrink-0 px-1.5 text-xs"
        onClick={() =>
          void rpc.call("disarmThread", { threadId }).then(() => {
            refresh();
            toast("Auto-send disarmed — prompts stay queued");
          })
        }
      >
        Disarm
      </Button>
    </div>
  );
}
