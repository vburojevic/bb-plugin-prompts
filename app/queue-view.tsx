// The queue + snippets view shared by the composer popovers and the thread
// side panel.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { hasTokens } from "../lib/template";
import { createPromptActions, createReorder } from "./actions";
import {
  FillInDialog,
  PromptEditor,
  ScheduleAtDialog,
  ScheduleDialog,
  SnippetEditor,
  type FillInRequest,
  type SnippetDraft,
} from "./dialogs";
import {
  canSchedule,
  defaultQueueTarget,
  queueTargets,
  targetInput,
  type QueueTarget,
} from "./queue-target";
import { NativeQueueRow, PromptRow, SnippetRow, UsedPromptRow } from "./rows";
import {
  formatRelative,
  formatWhen,
  previewText,
  useQueue,
  useSnippets,
  usePromptSignal,
  type NativeQueueItem,
  type PromptDto,
  type Scope,
  type SnippetDto,
} from "./shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@/components/ui/hooks/use-pointer-coarse";
import { cn } from "@/lib/utils";

/**
 * Which halves of the plugin a QueueView shows. The composer is tight, so it
 * gets two focused buttons — one queue, one library — instead of one popover
 * asking you to find the right tab. Roomier surfaces still show everything.
 */
export type Surface = "all" | "queue" | "snippets";

type Tab = "thread" | "project" | "global" | "snippets" | "used";

