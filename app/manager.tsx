// The Prompts manager: every queue in one place, and the snippet library.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { hasTokens } from "../lib/template";
import type { rpcContract } from "../lib/contract";
import { createPromptActions, createReorder } from "./actions";
import { queueTargets, targetInput, type QueueTarget } from "./queue-target";
import {
  FillInDialog,
  PromptEditor,
  ScheduleDialog,
  SnippetEditor,
  type FillInRequest,
  type SnippetDraft,
} from "./dialogs";
import { PromptRow, SnippetRow, UsedPromptRow } from "./rows";
import {
  formatWhen,
  previewText,
  useSnippetGroups,
  usePromptSignal,
  type PromptDto,
  type Rpc,
  type Scope,
  type SnippetDto,
  type SuggestionDto,
} from "./shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface OverviewThread {
  threadId: string;
  title: string;
  projectId: string | null;
  paused: boolean;
  nativeCount: number;
  prompts: PromptDto[];
}

interface OverviewProject {
  projectId: string;
  name: string;
  prompts: PromptDto[];
}

interface OverviewData {
  globalPrompts: PromptDto[];
  projects: OverviewProject[];
  threads: OverviewThread[];
  snippets: SnippetDto[];
  snippetTotal: number;
  recentlyUsed: PromptDto[];
  hiddenThreads: number;
  hiddenProjects: number;
}

/**
 * A section header: label, count, rule, actions. The manager used to be a grid
 * of same-size cards — icon, heading, body — which made every region look
 * equally important and none of them scannable. One flat vocabulary of
 * sections lets the content set the hierarchy instead.
 */
