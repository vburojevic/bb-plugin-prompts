// One prompt row and one snippet row, for every surface.
//
// The composer popover and the manager used to hold their own near-copies of
// both, which is how they drifted: an action added to one silently did not
// exist in the other.
import { useState } from "react";
import { parseTokens } from "../lib/template";
import {
  formatWhen,
  previewText,
  usedViaLabel,
  type NativeQueueItem,
  type PromptDto,
  type Scope,
  type SnippetDto,
} from "./shared";
import { threadTarget, type QueueTarget } from "./queue-target";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface PromptRowActions {
  /** null on surfaces with no composer to insert into. */
  onInject: ((prompt: PromptDto) => void) | null;
  onSendNow: ((prompt: PromptDto) => void) | null;
  onPush: ((prompt: PromptDto) => void) | null;
  onEdit: (prompt: PromptDto) => void;
  onSchedule: (prompt: PromptDto) => void;
  onSaveAsSnippet: (prompt: PromptDto) => void;
  onToggleArm: (prompt: PromptDto) => void;
  onMove: (index: number, direction: "up" | "down") => void;
  onChangeScope: (prompt: PromptDto, scope: Scope) => void;
  onSendToThread: (prompt: PromptDto, threadId: string) => void;
  onDelete: (prompt: PromptDto) => void;
  loadTargets: () => Promise<{
    threads: { id: string; title: string }[];
    total: number;
  }>;
}

export interface ScopeAvailability {
  threadId: string | null;
  projectId: string | null;
}

function PromptMeta({ prompt }: { prompt: PromptDto }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs">
      {prompt.autoSend ? (
        <span className="inline-flex items-center gap-1 text-primary">
          <Icon name="TimeSchedule" className="size-3" aria-hidden />
          auto-send
        </span>
      ) : null}
      {prompt.sendAt !== null ? (
        <span className="inline-flex items-center gap-1 text-primary">
          <Icon name="Calendar" className="size-3" aria-hidden />
          {formatWhen(prompt.sendAt)}
        </span>
      ) : null}
      {prompt.originThreadTitle !== null && prompt.scope !== "thread" ? (
        <span
          className="inline-flex max-w-48 items-center gap-1 truncate text-muted-foreground/70"
          title={`Kept from “${prompt.originThreadTitle}”`}
        >
          <Icon name="ArrowTurnBackward" className="size-3 shrink-0" aria-hidden />
          from {prompt.originThreadTitle}
        </span>
      ) : null}
      {prompt.lastError !== null ? (
        <span
          className="inline-flex items-center gap-1 text-destructive"
          title={prompt.lastError}
        >
          <Icon name="AlertCircle" className="size-3" aria-hidden />
          send failed — re-queued
        </span>
      ) : null}
    </span>
  );
}

