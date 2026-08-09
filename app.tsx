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
} from "react";
import {
  definePluginApp,
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
  usedVia: "inject" | "auto-send" | "cli" | "scheduled" | "cross-thread" | null;
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
      <Icon
        name="DragDropVertical"
        className={cn(
          "mt-1 size-3 shrink-0 cursor-grab text-muted-foreground/40 group-hover:opacity-100",
          alwaysShowActions ? "opacity-100" : "opacity-0",
        )}
        aria-hidden
      />
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
            <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px]">
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
}: {
  threadId: string | null;
  /** Receives final text (fill-ins resolved); null = no composer here. */
  onInsertText: ((text: string) => boolean) | null;
  className?: string;
  listClassName?: string;
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

  useEffect(() => {
    if (activeTab === "snippets") refreshSnippets();
  }, [activeTab, refreshSnippets]);
  useRealtime("prompts", () => {
    if (activeTab === "snippets") refreshSnippets();
  });

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
    <div className={cn("flex flex-col", className)}>
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
        className={cn(
          "flex-1 overflow-y-auto p-1",
          // In the compact-viewport drawer the shell owns scrolling; a fixed
          // inner cap would clip the list bottom instead.
          compactViewport ? "max-h-none" : "max-h-72",
          listClassName,
        )}
      >
        {activeTab === "snippets" ? (
          snippets.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
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
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {activeTab === "used"
              ? "Nothing used yet."
              : searchActive
                ? "No prompts match."
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
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            {hasThreadTab && activeTab !== "global" ? (
              <button
                type="button"
                className={cn(
                  "inline-flex items-center gap-1.5 text-xs transition-colors",
                  armDraft
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setArmDraft((value) => !value)}
                title="Send automatically when the agent finishes its current work"
              >
                <Icon name="TimeSchedule" className="size-3.5" aria-hidden />
                {armDraft ? "Will auto-send on idle" : "Auto-send on idle"}
              </button>
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

  const pending = data.threadPrompts.length + data.globalPrompts.length;

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
          className={cn(
            "relative flex h-7 w-7 items-center justify-center rounded-md border border-input",
            "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
          )}
          aria-label={
            pending > 0 ? `Prompts (${pending} queued)` : "Prompts"
          }
          title="Prompts — queue & snippets"
        >
          <Icon name="ListTodo" className="size-4" aria-hidden />
          {pending > 0 ? (
            <span
              className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium leading-none text-primary-foreground"
              aria-hidden
            >
              {pending > 9 ? "9+" : pending}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <QueueView threadId={threadId} onInsertText={insertText} />
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
});
