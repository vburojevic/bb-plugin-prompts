// bb-plugin-prompts — frontend entry.
//
// Surfaces:
// - Composer action: queue button (badge = pending count) opening a popover
//   with This thread / Global / Snippets / Used tabs, search, drag-to-reorder,
//   run-queue / pause controls, schedule + send-to-thread actions, and
//   {{fill-in}} template dialogs.
// - Composer plus-menu: "Queue current draft" and "Save draft as snippet".
// - Composer banner: armed/paused/failure state while relevant.
// - Thread panel action: the same view in a side panel tab.
//
// Queue prompts consume on inject (undo restores); snippets never consume.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { extractTokens, fillTokens } from "./lib/template";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { usePointerCoarse } from "@/components/ui/hooks/use-pointer-coarse";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

interface PromptDto {
  id: string;
  scope: "thread" | "global";
  threadId: string | null;
  text: string;
  status: "queued" | "used";
  autoSend: boolean;
  sendAt: number | null;
  position: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  usedAt: number | null;
  usedVia:
    | "inject"
    | "auto-send"
    | "cli"
    | "scheduled"
    | "cross-thread"
    | "bb-queue"
    | null;
}

interface NativeQueueItem {
  id: string;
  text: string;
  updatedAt: number;
}

interface SnippetDto {
  id: string;
  title: string;
  body: string;
  description: string;
  keywords: string;
  groupId: string | null;
  groupName: string | null;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface QueueData {
  threadPrompts: PromptDto[];
  globalPrompts: PromptDto[];
  recentlyUsed: PromptDto[];
  paused: boolean;
}

const EMPTY: QueueData = {
  threadPrompts: [],
  globalPrompts: [],
  recentlyUsed: [],
  paused: false,
};

/**
 * Direct rpc for host-rendered callbacks (plus-menu run) that cannot use the
 * useRpc hook. Same wire as the hook: local-auth plugin rpc route.
 */
async function callRpcDirect(method: string, input: unknown): Promise<unknown> {
  const response = await fetch(`/api/v1/plugins/prompts/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const envelope = (await response.json()) as
    | { ok: true; result: unknown }
    | { ok: false; error: { message?: string } };
  if (!envelope.ok)
    throw new Error(envelope.error?.message ?? "Prompts rpc failed");
  return envelope.result;
}

/** Thread the composer's messages land in, or null on the new-thread screen. */
function useComposerThreadId(): string | null {
  const view = useComposerView();
  const scope = view.scope;
  if (scope.kind === "thread" || scope.kind === "queued-message")
    return scope.threadId;
  if (scope.kind === "side-chat")
    return scope.childThreadId ?? scope.parentThreadId;
  return null;
}

function composerThreadIdFromScope(scope: {
  kind: string;
  threadId?: string;
  childThreadId?: string | null;
  parentThreadId?: string;
}): string | null {
  if (scope.kind === "thread" || scope.kind === "queued-message")
    return scope.threadId ?? null;
  if (scope.kind === "side-chat")
    return scope.childThreadId ?? scope.parentThreadId ?? null;
  return null;
}

function useQueue(threadId: string | null, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<QueueData>(EMPTY);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void rpc
      .call("listPrompts", { threadId })
      .then((result) => setData(result))
      .catch(() => {});
  }, [rpc, threadId, enabled]);

  useEffect(refresh, [refresh]);
  useRealtime("prompts", (payload) => {
    const signal = payload as { kind: string; threadId: string | null };
    if (
      signal.threadId === null ||
      threadId === null ||
      signal.threadId === threadId
    )
      refresh();
  });

  return { data, refresh, rpc };
}

function previewText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatWhen(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Fill-in dialog for {{token}} templates
// ---------------------------------------------------------------------------

interface FillInRequest {
  text: string;
  title: string;
  /** Receives the filled text; the dialog closes either way. */
  complete: (filled: string) => void;
}

function FillInDialog({
  request,
  onDone,
  onCancel,
}: {
  request: FillInRequest | null;
  onDone: (filled: string) => void;
  onCancel: () => void;
}) {
  const tokens = useMemo(
    () => (request ? extractTokens(request.text) : []),
    [request],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues({}), [request]);
  if (request === null) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fill in “{request.title}”</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {tokens.map((token) => (
            <div key={token} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {token}
              </label>
              <Input
                value={values[token] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [token]: event.target.value,
                  }))
                }
                placeholder={token}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onDone(fillTokens(request.text, values))}>
            Insert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Schedule dialog
// ---------------------------------------------------------------------------

function toLocalInputValue(ms: number): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function ScheduleDialog({
  prompt,
  rpc,
  refresh,
  onClose,
}: {
  prompt: PromptDto | null;
  rpc: Rpc;
  refresh: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (prompt)
      setValue(toLocalInputValue(prompt.sendAt ?? Date.now() + 3_600_000));
  }, [prompt]);
  if (prompt === null) return null;

  async function save(clear: boolean): Promise<void> {
    const sendAt = clear ? null : new Date(value).getTime();
    if (!clear && Number.isNaN(sendAt)) return;
    await rpc.call("updatePrompt", { id: prompt!.id, sendAt });
    refresh();
    onClose();
    toast.success(
      clear ? "Schedule cleared" : `Will send ${formatWhen(sendAt!)}`,
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule prompt</DialogTitle>
        </DialogHeader>
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {previewText(prompt.text)}
        </p>
        <Input
          type="datetime-local"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Sends at this time even if the agent is busy (the message queues on
          the thread). Auto-send pause does not block scheduled sends.
        </p>
        <DialogFooter>
          {prompt.sendAt !== null ? (
            <Button variant="outline" onClick={() => void save(true)}>
              Clear schedule
            </Button>
          ) : null}
          <Button onClick={() => void save(false)}>Schedule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Snippet editor dialog
// ---------------------------------------------------------------------------

interface SnippetDraft {
  id: string | null;
  title: string;
  body: string;
  keywords: string;
  groupName: string;
}

function SnippetEditor({
  draft,
  rpc,
  onSaved,
  onClose,
}: {
  draft: SnippetDraft | null;
  rpc: Rpc;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<SnippetDraft | null>(draft);
  useEffect(() => setForm(draft), [draft]);
  if (form === null) return null;

  async function save(): Promise<void> {
    const current = form!;
    if (!current.title.trim() || !current.body.trim()) return;
    if (current.id === null) {
      await rpc.call("addSnippet", {
        title: current.title.trim(),
        body: current.body,
        keywords: current.keywords.trim(),
        groupName: current.groupName.trim() || null,
      });
    } else {
      await rpc.call("updateSnippet", {
        id: current.id,
        title: current.title.trim(),
        body: current.body,
        keywords: current.keywords.trim(),
        groupName: current.groupName.trim() || null,
      });
    }
    onSaved();
    onClose();
    toast.success(current.id === null ? "Snippet saved" : "Snippet updated");
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {form.id === null ? "New snippet" : "Edit snippet"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={form.title}
            onChange={(event) =>
              setForm((current) =>
                current ? { ...current, title: event.target.value } : current,
              )
            }
            placeholder="Title"
          />
          <Textarea
            value={form.body}
            onChange={(event) =>
              setForm((current) =>
                current ? { ...current, body: event.target.value } : current,
              )
            }
            placeholder="Body — use {{placeholders}} for fill-ins"
            className="min-h-32"
          />
          <div className="flex gap-2">
            <Input
              value={form.keywords}
              onChange={(event) =>
                setForm((current) =>
                  current
                    ? { ...current, keywords: event.target.value }
                    : current,
                )
              }
              placeholder="Keywords"
            />
            <Input
              value={form.groupName}
              onChange={(event) =>
                setForm((current) =>
                  current
                    ? { ...current, groupName: event.target.value }
                    : current,
                )
              }
              placeholder="Group (optional)"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!form.title.trim() || !form.body.trim()}
            onClick={() => void save()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Queue prompt row
// ---------------------------------------------------------------------------

function PromptRow({
  prompt,
  index,
  count,
  canArm,
  threadId,
  onInject,
  onEdit,
  onSchedule,
  onMove,
  onPush,
  onSaveAsSnippet,
  rpc,
  refresh,
  dragHandlers,
  isDragTarget,
  alwaysShowActions,
}: {
  prompt: PromptDto;
  index: number;
  count: number;
  canArm: boolean;
  threadId: string | null;
  onInject: ((prompt: PromptDto) => void) | null;
  onEdit: (prompt: PromptDto) => void;
  onSchedule: (prompt: PromptDto) => void;
  onMove: (index: number, direction: "up" | "down") => void;
  onPush: ((prompt: PromptDto) => void) | null;
  onSaveAsSnippet: (prompt: PromptDto) => void;
  rpc: Rpc;
  refresh: () => void;
  dragHandlers: {
    onDragStart: (index: number) => void;
    onDragEnter: (index: number) => void;
    onDrop: () => void;
  };
  isDragTarget: boolean;
  alwaysShowActions: boolean;
}) {
  const [targets, setTargets] = useState<{ id: string; title: string }[]>([]);

  async function remove(): Promise<void> {
    const { deleted } = await rpc.call("deletePrompt", { id: prompt.id });
    if (!deleted) return;
    refresh();
    toast("Prompt deleted", {
      action: {
        label: "Undo",
        onClick: () =>
          void rpc
            .call("addPrompt", {
              text: prompt.text,
              scope: prompt.scope,
              threadId: prompt.threadId,
              autoSend: prompt.autoSend,
            })
            .then(refresh),
      },
    });
  }

  async function toggleArm(): Promise<void> {
    await rpc.call("updatePrompt", { id: prompt.id, autoSend: !prompt.autoSend });
    refresh();
  }

  async function toggleScope(): Promise<void> {
    await rpc.call("updatePrompt", {
      id: prompt.id,
      scope: prompt.scope === "global" ? "thread" : "global",
    });
    refresh();
  }

  async function loadTargets(): Promise<void> {
    try {
      const { threads } = await rpc.call("listTargets", {
        excludeThreadId: threadId,
      });
      setTargets(threads);
    } catch {
      setTargets([]);
    }
  }

  async function sendTo(targetId: string): Promise<void> {
    const { sent, error } = await rpc.call("sendPromptToThread", {
      id: prompt.id,
      threadId: targetId,
    });
    refresh();
    if (sent) toast.success("Prompt sent");
    else toast.error(error ?? "Send failed");
  }

  return (
    <div
      draggable
      onDragStart={() => dragHandlers.onDragStart(index)}
      onDragEnter={() => dragHandlers.onDragEnter(index)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={dragHandlers.onDrop}
      className={cn(
        "group flex items-start gap-1.5 rounded-md px-2 py-1.5 hover:bg-state-hover",
        isDragTarget && "border-t-2 border-primary",
      )}
    >
      {alwaysShowActions ? (
        // Touch: HTML5 drag never fires, so show real reorder buttons.
        <span className="flex shrink-0 flex-col">
          <button
            type="button"
            className="flex h-4 w-5 items-center justify-center text-muted-foreground/60 disabled:opacity-25"
            disabled={index === 0}
            onClick={() => onMove(index, "up")}
            aria-label="Move up"
          >
            <Icon name="ChevronUp" className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            className="flex h-4 w-5 items-center justify-center text-muted-foreground/60 disabled:opacity-25"
            disabled={index === count - 1}
            onClick={() => onMove(index, "down")}
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
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => onInject?.(prompt)}
        title={onInject ? "Insert into the composer" : undefined}
        disabled={onInject === null}
      >
        <span className="line-clamp-2 text-sm text-foreground">
          {previewText(prompt.text)}
        </span>
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
      </button>
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
          alwaysShowActions ? "opacity-100" : "opacity-0",
        )}
      >
        {canArm ? (
          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "size-6",
              prompt.autoSend && "text-primary opacity-100",
            )}
            onClick={() => void toggleArm()}
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
              className="size-6"
              aria-label="Prompt actions"
            >
              <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onInject !== null ? (
              <DropdownMenuItem onSelect={() => onInject(prompt)}>
                <Icon name="CornerDownLeft" className="size-4" aria-hidden />
                Insert into composer
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onEdit(prompt)}>
              <Icon name="Edit" className="size-4" aria-hidden />
              Edit
            </DropdownMenuItem>
            {canArm ? (
              <DropdownMenuItem onSelect={() => void toggleArm()}>
                <Icon name="TimeSchedule" className="size-4" aria-hidden />
                {prompt.autoSend ? "Disarm auto-send" : "Arm auto-send"}
              </DropdownMenuItem>
            ) : null}
            {prompt.scope === "thread" ? (
              <DropdownMenuItem onSelect={() => onSchedule(prompt)}>
                <Icon name="Calendar" className="size-4" aria-hidden />
                {prompt.sendAt === null ? "Schedule…" : "Reschedule…"}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger onPointerEnter={() => void loadTargets()}>
                <Icon name="Sent" className="size-4" aria-hidden />
                Send to thread
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                {targets.length === 0 ? (
                  <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
                ) : (
                  targets.map((target) => (
                    <DropdownMenuItem
                      key={target.id}
                      onSelect={() => void sendTo(target.id)}
                    >
                      <span className="max-w-56 truncate">{target.title}</span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {onPush !== null ? (
              <DropdownMenuItem onSelect={() => onPush(prompt)}>
                <Icon name="ChevronsUp" className="size-4" aria-hidden />
                Push to bb queue
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onSaveAsSnippet(prompt)}>
              <Icon name="Star" className="size-4" aria-hidden />
              Save as snippet
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void toggleScope()}>
              <Icon name="ArrowUpDown" className="size-4" aria-hidden />
              {prompt.scope === "global"
                ? "Move to this thread"
                : "Move to global"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={index === 0}
              onSelect={() => onMove(index, "up")}
            >
              <Icon name="ArrowUp" className="size-4" aria-hidden />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === count - 1}
              onSelect={() => onMove(index, "down")}
            >
              <Icon name="ArrowDown" className="size-4" aria-hidden />
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void remove()}
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
// Snippet row
// ---------------------------------------------------------------------------

function SnippetRow({
  snippet,
  onInsert,
  onQueue,
  onEdit,
  rpc,
  refresh,
  alwaysShowActions,
}: {
  snippet: SnippetDto;
  onInsert: ((snippet: SnippetDto) => void) | null;
  onQueue: (snippet: SnippetDto) => void;
  onEdit: (snippet: SnippetDto) => void;
  rpc: Rpc;
  refresh: () => void;
  alwaysShowActions: boolean;
}) {
  async function remove(): Promise<void> {
    await rpc.call("deleteSnippet", { id: snippet.id });
    refresh();
    toast("Snippet deleted", {
      action: {
        label: "Undo",
        onClick: () =>
          void rpc
            .call("addSnippet", {
              title: snippet.title,
              body: snippet.body,
              description: snippet.description,
              keywords: snippet.keywords,
              groupName: snippet.groupName,
            })
            .then(refresh),
      },
    });
  }

  const hasTokens = extractTokens(snippet.body).length > 0;

  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-state-hover">
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => (onInsert ? onInsert(snippet) : onQueue(snippet))}
        title={onInsert ? "Insert into the composer" : "Add to queue"}
      >
        <span className="flex items-center gap-1.5 text-sm text-foreground">
          <span className="truncate font-medium">{snippet.title}</span>
          {hasTokens ? (
            <Icon
              name="EditFile"
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : null}
          {snippet.groupName ? (
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5"
              style={{ fontSize: 10 }}
            >
              {snippet.groupName}
            </Badge>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Snippet actions"
            >
              <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onInsert !== null ? (
              <DropdownMenuItem onSelect={() => onInsert(snippet)}>
                <Icon name="CornerDownLeft" className="size-4" aria-hidden />
                Insert into composer
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onQueue(snippet)}>
              <Icon name="ListTodo" className="size-4" aria-hidden />
              Add to queue
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEdit(snippet)}>
              <Icon name="Edit" className="size-4" aria-hidden />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void remove()}
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
// The shared queue + snippets view
// ---------------------------------------------------------------------------

function QueueView({
  threadId,
  onInsertText,
  className,
  listClassName,
  fixedHeight = false,
  onOpenManager = null,
}: {
  threadId: string | null;
  /** Receives final text (fill-ins resolved); null = no composer here. */
  onInsertText: ((text: string) => boolean) | null;
  className?: string;
  listClassName?: string;
  /**
   * Desktop popover mode: constant overall height so switching tabs never
   * changes the panel's footprint (the popover opens upward — a height
   * change would make the top edge jump instead of growing from the anchor).
   */
  fixedHeight?: boolean;
  /** Renders an expand button that jumps to the full manager screen. */
  onOpenManager?: (() => void) | null;
}) {
  const { data, refresh, rpc } = useQueue(threadId, true);
  const [tab, setTab] = useState<"thread" | "global" | "snippets" | "used">(
    threadId === null ? "global" : "thread",
  );
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [armDraft, setArmDraft] = useState(false);
  const [editing, setEditing] = useState<PromptDto | null>(null);
  const [editText, setEditText] = useState("");
  const [scheduling, setScheduling] = useState<PromptDto | null>(null);
  const [snippetDraft, setSnippetDraft] = useState<SnippetDraft | null>(null);
  const [fillIn, setFillIn] = useState<FillInRequest | null>(null);
  const pointerCoarse = usePointerCoarse();
  const compactViewport = useIsCompactViewport();
  const alwaysShowActions = pointerCoarse || compactViewport;
  const [snippets, setSnippets] = useState<SnippetDto[]>([]);
  const [nativeItems, setNativeItems] = useState<NativeQueueItem[]>([]);
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const hasThreadTab = threadId !== null;
  const activeTab = !hasThreadTab && tab === "thread" ? "global" : tab;

  const refreshSnippets = useCallback(() => {
    void rpc
      .call("listSnippets", { query: search })
      .then((result) => setSnippets(result.snippets))
      .catch(() => {});
  }, [rpc, search]);

  const refreshNative = useCallback(() => {
    if (threadId === null) {
      setNativeItems([]);
      return;
    }
    void rpc
      .call("listNativeQueue", { threadId })
      .then((result) => setNativeItems(result.items))
      .catch(() => setNativeItems([]));
  }, [rpc, threadId]);

  useEffect(() => {
    if (activeTab === "snippets") refreshSnippets();
    if (activeTab === "thread") refreshNative();
  }, [activeTab, refreshSnippets, refreshNative]);
  useRealtime("prompts", () => {
    if (activeTab === "snippets") refreshSnippets();
    if (activeTab === "thread") refreshNative();
  });
  // Backstop poll: native-queue writes from the composer emit no plugin
  // signal, so refetch periodically while the thread tab is showing.
  useEffect(() => {
    if (activeTab !== "thread" || threadId === null) return;
    const timer = setInterval(refreshNative, 5_000);
    return () => clearInterval(timer);
  }, [activeTab, threadId, refreshNative]);

  const filter = useCallback(
    (prompts: PromptDto[]) => {
      const query = search.trim().toLowerCase();
      if (!query) return prompts;
      return prompts.filter((prompt) =>
        prompt.text.toLowerCase().includes(query),
      );
    },
    [search],
  );

  const list =
    activeTab === "thread"
      ? filter(data.threadPrompts)
      : activeTab === "global"
        ? filter(data.globalPrompts)
        : activeTab === "used"
          ? filter(data.recentlyUsed)
          : [];

  const armedCount = data.threadPrompts.filter((p) => p.autoSend).length;
  const searchActive = search.trim().length > 0;

  // ---- insert / consume ----

  function deliverText(text: string): boolean {
    if (onInsertText === null) return false;
    return onInsertText(text);
  }

  function injectPrompt(prompt: PromptDto): void {
    const deliver = (text: string) => {
      if (!deliverText(text)) return;
      consumeAfterInject(prompt.id);
    };
    if (extractTokens(prompt.text).length > 0) {
      setFillIn({
        text: prompt.text,
        title: previewText(prompt.text).slice(0, 40),
        complete: deliver,
      });
      return;
    }
    deliver(prompt.text);
  }

  function consumeAfterInject(promptId: string): void {
    void rpc.call("consumePrompt", { id: promptId, via: "inject" }).then(() => {
      refresh();
      toast.success("Prompt added to the composer", {
        action: {
          label: "Keep queued",
          onClick: () =>
            void rpc.call("restorePrompt", { id: promptId }).then(refresh),
        },
      });
    });
  }

  function withFillIns(
    text: string,
    title: string,
    deliver: (filled: string) => void,
  ): void {
    if (extractTokens(text).length > 0) {
      setFillIn({ text, title, complete: deliver });
      return;
    }
    deliver(text);
  }

  function insertSnippet(snippet: SnippetDto): void {
    withFillIns(snippet.body, snippet.title, (filled) => {
      if (!deliverText(filled)) return;
      void rpc.call("useSnippet", { id: snippet.id });
      toast.success(`“${snippet.title}” inserted`);
    });
  }

  /** Snippet → queue: works everywhere, composer or not. */
  function queueSnippet(snippet: SnippetDto): void {
    withFillIns(snippet.body, snippet.title, (filled) => {
      const scope = threadId === null ? "global" : "thread";
      void rpc
        .call("addPrompt", {
          text: filled,
          scope,
          threadId,
          autoSend: false,
        })
        .then(() => {
          void rpc.call("useSnippet", { id: snippet.id });
          refresh();
          toast.success(
            scope === "thread"
              ? `“${snippet.title}” queued for this thread`
              : `“${snippet.title}” queued globally`,
          );
        })
        .catch(() => toast.error("Failed to queue the snippet"));
    });
  }

  function completeFillIn(filled: string): void {
    const request = fillIn;
    setFillIn(null);
    request?.complete(filled);
  }

  // ---- add / edit / restore ----

  async function add(): Promise<void> {
    const text = draft.trim();
    if (!text) return;
    const scope =
      activeTab === "global" || !hasThreadTab ? "global" : "thread";
    await rpc.call("addPrompt", {
      text,
      scope,
      threadId: scope === "thread" ? threadId : null,
      autoSend: armDraft && scope === "thread",
    });
    setDraft("");
    setArmDraft(false);
    refresh();
    if (activeTab === "used" || activeTab === "snippets")
      setTab(scope === "thread" ? "thread" : "global");
  }

  async function saveEdit(): Promise<void> {
    if (editing === null) return;
    const text = editText.trim();
    if (!text) return;
    await rpc.call("updatePrompt", { id: editing.id, text });
    setEditing(null);
    refresh();
  }

  async function restore(prompt: PromptDto): Promise<void> {
    await rpc.call("restorePrompt", { id: prompt.id });
    refresh();
    toast.success("Restored to queue");
  }

  function saveAsSnippet(prompt: PromptDto): void {
    setSnippetDraft({
      id: null,
      title: previewText(prompt.text).slice(0, 60),
      body: prompt.text,
      keywords: "",
      groupName: "",
    });
  }

  // ---- reorder (dnd) ----

  const reorderScope = activeTab === "thread" ? "thread" : "global";
  const dragHandlers = {
    onDragStart(index: number) {
      dragFrom.current = index;
    },
    onDragEnter(index: number) {
      if (dragFrom.current !== null && index !== dragFrom.current)
        setDragOver(index);
    },
    onDrop() {
      const from = dragFrom.current;
      const to = dragOver;
      dragFrom.current = null;
      setDragOver(null);
      // Reordering a filtered list would scramble hidden rows.
      if (from === null || to === null || from === to || searchActive) return;
      const ordered = [...list];
      const [moved] = ordered.splice(from, 1);
      ordered.splice(to > from ? to - 1 : to, 0, moved!);
      void rpc
        .call("reorderPrompts", {
          scope: reorderScope,
          threadId: reorderScope === "thread" ? threadId : null,
          ids: ordered.map((prompt) => prompt.id),
        })
        .then(refresh);
    },
  };

  // ---- bb native queue bridge ----

  function pushToNative(prompt: PromptDto): void {
    if (threadId === null) return;
    const doPush = (text: string) => {
      const send = () =>
        rpc.call("pushToNativeQueue", { id: prompt.id, threadId }).then(
          ({ pushed, error }) => {
            refresh();
            refreshNative();
            if (pushed)
              toast.success("Moved to bb's queue — sends with the next turn");
            else toast.error(error ?? "Push failed");
          },
        );
      // Fill-ins resolved? Persist the filled text before pushing so the
      // native queue receives the final prompt, not the template.
      if (text !== prompt.text) {
        void rpc.call("updatePrompt", { id: prompt.id, text }).then(send);
      } else {
        void send();
      }
    };
    withFillIns(prompt.text, previewText(prompt.text).slice(0, 40), doPush);
  }

  function stashAll(): void {
    if (threadId === null) return;
    void rpc.call("stashAllNative", { threadId }).then(({ stashed, skipped }) => {
      refresh();
      refreshNative();
      if (stashed > 0)
        toast.success(
          `Stashed ${stashed} message${stashed === 1 ? "" : "s"} — nothing sends until you say so`,
        );
      if (skipped > 0) toast(`${skipped} non-text message(s) left in place`);
    });
  }

  function stashNative(item: NativeQueueItem): void {
    if (threadId === null) return;
    void rpc
      .call("stashNativeMessage", { threadId, queuedMessageId: item.id })
      .then(({ prompt, error }) => {
        refresh();
        refreshNative();
        if (prompt) toast.success("Stashed — it won't send until you say so");
        else toast.error(error ?? "Stash failed");
      });
  }

  function sendNative(item: NativeQueueItem): void {
    if (threadId === null) return;
    void rpc
      .call("sendNativeNow", { threadId, queuedMessageId: item.id })
      .then(({ sent, error }) => {
        refreshNative();
        if (sent) toast.success("Sent");
        else toast.error(error ?? "Send failed");
      });
  }

  /** Swap-based reorder for menu items and touch arrow buttons. */
  function movePrompt(index: number, direction: "up" | "down"): void {
    if (searchActive) {
      toast("Clear the filter to reorder");
      return;
    }
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= list.length) return;
    const ordered = [...list];
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved!);
    void rpc
      .call("reorderPrompts", {
        scope: reorderScope,
        threadId: reorderScope === "thread" ? threadId : null,
        ids: ordered.map((prompt) => prompt.id),
      })
      .then(refresh);
  }

  // ---- queue-level controls ----

  async function runQueue(): Promise<void> {
    if (threadId === null) return;
    const { armed } = await rpc.call("armAll", { threadId });
    refresh();
    toast.success(
      armed > 0
        ? `Armed ${armed} prompt${armed === 1 ? "" : "s"} — the queue drains as the agent idles`
        : "Everything is already armed",
    );
  }

  async function disarmAll(): Promise<void> {
    if (threadId === null) return;
    await rpc.call("disarmThread", { threadId });
    refresh();
  }

  async function togglePause(): Promise<void> {
    if (threadId === null) return;
    await rpc.call("setPaused", { threadId, paused: !data.paused });
    refresh();
  }

  const addScopeLabel =
    activeTab === "global" || !hasThreadTab
      ? "Queue globally"
      : "Queue for this thread";

  return (
    <div
      className={cn("flex flex-col", className)}
      // Mobile: restore the safe-area padding stripped by the popover's p-0.
      // Desktop popover: fixed height so tab switches never move the panel.
      style={{
        ...(compactViewport
          ? { paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }
          : undefined),
        ...(fixedHeight && !compactViewport ? { height: "30rem" } : undefined),
      }}
    >
      <div className="space-y-2 border-b border-border p-2">
        <Tabs
          value={activeTab}
          onValueChange={(value) => setTab(value as typeof tab)}
          className="w-full"
        >
          <TabsList className="w-full">
            {hasThreadTab ? (
              <TabsTrigger value="thread" className="flex-1">
                Thread
                {data.threadPrompts.length > 0 ? (
                  <Badge variant="secondary" className="ml-1.5 px-1.5">
                    {data.threadPrompts.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="global" className="flex-1">
              Global
              {data.globalPrompts.length > 0 ? (
                <Badge variant="secondary" className="ml-1.5 px-1.5">
                  {data.globalPrompts.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="snippets" className="flex-1">
              Snippets
            </TabsTrigger>
            <TabsTrigger value="used" className="flex-1">
              Used
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1.5">
          {onOpenManager !== null ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground"
              onClick={onOpenManager}
              aria-label="Open the Prompts manager"
            >
              <Icon name="Maximize2" className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              activeTab === "snippets"
                ? "Search snippets…"
                : "Filter prompts…"
            }
            className="h-7 text-sm"
          />
          {activeTab === "thread" && hasThreadTab ? (
            <>
              {armedCount === 0 && data.threadPrompts.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => void runQueue()}
                  aria-label="Run queue: arm every queued prompt; they send in order as the agent goes idle"
                >
                  <Icon name="Play" className="size-3.5" aria-hidden />
                  Run queue
                </Button>
              ) : null}
              {armedCount > 0 ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2 text-xs"
                    onClick={() => void togglePause()}
                    aria-label={
                      data.paused ? "Resume auto-send" : "Pause auto-send"
                    }
                  >
                    <Icon
                      name={data.paused ? "Play" : "Pause"}
                      className="size-3.5"
                      aria-hidden
                    />
                    {data.paused ? "Resume" : "Pause"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-xs"
                    onClick={() => void disarmAll()}
                  >
                    Disarm all
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
          {activeTab === "snippets" ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={() =>
                setSnippetDraft({
                  id: null,
                  title: "",
                  body: "",
                  keywords: "",
                  groupName: "",
                })
              }
            >
              <Icon name="Plus" className="size-3.5" aria-hidden />
              New
            </Button>
          ) : null}
        </div>
        {data.paused && activeTab === "thread" ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name="Pause" className="size-3" aria-hidden />
            Auto-send is paused for this thread.
          </p>
        ) : null}
      </div>

      <div
        // Keyed by tab: each switch replays a quick fade/rise, and scroll
        // position resets to the top of the new list.
        key={activeTab}
        className={cn(
          "flex-1 overflow-y-auto p-1",
          "animate-in fade-in-0 slide-in-from-bottom-2 duration-150",
          // In the compact-viewport drawer the shell owns scrolling; a fixed
          // inner cap would clip the list bottom. Fixed-height popover mode
          // lets flex distribute the constant footprint instead.
          compactViewport || fixedHeight ? "min-h-0 max-h-none" : "max-h-72",
          listClassName,
        )}
      >
        {activeTab === "thread" && nativeItems.length > 0 ? (
          <div className="mb-1 border-b border-border pb-1">
            <div className="flex items-center gap-1.5 px-2 py-1">
              <Icon
                name="Sent"
                className="size-3 text-muted-foreground"
                aria-hidden
              />
              <span className="flex-1 text-xs font-medium text-muted-foreground">
                In bb's queue — sends automatically
              </span>
              {nativeItems.length > 1 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-xs"
                  onClick={stashAll}
                  aria-label="Stash all: stop auto-delivery and keep everything here"
                >
                  Stash all
                </Button>
              ) : null}
            </div>
            {nativeItems.map((item) => (
              <div
                key={item.id}
                className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-state-hover"
              >
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
                    onClick={() => sendNative(item)}
                    aria-label="Send now"
                  >
                    <Icon name="Sent" className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => stashNative(item)}
                    aria-label="Stash: move to the Prompts queue so it does not auto-send"
                  >
                    <Icon name="ArrowDown" className="size-3.5" aria-hidden />
                    Stash
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {activeTab === "snippets" ? (
          snippets.length === 0 ? (
            <p className="flex h-full min-h-24 items-center justify-center px-3 py-6 text-center text-sm text-muted-foreground">
              {searchActive
                ? "No snippets match."
                : "No snippets yet. Save reusable prompts here — {{tokens}} become fill-in fields."}
            </p>
          ) : (
            snippets.map((snippet) => (
              <SnippetRow
                key={snippet.id}
                snippet={snippet}
                onInsert={onInsertText === null ? null : insertSnippet}
                onQueue={queueSnippet}
                alwaysShowActions={alwaysShowActions}
                onEdit={(entry) =>
                  setSnippetDraft({
                    id: entry.id,
                    title: entry.title,
                    body: entry.body,
                    keywords: entry.keywords,
                    groupName: entry.groupName ?? "",
                  })
                }
                rpc={rpc}
                refresh={refreshSnippets}
              />
            ))
          )
        ) : list.length === 0 ? (
          <p className="flex h-full min-h-24 items-center justify-center px-3 py-6 text-center text-sm text-muted-foreground">
            {activeTab === "used"
              ? "Nothing used yet."
              : searchActive
                ? "No prompts match."
                : activeTab === "thread" && nativeItems.length > 0
                  ? "Nothing stashed. The messages above send automatically — stash one to hold it."
                  : "No queued prompts. Write one below while the agent works."}
          </p>
        ) : activeTab === "used" ? (
          list.map((prompt) => (
            <div
              key={prompt.id}
              className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-state-hover"
            >
              <div className="min-w-0 flex-1">
                <span className="line-clamp-2 text-sm text-muted-foreground">
                  {previewText(prompt.text)}
                </span>
                <span className="text-xs text-muted-foreground/70">
                  {prompt.usedVia === "auto-send"
                    ? "auto-sent"
                    : prompt.usedVia === "scheduled"
                      ? "scheduled send"
                      : prompt.usedVia === "cross-thread"
                        ? "sent to another thread"
                        : prompt.usedVia === "bb-queue"
                          ? "moved to bb's queue"
                          : "used"}
                  {prompt.scope === "global" ? " · global" : ""}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2 text-xs opacity-0 group-hover:opacity-100"
                onClick={() => void restore(prompt)}
              >
                <Icon
                  name="ArrowTurnBackward"
                  className="size-3.5"
                  aria-hidden
                />
                Restore
              </Button>
            </div>
          ))
        ) : (
          list.map((prompt, index) => (
            <PromptRow
              key={prompt.id}
              prompt={prompt}
              index={index}
              count={list.length}
              canArm={prompt.scope === "thread"}
              threadId={threadId}
              onInject={onInsertText === null ? null : injectPrompt}
              onEdit={(entry) => {
                setEditing(entry);
                setEditText(entry.text);
              }}
              onSchedule={setScheduling}
              onMove={movePrompt}
              onPush={threadId === null ? null : pushToNative}
              onSaveAsSnippet={saveAsSnippet}
              rpc={rpc}
              refresh={refresh}
              dragHandlers={dragHandlers}
              isDragTarget={dragOver === index}
              alwaysShowActions={alwaysShowActions}
            />
          ))
        )}
      </div>

      {activeTab !== "snippets" ? (
        <div className="border-t border-border p-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void add();
              }
            }}
            placeholder="Write a prompt for later…"
            className="min-h-16 resize-none text-sm"
            onFocus={(event) => {
              // Mobile fallback: vaul repositions the drawer for the
              // keyboard, but some webviews miss the visualViewport signal —
              // nudge the field into view once the keyboard settles.
              if (!compactViewport) return;
              const target = event.currentTarget;
              setTimeout(() => {
                target.scrollIntoView({ block: "center", behavior: "smooth" });
              }, 350);
            }}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            {hasThreadTab && activeTab !== "global" ? (
              <label
                className={cn(
                  "inline-flex cursor-pointer select-none items-center gap-2 text-xs transition-colors",
                  armDraft ? "text-primary" : "text-muted-foreground",
                )}
                title="Send automatically when the agent finishes its current work"
              >
                <Switch
                  checked={armDraft}
                  onCheckedChange={(checked) => setArmDraft(checked === true)}
                  aria-label="Auto-send on idle"
                />
                Auto-send on idle
              </label>
            ) : (
              <span />
            )}
            <Button size="sm" disabled={!draft.trim()} onClick={() => void add()}>
              {addScopeLabel}
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit prompt</DialogTitle>
          </DialogHeader>
          <Textarea
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            className="min-h-32"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button disabled={!editText.trim()} onClick={() => void saveEdit()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ScheduleDialog
        prompt={scheduling}
        rpc={rpc}
        refresh={refresh}
        onClose={() => setScheduling(null)}
      />
      <SnippetEditor
        draft={snippetDraft}
        rpc={rpc}
        onSaved={() => {
          refreshSnippets();
          refresh();
        }}
        onClose={() => setSnippetDraft(null)}
      />
      <FillInDialog
        request={fillIn}
        onDone={completeFillIn}
        onCancel={() => setFillIn(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer action button
// ---------------------------------------------------------------------------

function QueueButton() {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const threadId = useComposerThreadId();
  const [open, setOpen] = useState(false);
  const { data } = useQueue(threadId, true);

  // Surface auto-send failures as toasts wherever a composer is mounted.
  const toastedRef = useRef<string | null>(null);
  useRealtime("prompts", (payload) => {
    const signal = payload as {
      kind: string;
      threadId: string | null;
      message?: string;
    };
    if (signal.kind !== "send-failed") return;
    if (threadId !== null && signal.threadId !== threadId) return;
    const key = `${signal.threadId}:${signal.message}`;
    if (toastedRef.current === key) return;
    toastedRef.current = key;
    toast.error(
      `Auto-send failed — prompt re-queued${signal.message ? `: ${signal.message}` : ""}`,
    );
  });

  // Button state, in priority order: failed > paused > armed > queued > idle.
  const pending = data.threadPrompts.length + data.globalPrompts.length;
  const armedCount = data.threadPrompts.filter((p) => p.autoSend).length;
  const failedCount =
    data.threadPrompts.filter((p) => p.lastError !== null).length +
    data.globalPrompts.filter((p) => p.lastError !== null).length;
  const state =
    failedCount > 0
      ? "failed"
      : data.paused && armedCount > 0
        ? "paused"
        : armedCount > 0
          ? "armed"
          : pending > 0
            ? "queued"
            : "idle";
  const stateLabel =
    state === "failed"
      ? `Prompts — ${failedCount} send${failedCount === 1 ? "" : "s"} failed, re-queued`
      : state === "paused"
        ? `Prompts — auto-send paused, ${armedCount} armed`
        : state === "armed"
          ? `Prompts — ${armedCount} of ${pending} armed to auto-send`
          : state === "queued"
            ? `Prompts — ${pending} queued`
            : "Prompts — queue & snippets";

  const insertText = useCallback(
    (text: string): boolean => {
      try {
        composer.updateText((current) =>
          current.trim() ? `${current.trimEnd()}\n\n${text}` : text,
        );
        composer.focus();
      } catch {
        return false;
      }
      setOpen(false);
      return true;
    },
    [composer],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // Self-contained pill: the count lives INSIDE the 28px-tall
          // bounds, so the composer row's clamping can never clip it.
          className={cn(
            "flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border border-input transition-colors hover:bg-state-hover",
            pending > 0 ? "px-1.5" : "w-7",
            open && "bg-state-hover",
            state === "failed"
              ? "text-destructive hover:text-destructive"
              : state === "armed" || state === "paused"
                ? "text-primary hover:text-primary"
                : "text-muted-foreground hover:text-foreground",
          )}
          aria-label={stateLabel}
          title={stateLabel}
        >
          <Icon
            name={
              state === "failed"
                ? "AlertCircle"
                : state === "paused"
                  ? "Pause"
                  : state === "armed"
                    ? "TimeSchedule"
                    : "ListTodo"
            }
            className="size-4"
            aria-hidden
          />
          {pending > 0 ? (
            <span
              className="font-medium leading-none tabular-nums"
              style={{ fontSize: 10 }}
              aria-hidden
            >
              {pending > 99 ? "99+" : pending}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 overflow-hidden p-0 duration-200"
        // Grow from the corner nearest the button instead of zooming from
        // the center — Radix points this var at the anchor.
        style={{
          transformOrigin: "var(--radix-popover-content-transform-origin)",
        }}
        mobileRepositionInputs
      >
        <QueueView
          threadId={threadId}
          onInsertText={insertText}
          fixedHeight
          onOpenManager={() => {
            setOpen(false);
            navigate.toPluginPanel("manager");
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Armed banner
// ---------------------------------------------------------------------------

function ArmedBanner() {
  const view = useComposerView();
  const threadId = useComposerThreadId();
  const { data, refresh, rpc } = useQueue(threadId, threadId !== null);

  const armed = useMemo(
    () => data.threadPrompts.filter((prompt) => prompt.autoSend),
    [data.threadPrompts],
  );
  if (threadId === null || armed.length === 0 || !view.run.isRunning)
    return null;

  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
      <Icon
        name={data.paused ? "Pause" : "TimeSchedule"}
        className="size-3.5 shrink-0 text-primary"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">
        {data.paused
          ? `${armed.length} armed prompt${armed.length === 1 ? "" : "s"} paused`
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

// ---------------------------------------------------------------------------
// Thread panel
// ---------------------------------------------------------------------------

function QueuePanel({ threadId }: { threadId: string }) {
  // No composer in the side panel: manage, arm, schedule — no inject.
  return (
    <QueueView threadId={threadId} onInsertText={null} listClassName="max-h-none" />
  );
}

// ---------------------------------------------------------------------------
// Manager: full-screen nav panel (left sidebar entry)
// ---------------------------------------------------------------------------

interface OverviewThread {
  threadId: string;
  title: string;
  paused: boolean;
  nativeCount: number;
  prompts: PromptDto[];
}

interface OverviewData {
  globalPrompts: PromptDto[];
  threads: OverviewThread[];
  snippets: SnippetDto[];
  recentlyUsed: PromptDto[];
}

function StatTile({
  icon,
  label,
  value,
  accent = false,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  value: number;
  accent?: boolean;
}) {
  const lit = accent && value > 0;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors",
        lit ? "border-primary/30" : "border-border",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
          lit ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon name={icon} className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            "text-lg font-semibold leading-tight tabular-nums",
            lit && "text-primary",
          )}
        >
          {value}
        </p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

/** Icon chip + title + description header used by every manager card. */
function CardHead({
  icon,
  title,
  meta,
  children,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <CardHeader className="flex-row items-center gap-3 space-y-0 p-4 pb-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon name={icon} className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
          {title}
        </CardTitle>
        {meta ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</p>
        ) : null}
      </div>
      {children ? (
        <div className="flex shrink-0 items-center gap-1">{children}</div>
      ) : null}
    </CardHeader>
  );
}

function ManagerSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-16 rounded-lg" />
        ))}
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Skeleton className="h-56 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
        <div className="space-y-4 lg:col-span-2">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

function ManagerRow({
  prompt,
  index,
  count,
  rpc,
  refresh,
  onEdit,
  onSchedule,
  onSaveAsSnippet,
  onSendNow,
  onPush,
}: {
  prompt: PromptDto;
  index: number;
  count: number;
  rpc: Rpc;
  refresh: () => void;
  onEdit: (prompt: PromptDto) => void;
  onSchedule: (prompt: PromptDto) => void;
  onSaveAsSnippet: (prompt: PromptDto) => void;
  onSendNow: ((prompt: PromptDto) => void) | null;
  onPush: ((prompt: PromptDto) => void) | null;
}) {
  async function move(direction: "up" | "down"): Promise<void> {
    // Full-permutation reorder within this prompt's own scope group.
    const { threadPrompts, globalPrompts } = await rpc.call("listPrompts", {
      threadId: prompt.threadId,
    });
    const siblings = prompt.scope === "thread" ? threadPrompts : globalPrompts;
    const from = siblings.findIndex((entry) => entry.id === prompt.id);
    const to = direction === "up" ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    const ordered = [...siblings];
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved!);
    await rpc.call("reorderPrompts", {
      scope: prompt.scope,
      threadId: prompt.threadId,
      ids: ordered.map((entry) => entry.id),
    });
    refresh();
  }

  async function remove(): Promise<void> {
    const { deleted } = await rpc.call("deletePrompt", { id: prompt.id });
    if (!deleted) return;
    refresh();
    toast("Prompt deleted", {
      action: {
        label: "Undo",
        onClick: () =>
          void rpc
            .call("addPrompt", {
              text: prompt.text,
              scope: prompt.scope,
              threadId: prompt.threadId,
              autoSend: prompt.autoSend,
            })
            .then(refresh),
      },
    });
  }

  async function toggleArm(): Promise<void> {
    await rpc.call("updatePrompt", { id: prompt.id, autoSend: !prompt.autoSend });
    refresh();
  }

  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-2 transition-colors hover:bg-state-hover">
      <span className="flex shrink-0 flex-col pt-0.5">
        <button
          type="button"
          className="flex h-4 w-5 items-center justify-center text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-25"
          disabled={index === 0}
          onClick={() => void move("up")}
          aria-label="Move up"
        >
          <Icon name="ChevronUp" className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          className="flex h-4 w-5 items-center justify-center text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-25"
          disabled={index === count - 1}
          onClick={() => void move("down")}
          aria-label="Move down"
        >
          <Icon name="ChevronDown" className="size-3.5" aria-hidden />
        </button>
      </span>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm text-foreground">
          {previewText(prompt.text)}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-xs">
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
          {prompt.lastError !== null ? (
            <span
              className="inline-flex items-center gap-1 text-destructive"
              title={prompt.lastError}
            >
              <Icon name="AlertCircle" className="size-3" aria-hidden />
              send failed — re-queued
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {prompt.scope === "thread" ? (
          <Button
            size="icon"
            variant="ghost"
            className={cn("size-7", prompt.autoSend && "text-primary")}
            onClick={() => void toggleArm()}
            aria-label={prompt.autoSend ? "Disarm auto-send" : "Arm auto-send"}
          >
            <Icon name="TimeSchedule" className="size-3.5" aria-hidden />
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Prompt actions"
            >
              <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onSendNow !== null ? (
              <DropdownMenuItem onSelect={() => onSendNow(prompt)}>
                <Icon name="Sent" className="size-4" aria-hidden />
                Send now
              </DropdownMenuItem>
            ) : null}
            {onPush !== null ? (
              <DropdownMenuItem onSelect={() => onPush(prompt)}>
                <Icon name="ChevronsUp" className="size-4" aria-hidden />
                Push to bb queue
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onEdit(prompt)}>
              <Icon name="Edit" className="size-4" aria-hidden />
              Edit
            </DropdownMenuItem>
            {prompt.scope === "thread" ? (
              <DropdownMenuItem onSelect={() => onSchedule(prompt)}>
                <Icon name="Calendar" className="size-4" aria-hidden />
                {prompt.sendAt === null ? "Schedule…" : "Reschedule…"}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onSaveAsSnippet(prompt)}>
              <Icon name="Star" className="size-4" aria-hidden />
              Save as snippet
            </DropdownMenuItem>
            {prompt.scope === "thread" ? (
              <DropdownMenuItem
                onSelect={() =>
                  void rpc
                    .call("updatePrompt", { id: prompt.id, scope: "global" })
                    .then(refresh)
                }
              >
                <Icon name="ArrowUpDown" className="size-4" aria-hidden />
                Move to global
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
              <Icon name="Trash2" className="size-4" aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ManagerPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [data, setData] = useState<OverviewData | null>(null);
  const [snippetSearch, setSnippetSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [newPrompt, setNewPrompt] = useState("");
  const [editing, setEditing] = useState<PromptDto | null>(null);
  const [editText, setEditText] = useState("");
  const [scheduling, setScheduling] = useState<PromptDto | null>(null);
  const [snippetDraft, setSnippetDraft] = useState<SnippetDraft | null>(null);
  const [fillIn, setFillIn] = useState<FillInRequest | null>(null);

  const refresh = useCallback(() => {
    void rpc
      .call("overview")
      .then((result) => setData(result))
      .catch(() => {});
  }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime("prompts", refresh);

  const stats = useMemo(() => {
    if (!data) return { queued: 0, armed: 0, scheduled: 0, snippets: 0 };
    const all = [...data.globalPrompts, ...data.threads.flatMap((t) => t.prompts)];
    return {
      queued: all.length,
      armed: all.filter((p) => p.autoSend).length,
      scheduled: all.filter((p) => p.sendAt !== null).length,
      snippets: data.snippets.length,
    };
  }, [data]);

  const snippetGroups = useMemo(() => {
    if (!data) return [];
    return [
      ...new Set(
        data.snippets
          .map((snippet) => snippet.groupName)
          .filter((name): name is string => name !== null),
      ),
    ].sort();
  }, [data]);

  const visibleSnippets = useMemo(() => {
    if (!data) return [];
    const query = snippetSearch.trim().toLowerCase();
    return data.snippets.filter((snippet) => {
      if (groupFilter !== null && snippet.groupName !== groupFilter)
        return false;
      if (!query) return true;
      return [snippet.title, snippet.keywords, snippet.body, snippet.groupName ?? ""]
        .join("\n")
        .toLowerCase()
        .includes(query);
    });
  }, [data, snippetSearch, groupFilter]);

  const isEmptyWorkspace =
    data !== null &&
    data.globalPrompts.length === 0 &&
    data.threads.length === 0 &&
    data.snippets.length === 0 &&
    data.recentlyUsed.length === 0;

  function sendNow(prompt: PromptDto): void {
    if (prompt.threadId === null) return;
    void rpc
      .call("sendPromptToThread", { id: prompt.id, threadId: prompt.threadId })
      .then(({ sent, error }) => {
        refresh();
        if (sent) toast.success("Prompt sent");
        else toast.error(error ?? "Send failed");
      });
  }

  function pushToNative(prompt: PromptDto): void {
    if (prompt.threadId === null) return;
    void rpc
      .call("pushToNativeQueue", { id: prompt.id, threadId: prompt.threadId })
      .then(({ pushed, error }) => {
        refresh();
        if (pushed) toast.success("Moved to bb's queue");
        else toast.error(error ?? "Push failed");
      });
  }

  function queueSnippetGlobally(snippet: SnippetDto): void {
    const deliver = (filled: string) => {
      void rpc
        .call("addPrompt", {
          text: filled,
          scope: "global",
          threadId: null,
          autoSend: false,
        })
        .then(() => {
          void rpc.call("useSnippet", { id: snippet.id });
          refresh();
          toast.success(`“${snippet.title}” queued globally`);
        });
    };
    if (extractTokens(snippet.body).length > 0) {
      setFillIn({ text: snippet.body, title: snippet.title, complete: deliver });
    } else {
      deliver(snippet.body);
    }
  }

  async function addGlobalPrompt(): Promise<void> {
    const text = newPrompt.trim();
    if (!text) return;
    await rpc.call("addPrompt", {
      text,
      scope: "global",
      threadId: null,
      autoSend: false,
    });
    setNewPrompt("");
    refresh();
  }

  async function saveEdit(): Promise<void> {
    if (editing === null || !editText.trim()) return;
    await rpc.call("updatePrompt", { id: editing.id, text: editText.trim() });
    setEditing(null);
    refresh();
  }

  const rowHandlers = {
    rpc,
    refresh,
    onEdit: (prompt: PromptDto) => {
      setEditing(prompt);
      setEditText(prompt.text);
    },
    onSchedule: setScheduling,
    onSaveAsSnippet: (prompt: PromptDto) =>
      setSnippetDraft({
        id: null,
        title: previewText(prompt.text).slice(0, 60),
        body: prompt.text,
        keywords: "",
        groupName: "",
      }),
  };

  if (data === null) {
    return (
      <div className="h-full overflow-y-auto p-4 md:p-5">
        <ManagerSkeleton />
      </div>
    );
  }

  if (isEmptyWorkspace) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Icon name="ListTodo" className="size-7" aria-hidden />
          </span>
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold">Nothing queued yet</h2>
            <p className="text-sm text-muted-foreground">
              Stash prompts while agents work, arm them to auto-send when a
              thread goes idle, and keep reusable snippets with{" "}
              <code className="rounded bg-muted px-1">{"{{fill-ins}}"}</code>.
              The queue button lives next to the composer in every thread.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() =>
                setSnippetDraft({
                  id: null,
                  title: "",
                  body: "",
                  keywords: "",
                  groupName: "",
                })
              }
            >
              <Icon name="Star" className="size-3.5" aria-hidden />
              New snippet
            </Button>
          </div>
        </div>
        <SnippetEditor
          draft={snippetDraft}
          rpc={rpc}
          onSaved={refresh}
          onClose={() => setSnippetDraft(null)}
        />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-5xl space-y-4 animate-in fade-in-0 duration-200">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile icon="ListTodo" label="Queued prompts" value={stats.queued} />
          <StatTile
            icon="TimeSchedule"
            label="Armed to auto-send"
            value={stats.armed}
            accent
          />
          <StatTile
            icon="Calendar"
            label="Scheduled"
            value={stats.scheduled}
            accent
          />
          <StatTile icon="Star" label="Snippets" value={stats.snippets} />
        </div>

        <div className="grid items-start gap-4 lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-3">
            <Card>
              <CardHead
                icon="Globe"
                title={
                  <>
                    Global queue
                    {data.globalPrompts.length > 0 ? (
                      <Badge variant="secondary">
                        {data.globalPrompts.length}
                      </Badge>
                    ) : null}
                  </>
                }
                meta="Available to inject in any thread"
              />
              <CardContent className="space-y-2 p-4 pt-0">
                {data.globalPrompts.length === 0 ? (
                  <p className="py-2 text-sm text-muted-foreground">
                    Nothing queued globally. Global prompts can be injected in
                    any thread.
                  </p>
                ) : (
                  <div>
                    {data.globalPrompts.map((prompt, index) => (
                      <ManagerRow
                        key={prompt.id}
                        prompt={prompt}
                        index={index}
                        count={data.globalPrompts.length}
                        onSendNow={null}
                        onPush={null}
                        {...rowHandlers}
                      />
                    ))}
                  </div>
                )}
                <div className="flex items-end gap-2 border-t border-border pt-3">
                  <Textarea
                    value={newPrompt}
                    onChange={(event) => setNewPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void addGlobalPrompt();
                      }
                    }}
                    placeholder="Write a prompt for later…"
                    className="min-h-14 flex-1 resize-none text-sm"
                  />
                  <Button
                    size="sm"
                    disabled={!newPrompt.trim()}
                    onClick={() => void addGlobalPrompt()}
                  >
                    Queue
                  </Button>
                </div>
              </CardContent>
            </Card>

            {data?.threads.map((thread) => (
              <Card key={thread.threadId}>
                <CardHead
                  icon="MessageSquare"
                  title={
                    <>
                      <button
                        type="button"
                        className="min-w-0 truncate text-left transition-colors hover:text-primary"
                        onClick={() => navigate.toThread(thread.threadId)}
                      >
                        {thread.title}
                      </button>
                      <Badge variant="secondary">{thread.prompts.length}</Badge>
                      {thread.paused ? (
                        <Badge variant="outline" className="gap-1">
                          <Icon name="Pause" className="size-2.5" aria-hidden />
                          paused
                        </Badge>
                      ) : null}
                    </>
                  }
                  meta={
                    thread.nativeCount > 0
                      ? `${thread.nativeCount} in bb's queue send automatically — plus ${thread.prompts.length} stashed here`
                      : `${thread.prompts.length} stashed prompt${thread.prompts.length === 1 ? "" : "s"}`
                  }
                >
                  {thread.prompts.some((p) => !p.autoSend) ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() =>
                            void rpc
                              .call("armAll", { threadId: thread.threadId })
                              .then(refresh)
                          }
                        >
                          <Icon name="Play" className="size-3" aria-hidden />
                          Run queue
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Arm everything — sends in order as the agent idles
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {thread.prompts.some((p) => p.autoSend) ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() =>
                            void rpc
                              .call("setPaused", {
                                threadId: thread.threadId,
                                paused: !thread.paused,
                              })
                              .then(refresh)
                          }
                        >
                          <Icon
                            name={thread.paused ? "Play" : "Pause"}
                            className="size-3"
                            aria-hidden
                          />
                          {thread.paused ? "Resume" : "Pause"}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {thread.paused
                          ? "Let armed prompts send again"
                          : "Hold armed prompts without disarming them"}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        onClick={() => navigate.toThread(thread.threadId)}
                        aria-label="Open thread"
                      >
                        <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Open thread</TooltipContent>
                  </Tooltip>
                </CardHead>
                <CardContent className="p-4 pt-0">
                  {thread.prompts.map((prompt, index) => (
                    <ManagerRow
                      key={prompt.id}
                      prompt={prompt}
                      index={index}
                      count={thread.prompts.length}
                      onSendNow={sendNow}
                      onPush={pushToNative}
                      {...rowHandlers}
                    />
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="space-y-4 lg:col-span-2">
            <Card>
              <CardHead
                icon="Star"
                title="Snippets"
                meta="Reusable prompts — {{tokens}} become fill-in fields"
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    setSnippetDraft({
                      id: null,
                      title: "",
                      body: "",
                      keywords: "",
                      groupName: "",
                    })
                  }
                >
                  <Icon name="Plus" className="size-3" aria-hidden />
                  New
                </Button>
              </CardHead>
              <CardContent className="space-y-2 p-4 pt-0">
                <div className="relative">
                  <Icon
                    name="Search"
                    className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    value={snippetSearch}
                    onChange={(event) => setSnippetSearch(event.target.value)}
                    placeholder="Search snippets…"
                    className="h-8 pl-8 text-sm"
                  />
                </div>
                {snippetGroups.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {snippetGroups.map((group) => (
                      <button
                        key={group}
                        type="button"
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-xs transition-colors",
                          groupFilter === group
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
                        )}
                        onClick={() =>
                          setGroupFilter((current) =>
                            current === group ? null : group,
                          )
                        }
                        aria-pressed={groupFilter === group}
                      >
                        {group}
                      </button>
                    ))}
                  </div>
                ) : null}
                {visibleSnippets.length === 0 ? (
                  <p className="py-2 text-sm text-muted-foreground">
                    {snippetSearch.trim()
                      ? "No snippets match."
                      : "No snippets yet — save reusable prompts here."}
                  </p>
                ) : (
                  visibleSnippets.map((snippet) => (
                    <div
                      key={snippet.id}
                      className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 text-sm font-medium">
                          <span className="truncate">{snippet.title}</span>
                          {snippet.groupName ? (
                            <Badge
                              variant="secondary"
                              className="shrink-0 px-1.5"
                              style={{ fontSize: 10 }}
                            >
                              {snippet.groupName}
                            </Badge>
                          ) : null}
                        </p>
                        <p className="line-clamp-1 text-xs text-muted-foreground">
                          {previewText(snippet.body)}
                        </p>
                        {snippet.useCount > 0 ? (
                          <p className="text-xs text-muted-foreground/60">
                            used {snippet.useCount}×
                          </p>
                        ) : null}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7 shrink-0"
                            aria-label="Snippet actions"
                          >
                            <Icon
                              name="MoreHorizontal"
                              className="size-3.5"
                              aria-hidden
                            />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => queueSnippetGlobally(snippet)}
                          >
                            <Icon name="ListTodo" className="size-4" aria-hidden />
                            Queue globally
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              setSnippetDraft({
                                id: snippet.id,
                                title: snippet.title,
                                body: snippet.body,
                                keywords: snippet.keywords,
                                groupName: snippet.groupName ?? "",
                              })
                            }
                          >
                            <Icon name="Edit" className="size-4" aria-hidden />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() =>
                              void rpc
                                .call("deleteSnippet", { id: snippet.id })
                                .then(refresh)
                            }
                          >
                            <Icon name="Trash2" className="size-4" aria-hidden />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHead
                icon="Clock"
                title="Recently used"
                meta="Consumed prompts — restore any of them"
              />
              <CardContent className="p-4 pt-0">
                {data.recentlyUsed.length === 0 ? (
                  <p className="py-2 text-sm text-muted-foreground">
                    Nothing used yet.
                  </p>
                ) : (
                  data.recentlyUsed.slice(0, 12).map((prompt) => (
                    <div
                      key={prompt.id}
                      className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm text-muted-foreground">
                          {previewText(prompt.text)}
                        </p>
                        <p className="text-xs text-muted-foreground/60">
                          {prompt.usedVia === "auto-send"
                            ? "auto-sent"
                            : prompt.usedVia === "scheduled"
                              ? "scheduled send"
                              : prompt.usedVia === "bb-queue"
                                ? "moved to bb's queue"
                                : prompt.usedVia === "cross-thread"
                                  ? "sent to another thread"
                                  : "used"}
                          {prompt.usedAt ? ` · ${formatWhen(prompt.usedAt)}` : ""}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 shrink-0 px-2 text-xs opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() =>
                          void rpc
                            .call("restorePrompt", { id: prompt.id })
                            .then(refresh)
                        }
                      >
                        <Icon
                          name="ArrowTurnBackward"
                          className="size-3.5"
                          aria-hidden
                        />
                        Restore
                      </Button>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit prompt</DialogTitle>
          </DialogHeader>
          <Textarea
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            className="min-h-32"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button disabled={!editText.trim()} onClick={() => void saveEdit()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ScheduleDialog
        prompt={scheduling}
        rpc={rpc}
        refresh={refresh}
        onClose={() => setScheduling(null)}
      />
      <SnippetEditor
        draft={snippetDraft}
        rpc={rpc}
        onSaved={refresh}
        onClose={() => setSnippetDraft(null)}
      />
      <FillInDialog
        request={fillIn}
        onDone={(filled) => {
          const request = fillIn;
          setFillIn(null);
          request?.complete(filled);
        }}
        onCancel={() => setFillIn(null)}
      />
    </div>
    </TooltipProvider>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "prompts",
    actions: [{ id: "queue", component: QueueButton }],
    banners: [{ id: "armed", component: ArmedBanner }],
    plusMenu: [
      {
        id: "queue-draft",
        label: "Queue current draft",
        description: "Save the draft for later and clear the composer",
        icon: "ListTodo",
        run: ({ composer, view }) => {
          const text = composer.text.trim();
          if (!text) {
            toast("Nothing to queue — the draft is empty");
            return;
          }
          const threadId = composerThreadIdFromScope(view.scope);
          void callRpcDirect("addPrompt", {
            text,
            scope: threadId === null ? "global" : "thread",
            threadId,
            autoSend: false,
          })
            .then(() => {
              composer.clear();
              toast.success(
                threadId === null
                  ? "Draft queued globally"
                  : "Draft queued for this thread",
              );
            })
            .catch((error: unknown) => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "Failed to queue the draft",
              );
            });
        },
      },
      {
        id: "save-snippet",
        label: "Save draft as snippet",
        description: "Keep the draft as a reusable prompt (does not clear it)",
        icon: "Star",
        run: ({ composer }) => {
          const text = composer.text.trim();
          if (!text) {
            toast("Nothing to save — the draft is empty");
            return;
          }
          const title = previewText(text).slice(0, 60);
          void callRpcDirect("addSnippet", { title, body: text })
            .then(() => {
              toast.success(`Snippet saved: “${title}” — edit it in the Prompts popover`);
            })
            .catch((error: unknown) => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "Failed to save the snippet",
              );
            });
        },
      },
    ],
  });

  app.slots.threadPanelAction({
    id: "queue",
    title: "Prompts",
    icon: "ListTodo",
    component: ({ threadId }) => <QueuePanel threadId={threadId} />,
  });

  app.slots.navPanel({
    id: "manager",
    title: "Prompts",
    icon: "ListTodo",
    path: "manager",
    component: ManagerPanel,
  });
});