export function PromptRow({
  prompt,
  index,
  count,
  actions,
  available,
  variant = "compact",
  alwaysShowActions,
  dragHandlers,
  isDragTarget,
}: {
  prompt: PromptDto;
  index: number;
  count: number;
  actions: PromptRowActions;
  available: ScopeAvailability;
  variant?: "compact" | "roomy";
  alwaysShowActions: boolean;
  dragHandlers?: {
    onDragStart: (index: number) => void;
    onDragEnter: (index: number) => void;
    onDrop: () => void;
  };
  isDragTarget?: boolean;
}) {
  const [targets, setTargets] = useState<{
    threads: { id: string; title: string }[];
    total: number;
  } | null>(null);
  const roomy = variant === "roomy";
  const buttonSize = roomy ? "size-7" : "size-6";
  const canArm = prompt.scope === "thread";
  // Touch and the manager both need controls that do not depend on hover, and
  // HTML5 drag never fires on a touch screen.
  const showArrows = roomy || alwaysShowActions;

  const scopeChoices: { scope: Scope; label: string; enabled: boolean }[] = [
    {
      scope: "thread",
      label: "Move to this thread",
      enabled: available.threadId !== null,
    },
    {
      scope: "project",
      label: "Keep for this project",
      enabled: available.projectId !== null,
    },
    { scope: "global", label: "Move to global", enabled: true },
  ];

  return (
    <div
      draggable={dragHandlers !== undefined && !showArrows}
      onDragStart={() => dragHandlers?.onDragStart(index)}
      onDragEnter={() => dragHandlers?.onDragEnter(index)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={() => dragHandlers?.onDrop()}
      className={cn(
        "group flex items-start gap-1.5 rounded-md px-2 transition-colors hover:bg-state-hover",
        roomy ? "py-2" : "py-1.5",
        isDragTarget && "border-t-2 border-primary",
      )}
    >
      {showArrows ? (
        <span className={cn("flex shrink-0 flex-col", roomy && "pt-0.5")}>
          <button
            type="button"
            className="flex h-4 w-5 items-center justify-center text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-25"
            disabled={index === 0}
            onClick={() => actions.onMove(index, "up")}
            aria-label="Move up"
          >
            <Icon name="ChevronUp" className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            className="flex h-4 w-5 items-center justify-center text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-25"
            disabled={index === count - 1}
            onClick={() => actions.onMove(index, "down")}
            aria-label="Move down"
          >
            <Icon name="ChevronDown" className="size-3.5" aria-hidden />
          </button>
        </span>
      ) : (
        <Icon
          name="DragDropVertical"
          className="mt-1 size-3 shrink-0 cursor-grab text-muted-foreground/40 opacity-0 group-hover:opacity-100"
          aria-hidden
        />
      )}

      {actions.onInject !== null ? (
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => actions.onInject?.(prompt)}
          title="Insert into the composer"
        >
          <span className="line-clamp-2 text-sm text-foreground">
            {previewText(prompt.text)}
          </span>
          <PromptMeta prompt={prompt} />
        </button>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm text-foreground">
            {previewText(prompt.text)}
          </p>
          <PromptMeta prompt={prompt} />
        </div>
      )}

      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
          alwaysShowActions || roomy ? "opacity-100" : "opacity-0",
        )}
      >
        {canArm ? (
          <Button
            size="icon"
            variant="ghost"
            className={cn(buttonSize, prompt.autoSend && "text-primary opacity-100")}
            onClick={() => actions.onToggleArm(prompt)}
            aria-label={
              prompt.autoSend
                ? "Disarm auto-send"
                : "Arm: send automatically when the agent finishes"
            }
          >
            <Icon name="TimeSchedule" className="size-3.5" aria-hidden />
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className={buttonSize}
              aria-label="Prompt actions"
            >
              <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.onInject !== null ? (
              <DropdownMenuItem onSelect={() => actions.onInject?.(prompt)}>
                <Icon name="CornerDownLeft" className="size-4" aria-hidden />
                Insert into composer
              </DropdownMenuItem>
            ) : null}
            {actions.onSendNow !== null ? (
              <DropdownMenuItem onSelect={() => actions.onSendNow?.(prompt)}>
                <Icon name="Sent" className="size-4" aria-hidden />
                Send now
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => actions.onEdit(prompt)}>
              <Icon name="Edit" className="size-4" aria-hidden />
              Edit
            </DropdownMenuItem>
            {canArm ? (
              <DropdownMenuItem onSelect={() => actions.onToggleArm(prompt)}>
                <Icon name="TimeSchedule" className="size-4" aria-hidden />
                {prompt.autoSend ? "Disarm auto-send" : "Arm auto-send"}
              </DropdownMenuItem>
            ) : null}
            {prompt.scope === "thread" ? (
              <DropdownMenuItem onSelect={() => actions.onSchedule(prompt)}>
                <Icon name="Calendar" className="size-4" aria-hidden />
                {prompt.sendAt === null ? "Schedule…" : "Reschedule…"}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                onPointerEnter={() => {
                  if (targets === null)
                    void actions
                      .loadTargets()
                      .then(setTargets)
                      .catch(() => setTargets({ threads: [], total: 0 }));
                }}
              >
                <Icon name="Sent" className="size-4" aria-hidden />
                Send to thread
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                {targets === null ? (
                  <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
                ) : targets.threads.length === 0 ? (
                  <DropdownMenuItem disabled>No other threads</DropdownMenuItem>
                ) : (
                  <>
                    {targets.threads.map((target) => (
                      <DropdownMenuItem
                        key={target.id}
                        onSelect={() => actions.onSendToThread(prompt, target.id)}
                      >
                        <span className="max-w-56 truncate">{target.title}</span>
                      </DropdownMenuItem>
                    ))}
                    {targets.total > targets.threads.length ? (
                      <DropdownMenuItem disabled>
                        {`… ${targets.total - targets.threads.length} more not shown`}
                      </DropdownMenuItem>
                    ) : null}
                  </>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {actions.onPush !== null ? (
              <DropdownMenuItem onSelect={() => actions.onPush?.(prompt)}>
                <Icon name="ChevronsUp" className="size-4" aria-hidden />
                Push to bb queue
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => actions.onSaveAsSnippet(prompt)}>
              <Icon name="Explore" className="size-4" aria-hidden />
              Save as snippet
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {scopeChoices
              .filter((choice) => choice.scope !== prompt.scope && choice.enabled)
              .map((choice) => (
                <DropdownMenuItem
                  key={choice.scope}
                  onSelect={() => actions.onChangeScope(prompt, choice.scope)}
                >
                  <Icon name="ArrowUpDown" className="size-4" aria-hidden />
                  {choice.label}
                </DropdownMenuItem>
              ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={index === 0}
              onSelect={() => actions.onMove(index, "up")}
            >
              <Icon name="ArrowUp" className="size-4" aria-hidden />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === count - 1}
              onSelect={() => actions.onMove(index, "down")}
            >
              <Icon name="ArrowDown" className="size-4" aria-hidden />
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => actions.onDelete(prompt)}
            >
              <Icon name="Trash2" className="size-4" aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Used prompts
// ---------------------------------------------------------------------------

export function UsedPromptRow({
  prompt,
  onRestore,
  showTime = false,
}: {
  prompt: PromptDto;
  onRestore: (prompt: PromptDto) => void;
  showTime?: boolean;
}) {
  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover">
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {previewText(prompt.text)}
        </p>
        <p className="text-xs text-muted-foreground/70">
          {usedViaLabel(prompt)}
          {prompt.scope === "global" ? " · global" : ""}
          {prompt.scope === "project" ? " · project" : ""}
          {showTime && prompt.usedAt ? ` · ${formatWhen(prompt.usedAt)}` : ""}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-2 text-xs opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => onRestore(prompt)}
      >
        <Icon name="ArrowTurnBackward" className="size-3.5" aria-hidden />
        Restore
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

export interface SnippetRowActions {
  onInsert: ((snippet: SnippetDto) => void) | null;
  /**
   * Queue the snippet. `targets[0]` is the default — the most specific queue
   * this surface sits in — and the menu offers the rest.
   */
  onQueue: (snippet: SnippetDto, target: QueueTarget) => void;
  targets: QueueTarget[];
  /** Queue it for a time instead of now; null when no thread can receive it. */
  onQueueLater: ((snippet: SnippetDto, target: QueueTarget) => void) | null;
  /** Threads other than this one, loaded on demand. */
  loadTargets: () => Promise<{
    threads: { id: string; title: string }[];
    total: number;
  }>;
  onEdit: (snippet: SnippetDto) => void;
  onDelete: (snippet: SnippetDto) => void;
}

export function SnippetRow({
  snippet,
  actions,
  alwaysShowActions,
  variant = "compact",
}: {
  snippet: SnippetDto;
  actions: SnippetRowActions;
  alwaysShowActions: boolean;
  variant?: "compact" | "roomy";
}) {
  const roomy = variant === "roomy";
  const tokens = parseTokens(snippet.body);
  const [otherThreads, setOtherThreads] = useState<{
    threads: { id: string; title: string }[];
    total: number;
  } | null>(null);
  const defaultTarget = actions.targets[0]!;

  return (
    <div
      className={cn(
        "group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover",
      )}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() =>
          actions.onInsert
            ? actions.onInsert(snippet)
            : actions.onQueue(snippet, defaultTarget)
        }
        title={
          actions.onInsert
            ? "Insert into the composer"
            : `Queue for ${defaultTarget.phrase}`
        }
      >
        <span className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
          <span className="truncate font-medium">{snippet.title}</span>
          {snippet.groupName ? (
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5"
              style={{ fontSize: 10 }}
            >
              {snippet.groupName}
            </Badge>
          ) : null}
          {tokens.length > 0 ? (
            roomy ? (
              <Badge
                variant="outline"
                className="shrink-0 px-1.5 font-mono"
                style={{ fontSize: 10 }}
              >
                {tokens.length} fill-in{tokens.length === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Icon
                name="EditFile"
                className="size-3 shrink-0 text-muted-foreground"
                aria-hidden
              />
            )
          ) : null}
          {snippet.projectId !== null ? (
            <span
              className="shrink-0 text-xs font-normal text-muted-foreground/60"
              title="Only shown in this project"
            >
              project
            </span>
          ) : null}
          {roomy && snippet.useCount > 0 ? (
            <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground/60">
              {snippet.useCount}×
            </span>
          ) : null}
        </span>
        <span className="line-clamp-1 text-xs text-muted-foreground">
          {previewText(snippet.body)}
        </span>
      </button>
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
          alwaysShowActions ? "opacity-100" : "opacity-0",
        )}
      >
        {roomy ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => actions.onQueue(snippet, defaultTarget)}
            aria-label={`Queue “${snippet.title}” for ${defaultTarget.phrase}`}
          >
            <Icon name="Layers" className="size-3.5" aria-hidden />
            Queue
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className={roomy ? "size-7" : "size-6"}
              aria-label={`Actions for ${snippet.title}`}
            >
              <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.onInsert !== null ? (
              <DropdownMenuItem onSelect={() => actions.onInsert?.(snippet)}>
                <Icon name="CornerDownLeft" className="size-4" aria-hidden />
                Insert into composer
              </DropdownMenuItem>
            ) : null}
            {actions.targets.length === 1 ? (
              <DropdownMenuItem
                onSelect={() => actions.onQueue(snippet, defaultTarget)}
              >
                <Icon name="Layers" className="size-4" aria-hidden />
                {`Add to ${defaultTarget.phrase}`}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Icon name="Layers" className="size-4" aria-hidden />
                  Add to queue
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {actions.targets.map((target) => (
                    <DropdownMenuItem
                      key={`${target.scope}:${target.threadId ?? target.projectId ?? ""}`}
                      onSelect={() => actions.onQueue(snippet, target)}
                    >
                      {target.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {actions.onQueueLater !== null ? (
              <DropdownMenuItem
                onSelect={() => actions.onQueueLater?.(snippet, defaultTarget)}
              >
                <Icon name="Calendar" className="size-4" aria-hidden />
                Queue for later…
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                onPointerEnter={() => {
                  if (otherThreads === null)
                    void actions
                      .loadTargets()
                      .then(setOtherThreads)
                      .catch(() => setOtherThreads({ threads: [], total: 0 }));
                }}
              >
                <Icon name="Sent" className="size-4" aria-hidden />
                Queue in another thread
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                {otherThreads === null ? (
                  <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
                ) : otherThreads.threads.length === 0 ? (
                  <DropdownMenuItem disabled>No other threads</DropdownMenuItem>
                ) : (
                  <>
                    {otherThreads.threads.map((thread) => (
                      <DropdownMenuItem
                        key={thread.id}
                        onSelect={() =>
                          actions.onQueue(
                            snippet,
                            threadTarget(thread.id, thread.title),
                          )
                        }
                      >
                        <span className="max-w-56 truncate">{thread.title}</span>
                      </DropdownMenuItem>
                    ))}
                    {otherThreads.total > otherThreads.threads.length ? (
                      <DropdownMenuItem disabled>
                        {`… ${otherThreads.total - otherThreads.threads.length} more not shown`}
                      </DropdownMenuItem>
                    ) : null}
                  </>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => actions.onEdit(snippet)}>
              <Icon name="Edit" className="size-4" aria-hidden />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => actions.onDelete(snippet)}
            >
              <Icon name="Trash2" className="size-4" aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// bb's own queue
// ---------------------------------------------------------------------------

export function NativeQueueRow({
  item,
  onSend,
  onStash,
  alwaysShowActions,
}: {
  item: NativeQueueItem;
  onSend: (item: NativeQueueItem) => void;
  onStash: (item: NativeQueueItem) => void;
  alwaysShowActions: boolean;
}) {
  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-state-hover">
      <span className="line-clamp-2 min-w-0 flex-1 text-sm text-foreground">
        {previewText(item.text)}
      </span>
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
          alwaysShowActions ? "opacity-100" : "opacity-0",
        )}
      >
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => onSend(item)}
          aria-label="Send now"
        >
          <Icon name="Sent" className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => onStash(item)}
          aria-label="Stash: move to the Prompts queue so it does not auto-send"
        >
          <Icon name="ArrowDown" className="size-3.5" aria-hidden />
          Stash
        </Button>
      </div>
    </div>
  );
}