export function QueueView({
  threadId,
  projectId,
  onInsertText,
  className,
  listClassName,
  fixedHeight = false,
  onOpenManager = null,
  surface = "all",
}: {
  threadId: string | null;
  projectId: string | null;
  /** Receives final text (fill-ins resolved); null = no composer here. */
  onInsertText: ((text: string) => boolean) | null;
  className?: string;
  listClassName?: string;
  surface?: Surface;
  /**
   * Desktop popover mode: constant overall height so switching tabs never
   * changes the panel's footprint (the popover opens upward — a height change
   * would make the top edge jump instead of growing from the anchor).
   */
  fixedHeight?: boolean;
  /** Renders an expand button that jumps to the full manager screen. */
  onOpenManager?: (() => void) | null;
}) {
  const { data, state, refresh, rpc } = useQueue({ threadId, projectId });
  const [tab, setTab] = useState<Tab>(
    surface === "snippets" ? "snippets" : threadId !== null ? "thread" : projectId !== null ? "project" : "global",
  );
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [armDraft, setArmDraft] = useState(false);
  const [editing, setEditing] = useState<PromptDto | null>(null);
  const [scheduling, setScheduling] = useState<PromptDto | null>(null);
  const [snippetDraft, setSnippetDraft] = useState<SnippetDraft | null>(null);
  const [fillIn, setFillIn] = useState<FillInRequest | null>(null);
  const [nativeItems, setNativeItems] = useState<NativeQueueItem[]>([]);
  /** A time chosen for the prompt being written, before it is queued. */
  const [draftSendAt, setDraftSendAt] = useState<number | null>(null);
  const [pickTime, setPickTime] = useState<
    | { title: string; detail?: string; apply: (sendAt: number) => void }
    | null
  >(null);
  const pointerCoarse = usePointerCoarse();
  const compactViewport = useIsCompactViewport();
  const alwaysShowActions = pointerCoarse || compactViewport;
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  // A single-view surface pins its tab; the tab strip is hidden there, so a
  // stale `tab` from a prop change must never win.
  const hasThreadTab = threadId !== null && surface !== "snippets";
  const hasProjectTab = projectId !== null && surface !== "snippets";
  const activeTab: Tab =
    surface === "snippets"
      ? "snippets"
      : surface === "queue" && tab === "snippets"
        ? "global"
        : tab === "thread" && !hasThreadTab
          ? hasProjectTab
            ? "project"
            : "global"
          : tab === "project" && !hasProjectTab
            ? "global"
            : tab;

  const snippetsActive = activeTab === "snippets";
  const {
    snippets,
    total: snippetTotal,
    state: snippetState,
    refresh: refreshSnippets,
  } = useSnippets(rpc, search, projectId, snippetsActive);

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
    if (activeTab === "thread") refreshNative();
  }, [activeTab, refreshNative]);
  usePromptSignal(["native"], { threadId, projectId }, refreshNative);
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

  const list = useMemo(() => {
    switch (activeTab) {
      case "thread":
        return filter(data.threadPrompts);
      case "project":
        return filter(data.projectPrompts);
      case "global":
        return filter(data.globalPrompts);
      case "used":
        return filter(data.recentlyUsed);
      default:
        return [];
    }
  }, [activeTab, data, filter]);

  const armedCount = data.threadPrompts.filter((prompt) => prompt.autoSend).length;
  const searchActive = search.trim().length > 0;
  // Where the write box below the list puts a new prompt. A visible queue is
  // its own answer; the tabs that are not a queue (Used, Snippets) fall back to
  // the most specific scope this surface actually has.
  const writeScope: Scope =
    activeTab === "thread" && hasThreadTab
      ? "thread"
      : activeTab === "project" && hasProjectTab
        ? "project"
        : activeTab === "global"
          ? "global"
          : hasThreadTab
            ? "thread"
            : hasProjectTab
              ? "project"
              : "global";
  const reorderScope: Scope =
    activeTab === "thread" ? "thread" : activeTab === "project" ? "project" : "global";
  /**
   * Where a snippet goes. Deliberately NOT derived from the visible tab: the
   * snippets popover has no tab strip at all, and it used to fall through to
   * the global queue even when opened from inside a thread.
   */
  const snippetTargets = useMemo(
    () => queueTargets(threadId, projectId),
    [threadId, projectId],
  );
  const reorder = useMemo(() => createReorder(rpc, refresh), [rpc, refresh]);

  // ---- insert / consume ----

  function deliverText(text: string): boolean {
    return onInsertText === null ? false : onInsertText(text);
  }

  function withFillIns(
    text: string,
    title: string,
    deliver: (filled: string) => void,
  ): void {
    if (hasTokens(text)) {
      setFillIn({ text, title, complete: deliver });
      return;
    }
    deliver(text);
  }

  function injectPrompt(prompt: PromptDto): void {
    withFillIns(prompt.text, previewText(prompt.text).slice(0, 40), (text) => {
      if (!deliverText(text)) return;
      void rpc
        .call("consumePrompt", { id: prompt.id, via: "inject" })
        .then(() => {
          refresh();
          toast.success("Prompt added to the composer", {
            action: {
              label: "Keep queued",
              onClick: () =>
                void rpc.call("restorePrompt", { id: prompt.id }).then(refresh),
            },
          });
        });
    });
  }

  function insertSnippet(snippet: SnippetDto): void {
    withFillIns(snippet.body, snippet.title, (filled) => {
      if (!deliverText(filled)) return;
      void rpc.call("useSnippet", { id: snippet.id });
      toast.success(`“${snippet.title}” inserted`);
    });
  }

  /** Snippet → queue: works everywhere, composer or not. */
  function queueSnippet(
    snippet: SnippetDto,
    target: QueueTarget,
    sendAt: number | null = null,
  ): void {
    withFillIns(snippet.body, snippet.title, (filled) => {
      void rpc
        .call("addPrompt", {
          text: filled,
          ...targetInput(target),
          autoSend: false,
          sendAt: canSchedule(target) ? sendAt : null,
        })
        .then(({ prompt, error }) => {
          if (!prompt) {
            toast.error(error ?? "Failed to queue the snippet");
            return;
          }
          void rpc.call("useSnippet", { id: snippet.id });
          refresh();
          toast.success(
            sendAt !== null && canSchedule(target)
              ? `“${snippet.title}” queued for ${target.phrase} — sends ${formatRelative(sendAt)}`
              : `“${snippet.title}” queued for ${target.phrase}`,
          );
        })
        .catch(() => toast.error("Failed to queue the snippet"));
    });
  }

  /** Pick a time first, then queue. */
  function queueSnippetLater(snippet: SnippetDto, target: QueueTarget): void {
    setPickTime({
      title: `Queue “${snippet.title}” for later`,
      detail: previewText(snippet.body).slice(0, 140),
      apply: (sendAt) => queueSnippet(snippet, target, sendAt),
    });
  }

  // ---- add / restore ----

  async function add(): Promise<void> {
    const text = draft.trim();
    if (!text) return;
    const sendAt = writeScope === "thread" ? draftSendAt : null;
    const { prompt, error } = await rpc.call("addPrompt", {
      text,
      scope: writeScope,
      threadId: writeScope === "thread" ? threadId : null,
      projectId: writeScope === "project" ? projectId : null,
      autoSend: armDraft && writeScope === "thread",
      sendAt,
    });
    if (!prompt) {
      toast.error(error ?? "Could not queue that prompt");
      return;
    }
    setDraft("");
    setArmDraft(false);
    setDraftSendAt(null);
    refresh();
    if (sendAt !== null)
      toast.success(`Queued — sends ${formatRelative(sendAt)}`);
    if (activeTab === "used" || activeTab === "snippets") setTab(writeScope);
  }

  const actions = useMemo(
    () =>
      createPromptActions({
        rpc,
        refresh,
        threadId,
        projectId,
        onEdit: setEditing,
        onSchedule: setScheduling,
        onSaveAsSnippet: (prompt) =>
          setSnippetDraft({
            id: null,
            title: previewText(prompt.text).slice(0, 60),
            body: prompt.text,
            keywords: "",
            groupName: "",
            projectId: null,
          }),
      }),
    [rpc, refresh, threadId, projectId],
  );

  // ---- reorder ----

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
    void reorder(
      {
        scope: reorderScope,
        threadId: reorderScope === "thread" ? threadId : null,
        projectId: reorderScope === "project" ? projectId : null,
      },
      ordered.map((prompt) => prompt.id),
    );
  }

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
      void reorder(
        {
          scope: reorderScope,
          threadId: reorderScope === "thread" ? threadId : null,
          projectId: reorderScope === "project" ? projectId : null,
        },
        ordered.map((prompt) => prompt.id),
      );
    },
  };

  // ---- bb native queue bridge ----

  function pushToNative(prompt: PromptDto): void {
    if (threadId === null) return;
    withFillIns(prompt.text, previewText(prompt.text).slice(0, 40), (text) => {
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
      // Fill-ins resolved? Persist the filled text before pushing so the native
      // queue receives the final prompt, not the template.
      if (text !== prompt.text)
        void rpc.call("updatePrompt", { id: prompt.id, text }).then(send);
      else void send();
    });
  }

  function stashAll(): void {
    if (threadId === null) return;
    void rpc
      .call("stashAllNative", { threadId })
      .then(({ stashed, skipped, error }) => {
        refresh();
        refreshNative();
        if (error) {
          toast.error(error);
          return;
        }
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

  const listBody = (() => {
    if (snippetsActive) {
      if (snippetState === "loading")
        return <ListSkeleton rows={3} />;
      if (snippetState === "error")
        return (
          <ListError onRetry={refreshSnippets}>
            Could not load your snippets.
          </ListError>
        );
      if (snippets.length === 0)
        return (
          <ListEmpty>
            {searchActive
              ? "No snippets match."
              : "No snippets yet. Save reusable prompts here — {{tokens}} become fill-in fields."}
          </ListEmpty>
        );
      return (
        <>
          {snippets.map((snippet) => (
            <SnippetRow
              key={snippet.id}
              snippet={snippet}
              alwaysShowActions={alwaysShowActions}
              actions={{
                onInsert: onInsertText === null ? null : insertSnippet,
                onQueue: queueSnippet,
                targets: snippetTargets,
                onQueueLater: threadId === null ? null : queueSnippetLater,
                loadTargets: actions.loadTargets,
                onEdit: (entry) =>
                  setSnippetDraft({
                    id: entry.id,
                    title: entry.title,
                    body: entry.body,
                    keywords: entry.keywords,
                    groupName: entry.groupName ?? "",
                    projectId: entry.projectId,
                  }),
                onDelete: (entry) => {
                  void rpc.call("deleteSnippet", { id: entry.id }).then(() => {
                    refreshSnippets();
                    toast("Snippet deleted", {
                      action: {
                        label: "Undo",
                        onClick: () =>
                          void rpc
                            .call("addSnippet", {
                              title: entry.title,
                              body: entry.body,
                              description: entry.description,
                              keywords: entry.keywords,
                              groupName: entry.groupName,
                              projectId: entry.projectId,
                            })
                            .then(refreshSnippets),
                      },
                    });
                  });
                },
              }}
            />
          ))}
          {snippetTotal > snippets.length ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {`${snippetTotal - snippets.length} more — narrow the search to see them.`}
            </p>
          ) : null}
        </>
      );
    }

    if (state === "loading") return <ListSkeleton rows={3} />;
    if (state === "error")
      return <ListError onRetry={refresh}>Could not load the queue.</ListError>;

    if (list.length === 0)
      return (
        <ListEmpty>
          {activeTab === "used"
            ? "Nothing used yet."
            : searchActive
              ? "No prompts match."
              : activeTab === "thread" && nativeItems.length > 0
                ? "Nothing stashed. The messages above send automatically — stash one to hold it."
                : activeTab === "project"
                  ? "Nothing queued for this project. Prompts kept here outlive any single thread."
                  : "No queued prompts. Write one below while the agent works."}
        </ListEmpty>
      );

    if (activeTab === "used")
      return list.map((prompt) => (
        <UsedPromptRow
          key={prompt.id}
          prompt={prompt}
          onRestore={(entry) => void actions.restore(entry)}
        />
      ));

    return list.map((prompt, index) => (
      <PromptRow
        key={prompt.id}
        prompt={prompt}
        index={index}
        count={list.length}
        available={{ threadId, projectId }}
        alwaysShowActions={alwaysShowActions}
        dragHandlers={dragHandlers}
        isDragTarget={dragOver === index}
        actions={{
          onInject: onInsertText === null ? null : injectPrompt,
          onSendNow:
            prompt.scope === "thread" && prompt.threadId !== null
              ? (entry) =>
                  void actions.sendToThread(entry, entry.threadId!)
              : null,
          onPush: threadId === null ? null : pushToNative,
          onEdit: actions.onEdit,
          onSchedule: actions.onSchedule,
          onSaveAsSnippet: actions.onSaveAsSnippet,
          onToggleArm: (entry) => void actions.toggleArm(entry),
          onMove: movePrompt,
          onChangeScope: (entry, scope) => void actions.changeScope(entry, scope),
          onSendToThread: (entry, target) =>
            void actions.sendToThread(entry, target),
          onDelete: (entry) => void actions.remove(entry),
          loadTargets: actions.loadTargets,
        }}
      />
    ));
  })();

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
      <div className="flex flex-col gap-2 border-b border-border p-2">
        {surface === "snippets" ? null : (
          <Tabs
            value={activeTab}
            onValueChange={(value) => setTab(value as Tab)}
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
              {hasProjectTab ? (
                <TabsTrigger value="project" className="flex-1">
                  Project
                  {data.projectPrompts.length > 0 ? (
                    <Badge variant="secondary" className="ml-1.5 px-1.5">
                      {data.projectPrompts.length}
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
              {surface === "all" ? (
                <TabsTrigger value="snippets" className="flex-1">
                  Snippets
                </TabsTrigger>
              ) : null}
              <TabsTrigger value="used" className="flex-1">
                Used
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
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
            placeholder={snippetsActive ? "Search snippets…" : "Filter prompts…"}
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
                    onClick={() =>
                      void rpc
                        .call("setPaused", { threadId, paused: !data.paused })
                        .then(refresh)
                    }
                    aria-label={data.paused ? "Resume auto-send" : "Pause auto-send"}
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
                    onClick={() =>
                      void rpc.call("disarmThread", { threadId }).then(refresh)
                    }
                  >
                    Disarm all
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
          {snippetsActive ? (
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
                  projectId: null,
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
              <NativeQueueRow
                key={item.id}
                item={item}
                onSend={sendNative}
                onStash={stashNative}
                alwaysShowActions={alwaysShowActions}
              />
            ))}
          </div>
        ) : null}
        {listBody}
      </div>

      {!snippetsActive ? (
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
              // Mobile fallback: vaul repositions the drawer for the keyboard,
              // but some webviews miss the visualViewport signal — nudge the
              // field into view once the keyboard settles.
              if (!compactViewport) return;
              const target = event.currentTarget;
              setTimeout(() => {
                target.scrollIntoView({ block: "center", behavior: "smooth" });
              }, 350);
            }}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            {writeScope === "thread" ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
                {draftSendAt === null ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() =>
                      setPickTime({
                        title: "Send this prompt later",
                        detail: draft.trim() || undefined,
                        apply: setDraftSendAt,
                      })
                    }
                  >
                    <Icon name="Calendar" className="size-3" aria-hidden />
                    Send later…
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-primary">
                    <Icon name="Calendar" className="size-3" aria-hidden />
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() =>
                        setPickTime({
                          title: "Send this prompt later",
                          detail: draft.trim() || undefined,
                          apply: setDraftSendAt,
                        })
                      }
                      title={formatWhen(draftSendAt)}
                    >
                      sends {formatRelative(draftSendAt)}
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setDraftSendAt(null)}
                      aria-label="Clear the send time"
                    >
                      <Icon name="X" className="size-3" aria-hidden />
                    </button>
                  </span>
                )}
              </div>
            ) : (
              <span />
            )}
            <Button size="sm" disabled={!draft.trim()} onClick={() => void add()}>
              {writeScope === "thread"
                ? "Queue for this thread"
                : writeScope === "project"
                  ? "Queue for this project"
                  : "Queue globally"}
            </Button>
          </div>
        </div>
      ) : null}

      <PromptEditor
        prompt={editing}
        rpc={rpc}
        refresh={refresh}
        onClose={() => setEditing(null)}
      />
      <ScheduleDialog
        prompt={scheduling}
        rpc={rpc}
        refresh={refresh}
        onClose={() => setScheduling(null)}
      />
      <SnippetEditor
        draft={snippetDraft}
        rpc={rpc}
        projectId={projectId}
        onSaved={() => {
          refreshSnippets();
          refresh();
        }}
        onClose={() => setSnippetDraft(null)}
      />
      <FillInDialog
        request={fillIn}
        rpc={rpc}
        onDone={(filled) => {
          const request = fillIn;
          setFillIn(null);
          request?.complete(filled);
        }}
        onCancel={() => setFillIn(null)}
      />
      <ScheduleAtDialog
        request={pickTime}
        onPick={(sendAt) => {
          const request = pickTime;
          setPickTime(null);
          request?.apply(sendAt);
        }}
        onCancel={() => setPickTime(null)}
      />
    </div>
  );
}

function scopeWord(scope: Scope): string {
  return scope === "thread"
    ? "this thread"
    : scope === "project"
      ? "this project"
      : "everywhere";
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-1 p-1">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 rounded-md" />
      ))}
    </div>
  );
}

function ListEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="flex h-full min-h-24 items-center justify-center px-3 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * A failed fetch is not an empty queue. Saying "no queued prompts" when the
 * server did not answer is how someone retypes a prompt they already saved.
 */
function ListError({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 px-3 py-6 text-center">
      <p className="text-sm text-muted-foreground">{children}</p>
      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onRetry}>
        <Icon name="RotateCcw" className="size-3.5" aria-hidden />
        Try again
      </Button>
    </div>
  );
}