function Section({
  title,
  count,
  meta,
  actions,
  /**
   * UI labels are set in caps; a section titled with user content (a thread
   * name) keeps its own casing — shouting someone's thread title back at them
   * is a category error.
   */
  kind = "label",
  children,
}: {
  title: string;
  count?: number;
  meta?: ReactNode;
  actions?: ReactNode;
  kind?: "label" | "content";
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <header className="flex min-h-7 items-center gap-2">
        {/* The title yields first: actions must stay reachable at any width. */}
        <h2
          className={cn(
            "min-w-0 truncate text-xs font-medium text-muted-foreground",
            kind === "label" ? "uppercase tracking-wider" : "text-foreground/80",
          )}
        >
          {title}
        </h2>
        {count !== undefined && count > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">
            {count}
          </span>
        ) : null}
        <Separator className="hidden min-w-4 flex-1 sm:block" />
        {meta ? (
          <span className="hidden shrink-0 truncate text-xs text-muted-foreground/70 sm:inline">
            {meta}
          </span>
        ) : null}
        {actions ? (
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:ml-0">
            {actions}
          </div>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** Empty state that teaches the section rather than announcing the void. */
function SectionEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function ManagerSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <Skeleton className="h-8 w-56 rounded-md" />
      <Skeleton className="h-20 rounded-lg" />
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-24 rounded" />
        <Skeleton className="h-11 rounded-md" />
        <Skeleton className="h-11 rounded-md" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-32 rounded" />
        <Skeleton className="h-11 rounded-md" />
      </div>
    </div>
  );
}

interface SuggestionsData {
  suggestions: SuggestionDto[];
  analyzed: number;
  considered: number;
  dropped: number;
  computedAt: number;
  dismissedCount: number;
  computing: boolean;
  enabled: boolean;
  lastError: string | null;
}

/**
 * Prompts this user keeps retyping, mined from bb's own prompt history and
 * offered as snippets.
 *
 * "Add" opens the ordinary snippet editor rather than saving straight off: a
 * mined body carries whatever typos the original prompt had, and the proposed
 * title is a guess. Dismissals are remembered so a proposal only has to be
 * turned down once.
 */
function SuggestionsSection({
  rpc,
  onAdd,
  onChanged,
}: {
  rpc: Rpc;
  onAdd: (draft: SnippetDraft) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<SuggestionsData | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // The read is instant: the server answers from its cache and mines in the
  // background, announcing the result over realtime. "Busy" therefore tracks
  // that background scan, not this call.
  const load = useCallback(
    (refresh: boolean, quiet = false) => {
      if (!quiet) setBusy(true);
      void rpc
        .call("suggestSnippets", { refresh })
        .then((result) => {
          setData(result);
          setBusy(result.computing);
          setFailed(false);
        })
        .catch(() => {
          setFailed(true);
          setBusy(false);
        });
    },
    [rpc],
  );
  useEffect(() => load(false), [load]);
  // Saving a snippet should retire the proposal it came from. Re-filtering is
  // cheap — the mined list is cached, only the "already covered" pass reruns.
  usePromptSignal(
    ["suggestions", "snippets"],
    null,
    useCallback(() => load(false, true), [load]),
  );

  function dismiss(suggestion: SuggestionDto): void {
    setData((current) =>
      current === null
        ? current
        : {
            ...current,
            suggestions: current.suggestions.filter(
              (item) => item.key !== suggestion.key,
            ),
            dismissedCount: current.dismissedCount + 1,
          },
    );
    void rpc
      .call("dismissSuggestion", { key: suggestion.key, body: suggestion.body })
      .then(onChanged);
  }

  // Switched off in settings, or nothing to offer and nothing turned down:
  // stay out of the way entirely. A failed scan is not "nothing to offer" —
  // that case says so below.
  if (data !== null && !data.enabled) return null;
  if (
    !failed &&
    data !== null &&
    !data.computing &&
    data.suggestions.length === 0 &&
    data.dismissedCount === 0
  ) {
    return null;
  }

  // No cache yet and a scan running: the first mine has nothing to show.
  const scanningFirstTime =
    data !== null && data.computing && data.computedAt === 0;

  return (
    <Section
      title="Suggested"
      count={data?.suggestions.length}
      meta={
        failed || data?.lastError
          ? "history unreadable"
          : data === null || scanningFirstTime
            ? "reading history…"
            : `${data.considered.toLocaleString()} of ${data.analyzed.toLocaleString()} prompts scanned${
                data.computing ? " · rescanning…" : ""
              }`
      }
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={busy}
              onClick={() => load(true)}
              aria-label="Rescan prompt history"
            >
              <Icon
                name={busy ? "Loading" : "RotateCcw"}
                className={cn("size-3.5", busy && "animate-spin")}
                aria-hidden
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Rescan prompt history</TooltipContent>
        </Tooltip>
      }
    >
      <div className="flex flex-col gap-0.5">
        {failed ? (
          <div className="flex items-center justify-between gap-2 py-1">
            <p className="text-sm text-muted-foreground">
              The scan failed. Nothing was changed.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-xs"
              disabled={busy}
              onClick={() => load(true)}
            >
              Try again
            </Button>
          </div>
        ) : data === null || scanningFirstTime ? (
          <>
            <Skeleton className="h-11 rounded-md" />
            <Skeleton className="h-11 rounded-md" />
          </>
        ) : data.suggestions.length === 0 ? (
          <SectionEmpty>
            Nothing new to suggest — everything you repeat is already a snippet.
          </SectionEmpty>
        ) : (
          data.suggestions.map((suggestion) => {
            const open = expanded === suggestion.key;
            return (
              <div
                key={suggestion.key}
                className="group rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover"
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setExpanded(open ? null : suggestion.key)}
                    aria-expanded={open}
                  >
                    {/* Wraps rather than truncates: the title is the whole
                        basis for deciding, and this column is narrow. */}
                    <p className="flex items-start gap-1.5 text-sm font-medium">
                      <Icon
                        name={open ? "ChevronDown" : "ChevronRight"}
                        className="mt-1 size-3 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="line-clamp-2">{suggestion.title}</span>
                    </p>
                    {/* One text node, so a narrow panel wraps the whole phrase
                        instead of orphaning "· 2 phrasings". */}
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 pl-4.5 text-xs text-muted-foreground">
                      <span className="tabular-nums">
                        {`typed ${suggestion.count}×`}
                        {suggestion.variantCount > 1
                          ? ` · ${suggestion.variantCount} phrasings`
                          : ""}
                      </span>
                      {suggestion.tokens.map((token) => (
                        <Badge
                          key={token}
                          variant="secondary"
                          className="px-1.5 font-mono"
                          style={{ fontSize: 10 }}
                        >
                          {`{{${token}}}`}
                        </Badge>
                      ))}
                    </p>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() =>
                        onAdd({
                          id: null,
                          title: suggestion.title,
                          body: suggestion.body,
                          keywords: suggestion.keywords,
                          groupName: "",
                          projectId: null,
                        })
                      }
                    >
                      <Icon name="Plus" className="size-3" aria-hidden />
                      Add
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={() => dismiss(suggestion)}
                          aria-label={`Dismiss “${suggestion.title}”`}
                        >
                          <Icon name="X" className="size-3.5" aria-hidden />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Not a snippet — don't suggest again
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                {open ? (
                  <div className="mt-2 space-y-2 pl-4.5 animate-in fade-in-0 slide-in-from-top-1 duration-150">
                    <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs">
                      {suggestion.body}
                    </p>
                    {suggestion.variantCount > 1 ? (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          Folded in from:
                        </p>
                        {suggestion.variants.slice(1).map((variant, index) => (
                          <p
                            key={index}
                            className="line-clamp-1 text-xs text-muted-foreground/70"
                          >
                            {previewText(variant)}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    <p className="text-xs text-muted-foreground/60">
                      last typed {formatWhen(suggestion.lastSeenAt)}
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
        {data !== null && data.dismissedCount > 0 ? (
          <button
            type="button"
            className="pt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() =>
              void rpc.call("restoreSuggestions", null).then(() => {
                load(false);
                onChanged();
              })
            }
          >
            {data.dismissedCount} dismissed — bring them back
          </button>
        ) : null}
      </div>
    </Section>
  );
}

type ManagerView = "queue" | "snippets";

export function ManagerPanel({ subPath }: { subPath?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  // The snippets composer button deep-links straight into the library.
  const [view, setView] = useState<ManagerView>(
    subPath === "snippets" ? "snippets" : "queue",
  );
  useEffect(() => {
    if (subPath === "snippets" || subPath === "queue") setView(subPath);
  }, [subPath]);
  const [data, setData] = useState<OverviewData | null>(null);
  const [failed, setFailed] = useState(false);
  const [snippetSearch, setSnippetSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [newPrompt, setNewPrompt] = useState("");
  const [editing, setEditing] = useState<PromptDto | null>(null);
  const [scheduling, setScheduling] = useState<PromptDto | null>(null);
  const [snippetDraft, setSnippetDraft] = useState<SnippetDraft | null>(null);
  const [fillIn, setFillIn] = useState<FillInRequest | null>(null);

  const refresh = useCallback(() => {
    void rpc
      .call("overview")
      .then((result) => {
        setData(result);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [rpc]);
  useEffect(refresh, [refresh]);
  // The manager watches everything, so it is the surface a publish storm hurt
  // most: every idle/active transition in any thread used to cost a full
  // overview refetch (three round-trips per queued thread).
  usePromptSignal(["queue", "snippets"], null, refresh, { debounceMs: 400 });

  const stats = useMemo(() => {
    if (!data) return { queued: 0, armed: 0, scheduled: 0, snippets: 0 };
    const all = [
      ...data.globalPrompts,
      ...data.projects.flatMap((project) => project.prompts),
      ...data.threads.flatMap((thread) => thread.prompts),
    ];
    return {
      queued: all.length,
      armed: all.filter((prompt) => prompt.autoSend).length,
      scheduled: all.filter((prompt) => prompt.sendAt !== null).length,
      snippets: data.snippetTotal,
    };
  }, [data]);

  const snippetGroups = useSnippetGroups(data?.snippets ?? []);

  const visibleSnippets = useMemo(() => {
    if (!data) return [];
    const query = snippetSearch.trim().toLowerCase();
    return data.snippets.filter((snippet) => {
      if (groupFilter !== null && snippet.groupName !== groupFilter) return false;
      if (!query) return true;
      return [snippet.title, snippet.keywords, snippet.body, snippet.groupName ?? ""]
        .join("\n")
        .toLowerCase()
        .includes(query);
    });
  }, [data, snippetSearch, groupFilter]);

  const actions = useMemo(
    () =>
      createPromptActions({
        rpc,
        refresh,
        threadId: null,
        projectId: null,
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
    [rpc, refresh],
  );
  const reorder = useMemo(() => createReorder(rpc, refresh), [rpc, refresh]);

  function moveWithin(
    prompts: PromptDto[],
    scope: Scope,
    owner: { threadId: string | null; projectId: string | null },
  ) {
    return (index: number, direction: "up" | "down") => {
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= prompts.length) return;
      const ordered = [...prompts];
      const [moved] = ordered.splice(index, 1);
      ordered.splice(target, 0, moved!);
      void reorder(
        { scope, ...owner },
        ordered.map((prompt) => prompt.id),
      );
    };
  }

  function rowActions(
    prompt: PromptDto,
    prompts: PromptDto[],
    scope: Scope,
    owner: { threadId: string | null; projectId: string | null },
  ) {
    return {
      onInject: null,
      onSendNow:
        prompt.threadId !== null
          ? (entry: PromptDto) =>
              void actions.sendToThread(entry, entry.threadId!)
          : null,
      onPush:
        prompt.threadId !== null
          ? (entry: PromptDto) => {
              void rpc
                .call("pushToNativeQueue", {
                  id: entry.id,
                  threadId: entry.threadId!,
                })
                .then(({ pushed, error }) => {
                  refresh();
                  if (pushed) toast.success("Moved to bb's queue");
                  else toast.error(error ?? "Push failed");
                });
            }
          : null,
      onEdit: actions.onEdit,
      onSchedule: actions.onSchedule,
      onSaveAsSnippet: actions.onSaveAsSnippet,
      onToggleArm: (entry: PromptDto) => void actions.toggleArm(entry),
      onMove: moveWithin(prompts, scope, owner),
      onChangeScope: (entry: PromptDto, next: Scope) =>
        void actions.changeScope(entry, next),
      onSendToThread: (entry: PromptDto, target: string) =>
        void actions.sendToThread(entry, target),
      onDelete: (entry: PromptDto) => void actions.remove(entry),
      loadTargets: actions.loadTargets,
    };
  }

  function queueSnippet(snippet: SnippetDto, target: QueueTarget): void {
    const deliver = (filled: string) => {
      void rpc
        .call("addPrompt", {
          text: filled,
          ...targetInput(target),
          autoSend: false,
        })
        .then(({ prompt, error }) => {
          if (!prompt) {
            toast.error(error ?? "Could not queue that snippet");
            return;
          }
          void rpc.call("useSnippet", { id: snippet.id });
          refresh();
          toast.success(`“${snippet.title}” queued for ${target.phrase}`);
        });
    };
    if (hasTokens(snippet.body))
      setFillIn({ text: snippet.body, title: snippet.title, complete: deliver });
    else deliver(snippet.body);
  }

  async function addGlobalPrompt(): Promise<void> {
    const text = newPrompt.trim();
    if (!text) return;
    const { prompt, error } = await rpc.call("addPrompt", {
      text,
      scope: "global",
      threadId: null,
      projectId: null,
      autoSend: false,
    });
    if (!prompt) {
      toast.error(error ?? "Could not queue that prompt");
      return;
    }
    setNewPrompt("");
    refresh();
  }

  const newSnippet = () =>
    setSnippetDraft({
      id: null,
      title: "",
      body: "",
      keywords: "",
      groupName: "",
      projectId: null,
    });

  if (failed && data === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          Could not load your prompts. Nothing was changed.
        </p>
        <Button size="sm" variant="outline" onClick={refresh}>
          <Icon name="RotateCcw" className="size-3.5" aria-hidden />
          Try again
        </Button>
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="h-full overflow-y-auto p-4 md:p-5">
        <ManagerSkeleton />
      </div>
    );
  }

  const isEmptyWorkspace =
    data.globalPrompts.length === 0 &&
    data.projects.length === 0 &&
    data.threads.length === 0 &&
    data.snippets.length === 0 &&
    data.recentlyUsed.length === 0;

  if (isEmptyWorkspace) {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto p-6">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Icon name="Layers" className="size-7" aria-hidden />
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
            <Button size="sm" onClick={newSnippet}>
              <Icon name="Explore" className="size-3.5" aria-hidden />
              New snippet
            </Button>
          </div>
          {/* An empty library is exactly when mined suggestions are worth most. */}
          <div className="w-full max-w-md">
            <SuggestionsSection
              rpc={rpc}
              onAdd={setSnippetDraft}
              onChanged={refresh}
            />
          </div>
          <SnippetEditor
            draft={snippetDraft}
            rpc={rpc}
            projectId={null}
            onSaved={refresh}
            onClose={() => setSnippetDraft(null)}
          />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* The two views mirror the composer's two buttons, so the same split
            holds wherever the user meets this plugin. */}
        <div className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2.5 md:px-5">
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(next) => next && setView(next as ManagerView)}
              variant="outline"
              size="sm"
              className="gap-0"
            >
              <ToggleGroupItem
                value="queue"
                className="gap-1.5 rounded-r-none px-3 text-xs"
                aria-label="Show the prompt queue"
              >
                <Icon name="Layers" className="size-3.5" aria-hidden />
                Queue
                {stats.queued > 0 ? (
                  <span className="tabular-nums text-muted-foreground">
                    {stats.queued}
                  </span>
                ) : null}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="snippets"
                className="-ml-px gap-1.5 rounded-l-none px-3 text-xs"
                aria-label="Show the snippet library"
              >
                <Icon name="Explore" className="size-3.5" aria-hidden />
                Snippets
                {stats.snippets > 0 ? (
                  <span className="tabular-nums text-muted-foreground">
                    {stats.snippets}
                  </span>
                ) : null}
              </ToggleGroupItem>
            </ToggleGroup>

            <div className="min-w-0 flex-1" />

            {view === "queue" && stats.armed > 0 ? (
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-primary">
                <Icon name="TimeSchedule" className="size-3.5" aria-hidden />
                {stats.armed} armed
                {stats.scheduled > 0 ? ` · ${stats.scheduled} scheduled` : ""}
              </span>
            ) : null}
            {view === "snippets" ? (
              <Button size="sm" className="h-7 px-2.5 text-xs" onClick={newSnippet}>
                <Icon name="Plus" className="size-3.5" aria-hidden />
                New snippet
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-4 md:px-5">
            {view === "queue" ? (
              <>
                {/* Writing a prompt is the reason to be here; it leads. */}
                <div className="flex items-end gap-2">
                  <Textarea
                    value={newPrompt}
                    onChange={(event) => setNewPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void addGlobalPrompt();
                      }
                    }}
                    placeholder="Write a prompt for later — it lands in the global queue…"
                    className="min-h-16 flex-1 resize-none text-sm"
                  />
                  <Button
                    disabled={!newPrompt.trim()}
                    onClick={() => void addGlobalPrompt()}
                  >
                    Queue
                  </Button>
                </div>

                {data.projects.map((project) => (
                  <Section
                    key={project.projectId}
                    title={project.name}
                    kind="content"
                    count={project.prompts.length}
                    meta="kept for the project — survives its threads"
                    actions={
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            onClick={() => navigate.toProject(project.projectId)}
                            aria-label={`Open ${project.name}`}
                          >
                            <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Open project</TooltipContent>
                      </Tooltip>
                    }
                  >
                    <div>
                      {project.prompts.map((prompt, index) => (
                        <PromptRow
                          key={prompt.id}
                          prompt={prompt}
                          index={index}
                          count={project.prompts.length}
                          variant="roomy"
                          alwaysShowActions
                          available={{ threadId: null, projectId: project.projectId }}
                          actions={rowActions(prompt, project.prompts, "project", {
                            threadId: null,
                            projectId: project.projectId,
                          })}
                        />
                      ))}
                    </div>
                  </Section>
                ))}
                {data.hiddenProjects > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {`${data.hiddenProjects} more project queue(s) not shown.`}
                  </p>
                ) : null}

                {data.threads.map((thread) => (
                  <Section
                    key={thread.threadId}
                    title={thread.title}
                    kind="content"
                    count={thread.prompts.length}
                    meta={
                      thread.nativeCount > 0
                        ? `${thread.nativeCount} in bb's queue`
                        : thread.paused
                          ? "auto-send paused"
                          : undefined
                    }
                    actions={
                      <>
                        {thread.prompts.some((prompt) => !prompt.autoSend) ? (
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
                        {thread.prompts.some((prompt) => prompt.autoSend) ? (
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
                              aria-label={`Open ${thread.title}`}
                            >
                              <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Open thread</TooltipContent>
                        </Tooltip>
                      </>
                    }
                  >
                    <div>
                      {thread.prompts.map((prompt, index) => (
                        <PromptRow
                          key={prompt.id}
                          prompt={prompt}
                          index={index}
                          count={thread.prompts.length}
                          variant="roomy"
                          alwaysShowActions
                          available={{
                            threadId: thread.threadId,
                            projectId: thread.projectId,
                          }}
                          actions={rowActions(prompt, thread.prompts, "thread", {
                            threadId: thread.threadId,
                            projectId: null,
                          })}
                        />
                      ))}
                    </div>
                  </Section>
                ))}
                {data.hiddenThreads > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {`${data.hiddenThreads} more thread queue(s) not shown — open a thread to see its own.`}
                  </p>
                ) : null}

                <Section
                  title="Global"
                  count={data.globalPrompts.length}
                  meta="injectable in any thread"
                >
                  {data.globalPrompts.length === 0 ? (
                    <SectionEmpty>
                      Nothing global yet. Prompts queued here can be injected
                      into any thread.
                    </SectionEmpty>
                  ) : (
                    <div>
                      {data.globalPrompts.map((prompt, index) => (
                        <PromptRow
                          key={prompt.id}
                          prompt={prompt}
                          index={index}
                          count={data.globalPrompts.length}
                          variant="roomy"
                          alwaysShowActions
                          available={{ threadId: null, projectId: null }}
                          actions={rowActions(prompt, data.globalPrompts, "global", {
                            threadId: null,
                            projectId: null,
                          })}
                        />
                      ))}
                    </div>
                  )}
                </Section>

                {data.threads.length === 0 && data.projects.length === 0 ? (
                  <Section title="Threads">
                    <SectionEmpty>
                      No thread has prompts stashed. The queue button next to any
                      composer stashes them.
                    </SectionEmpty>
                  </Section>
                ) : null}

                <Section title="Recently used" count={data.recentlyUsed.length}>
                  {data.recentlyUsed.length === 0 ? (
                    <SectionEmpty>
                      Sent and injected prompts land here, ready to restore.
                    </SectionEmpty>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {data.recentlyUsed.slice(0, 12).map((prompt) => (
                        <UsedPromptRow
                          key={prompt.id}
                          prompt={prompt}
                          showTime
                          onRestore={(entry) => void actions.restore(entry)}
                        />
                      ))}
                    </div>
                  )}
                </Section>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <div className="relative">
                    <Icon
                      name="Search"
                      className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      value={snippetSearch}
                      onChange={(event) => setSnippetSearch(event.target.value)}
                      placeholder="Search snippets by title, body, or keyword…"
                      className="h-9 pl-8"
                    />
                  </div>
                  {snippetGroups.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <GroupChip
                        label="All"
                        active={groupFilter === null}
                        onClick={() => setGroupFilter(null)}
                      />
                      {snippetGroups.map((group) => (
                        <GroupChip
                          key={group}
                          label={group}
                          active={groupFilter === group}
                          onClick={() =>
                            setGroupFilter((current) =>
                              current === group ? null : group,
                            )
                          }
                        />
                      ))}
                      {groupFilter !== null ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          onClick={() =>
                            void rpc
                              .call("queueSnippetGroup", {
                                groupName: groupFilter,
                                scope: "global",
                                threadId: null,
                                projectId: null,
                              })
                              .then(({ queued, error }) => {
                                refresh();
                                if (error) toast.error(error);
                                else
                                  toast.success(
                                    `Queued ${queued} prompt${queued === 1 ? "" : "s"} from “${groupFilter}”`,
                                  );
                              })
                          }
                        >
                          <Icon name="Layers" className="size-3" aria-hidden />
                          Queue this group
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <SuggestionsSection
                  rpc={rpc}
                  onAdd={setSnippetDraft}
                  onChanged={refresh}
                />

                <Section
                  title="Library"
                  count={data.snippetTotal}
                  meta={
                    snippetSearch.trim() || groupFilter !== null
                      ? `${visibleSnippets.length} shown`
                      : "{{tokens}} become fill-in fields"
                  }
                >
                  {visibleSnippets.length === 0 ? (
                    <SectionEmpty>
                      {data.snippets.length === 0
                        ? "No snippets yet. Save a prompt you reuse and it lands here."
                        : "No snippets match that search."}
                    </SectionEmpty>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {visibleSnippets.map((snippet) => (
                        <SnippetRow
                          key={snippet.id}
                          snippet={snippet}
                          variant="roomy"
                          alwaysShowActions={false}
                          actions={{
                            onInsert: null,
                            onQueue: (entry, target) => queueSnippet(entry, target),
                            // No thread in view, so the local choices are the
                            // snippet's own project and the global queue; any
                            // thread is still reachable through the submenu.
                            targets: queueTargets(null, snippet.projectId),
                            onQueueLater: null,
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
                            onDelete: (entry) =>
                              void rpc
                                .call("deleteSnippet", { id: entry.id })
                                .then(refresh),
                          }}
                        />
                      ))}
                      {data.snippetTotal > data.snippets.length ? (
                        <p className="px-2 py-1 text-xs text-muted-foreground">
                          {`${data.snippetTotal - data.snippets.length} more not shown — search to narrow the list.`}
                        </p>
                      ) : null}
                    </div>
                  )}
                </Section>
              </>
            )}
          </div>
        </div>
      </div>

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
        projectId={null}
        onSaved={refresh}
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
    </TooltipProvider>
  );
}

function GroupChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}
