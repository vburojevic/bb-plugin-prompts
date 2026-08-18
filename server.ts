// bb-plugin-prompts — backend entry.
//
// Two complementary stores over one SQLite db:
// - QUEUE: one-shot prompts written while agents are busy, scoped to a thread,
//   a project, or globally. Injected into the composer (consume + undo), sent
//   to any thread, ARMED to auto-send when their thread goes idle, or scheduled
//   for a specific time. Claims are atomic UPDATEs so duplicate idle events or
//   sweep races can never double-send.
// - SNIPPETS: reusable, titled, keyworded prompts with {{fill-in}} tokens.
//   Inserting never consumes them.
//
// Auto-send waits an idle-delay grace period (setting) and is cancelled if the
// thread goes active again — thread.idle also fires when the agent is waiting
// for the user's answer, and barging into that exchange is wrong.
//
// A thread ending is not the end of its prompts: they move to the project's
// queue, so the next session in that project still has the user's writing.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { rpcContract } from "./lib/contract";
import { registerAgentTools } from "./lib/agent-tools";
import { CLI_COMMANDS, createCliRunner } from "./lib/cli";
import { toHistoryPrompt, type HistoryEntryLike } from "./lib/history";
import { createMiner } from "./lib/mining";
import {
  createOperations,
  USED_KEEP,
  type PromptsHost,
  type Signal,
  type ThreadInfo,
} from "./lib/operations";
import { errorText } from "./lib/queued-messages";
import { createStore, MIGRATIONS, type ScopeRef } from "./lib/store";
import type { HistoryPrompt } from "./lib/suggest";
import { parseTokens } from "./lib/template";

export { rpcContract } from "./lib/contract";

const REALTIME_CHANNEL = "prompts";
const DEFAULT_IDLE_DELAY_SECONDS = 20;
/** Prompt-history entries pulled per project/thread when mining for suggestions. */
const HISTORY_LIMIT = 500;
/**
 * Recent threads whose history is mined. bb keeps prompt history per thread as
 * well as per project, and the thread-scoped ones are the bulk of it — the
 * follow-ups ("commit and push", "fix all issues") are typed inside threads,
 * not into a project's new-thread composer.
 */
const THREAD_SCAN_LIMIT = 250;
/** In-flight history requests. Enough to hide latency, few enough to be polite. */
const HISTORY_CONCURRENCY = 8;
/** Threads whose details are fetched in parallel for the overview panel. */
const OVERVIEW_CONCURRENCY = 8;
/** Groups the manager expands. Anything past this is reported, never dropped silently. */
const OVERVIEW_THREAD_LIMIT = 20;
const OVERVIEW_PROJECT_LIMIT = 20;
/** Threads offered by "send to thread", and how many are scanned to find them. */
const TARGET_LIMIT = 15;
const TARGET_SCAN = 60;

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db);

  const settings = bb.settings.define({
    autoSendDelaySeconds: {
      type: "string",
      label: "Auto-send idle delay (seconds)",
      default: String(DEFAULT_IDLE_DELAY_SECONDS),
    },
    threadEnd: {
      type: "select",
      label: "When a thread is archived or deleted",
      options: ["keep for the project", "delete"],
      default: "keep for the project",
    },
    mineHistory: {
      type: "select",
      label: "Suggest snippets from prompt history",
      options: ["on", "off"],
      default: "on",
    },
  });

  // Settings are read on the thread-idle path, which must stay synchronous:
  // awaiting a settings read there opened a window where `thread.active` could
  // not cancel a timer that had not been created yet, and the prompt fired
  // into a running agent. Cache the values and refresh on change instead.
  let idleDelayMs = DEFAULT_IDLE_DELAY_SECONDS * 1_000;
  let threadEndMode: "promote" | "delete" = "promote";
  let mineHistory = true;

  function applySettings(values: {
    autoSendDelaySeconds?: string;
    threadEnd?: string;
    mineHistory?: string;
  }): void {
    const seconds = Number(values.autoSendDelaySeconds);
    // `Number("") === 0`, and "0 seconds" is a legitimate choice — only a
    // genuinely unparseable value falls back to the default.
    idleDelayMs =
      Number.isFinite(seconds) && seconds >= 0
        ? Math.min(seconds, 3_600) * 1_000
        : DEFAULT_IDLE_DELAY_SECONDS * 1_000;
    threadEndMode = values.threadEnd === "delete" ? "delete" : "promote";
    mineHistory = values.mineHistory !== "off";
  }

  void settings
    .get()
    .then(applySettings)
    .catch(() => {
      /* defaults already applied */
    });
  settings.onChange((next) => applySettings(next));

  let disposed = false;

  function notify(signal: Signal): void {
    try {
      bb.realtime.publish(REALTIME_CHANNEL, signal);
    } catch {
      // Best-effort; the UI refetches when reopened.
    }
  }

  // ---- The bb surface this plugin uses, as plain functions ----
  const host: PromptsHost = {
    async send(threadId, text) {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      });
    },
    async getThread(threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread as unknown as ThreadInfo;
    },
    async listThreads(options) {
      const threads = await bb.sdk.threads.list(options);
      return threads as unknown as ThreadInfo[];
    },
    async listProjects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return projects.map((project) => ({ id: project.id, name: project.name }));
    },
    async projectHistory(projectId, limit) {
      const entries = await bb.sdk.projects.promptHistory({
        projectId,
        limit: String(limit),
      });
      return entries as unknown as HistoryEntryLike[];
    },
    async threadHistory(threadId, limit) {
      const entries = await bb.sdk.threads.promptHistory({
        threadId,
        limit: String(limit),
      });
      return entries as unknown as HistoryEntryLike[];
    },
    async listQueuedMessages(threadId) {
      const messages = await bb.sdk.threads.queuedMessages.list({ threadId });
      return messages.map((message) => ({
        id: message.id,
        content: message.content as { type: string; text?: string }[],
        updatedAt: message.updatedAt,
      }));
    },
    async createQueuedMessage(threadId, text) {
      await bb.sdk.threads.queuedMessages.create({
        threadId,
        input: [{ type: "text", text, mentions: [] }],
      });
    },
    async deleteQueuedMessage(threadId, queuedMessageId) {
      await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId });
    },
    async sendQueuedMessage(threadId, queuedMessageId) {
      await bb.sdk.threads.queuedMessages.send({
        threadId,
        queuedMessageId,
        mode: "auto",
      });
    },
  };

  const operations = createOperations({
    store,
    host,
    notify,
    log: bb.log,
    threadEndMode: () => threadEndMode,
  });

  /** Run `task` over `items` with at most `limit` in flight. */
  async function mapLimit<T, R>(
    items: T[],
    limit: number,
    task: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          results[index] = await task(items[index]!);
        }
      }),
    );
    return results;
  }

  /**
   * Every project's and every recent thread's prompt history, flattened and
   * stripped of injected input. One unreadable source is skipped rather than
   * sinking the whole scan.
   */
  async function loadHistory(): Promise<HistoryPrompt[]> {
    async function read(
      label: string,
      load: () => Promise<HistoryEntryLike[]>,
    ): Promise<HistoryPrompt[]> {
      try {
        const entries = await load();
        return entries.flatMap(toHistoryPrompt);
      } catch (error) {
        if (!disposed)
          bb.log.warn(`prompt history unavailable for ${label}: ${errorText(error)}`);
        return [];
      }
    }

    // No `archived` filter: archived threads are most of this history and hold
    // the finished workflows worth templating. Hidden threads stay out — that
    // is `includeHidden` defaulting to false, and it is exactly right here,
    // because hidden threads are plugins briefing agents, not the user typing.
    const [projects, threads] = await Promise.all([
      host.listProjects(),
      host.listThreads({ limit: THREAD_SCAN_LIMIT }),
    ]);

    const [perProject, perThread] = await Promise.all([
      mapLimit(projects, HISTORY_CONCURRENCY, (project) =>
        read(project.id, () => host.projectHistory(project.id, HISTORY_LIMIT)),
      ),
      mapLimit(threads, HISTORY_CONCURRENCY, (thread) =>
        read(thread.id, () => host.threadHistory(thread.id, HISTORY_LIMIT)),
      ),
    ]);
    const fromProjects = perProject.flat();
    const fromThreads = perThread.flat();
    if (!disposed)
      bb.log.info(
        `scanned ${projects.length} projects (${fromProjects.length} prompts) ` +
          `and ${threads.length} threads (${fromThreads.length} prompts)`,
      );
    return [...fromProjects, ...fromThreads];
  }

  const miner = createMiner({
    loadHistory,
    existingBodies: () =>
      store.listSnippets("", { limit: 500 }).snippets.map((snippet) => snippet.body),
    dismissedKeys: () => store.listDismissedSuggestions(),
    dismissedCount: () => store.countDismissedSuggestions(),
    kvGet: (key) => bb.storage.kv.get(key),
    kvSet: (key, value) => bb.storage.kv.set(key, value),
    log: bb.log,
    onMined: () =>
      notify({
        topic: "suggestions",
        kind: "changed",
        threadId: null,
        projectId: null,
      }),
    isDisposed: () => disposed,
    isEnabled: () => mineHistory,
  });

  const refOf = (input: {
    scope: "thread" | "project" | "global";
    threadId: string | null;
    projectId: string | null;
  }): ScopeRef => ({
    scope: input.scope,
    threadId: input.threadId,
    projectId: input.projectId,
  });

  // ---- RPC ----
  bb.rpc.register(rpcContract, {
    listPrompts({ threadId, projectId }) {
      return {
        threadPrompts:
          threadId === null ? [] : store.listQueued({ scope: "thread", threadId }),
        projectPrompts:
          projectId === null
            ? []
            : store.listQueued({ scope: "project", projectId }),
        globalPrompts: store.listQueued({ scope: "global" }),
        recentlyUsed: store.listRecentlyUsed(threadId, projectId, USED_KEEP / 2),
        paused: threadId === null ? false : store.isPaused(threadId),
      };
    },
    addPrompt(input) {
      return operations.addPrompt(input);
    },
    updatePrompt({ id, ...fields }) {
      const prompt = store.updatePromptFields(id, fields);
      if (prompt)
        notify({
          topic: "queue",
          kind: "changed",
          threadId: prompt.threadId,
          projectId: prompt.projectId,
        });
      return { prompt };
    },
    movePrompt({ id, ...ref }) {
      const before = store.getPrompt(id);
      if (!before) return { prompt: null, error: "Prompt no longer exists." };
      try {
        const prompt = store.movePrompt(id, refOf(ref));
        if (prompt) {
          notify({
            topic: "queue",
            kind: "changed",
            threadId: before.threadId,
            projectId: before.projectId,
          });
          notify({
            topic: "queue",
            kind: "changed",
            threadId: prompt.threadId,
            projectId: prompt.projectId,
          });
        }
        return { prompt, error: null };
      } catch (error) {
        return { prompt: null, error: errorText(error) };
      }
    },
    deletePrompt({ id }) {
      const existing = store.getPrompt(id);
      if (!existing) return { deleted: false, prompt: null };
      store.deletePrompt(id);
      notify({
        topic: "queue",
        kind: "changed",
        threadId: existing.threadId,
        projectId: existing.projectId,
      });
      return { deleted: true, prompt: existing };
    },
    consumePrompt({ id, via }) {
      const prompt = store.claimPrompt(id, via);
      if (prompt) {
        store.pruneUsed(USED_KEEP);
        notify({
          topic: "queue",
          kind: "changed",
          threadId: prompt.threadId,
          projectId: prompt.projectId,
        });
      }
      return { prompt };
    },
    restorePrompt({ id }) {
      const prompt = store.requeuePrompt(id);
      if (prompt)
        notify({
          topic: "queue",
          kind: "changed",
          threadId: prompt.threadId,
          projectId: prompt.projectId,
        });
      return { prompt };
    },
    reorderPrompts({ ids, ...ref }) {
      const reordered = store.reorderPrompts(refOf(ref), ids);
      if (reordered)
        notify({
          topic: "queue",
          kind: "changed",
          threadId: ref.threadId,
          projectId: ref.projectId,
        });
      return { reordered };
    },
    armAll({ threadId }) {
      const armed = store.setArmedForThread(threadId, true);
      if (armed > 0)
        notify({ topic: "queue", kind: "changed", threadId, projectId: null });
      return { armed };
    },
    disarmThread({ threadId }) {
      const disarmed = store.setArmedForThread(threadId, false);
      if (disarmed > 0)
        notify({ topic: "queue", kind: "changed", threadId, projectId: null });
      return { disarmed };
    },
    setPaused({ threadId, paused }) {
      store.setPaused(threadId, paused);
      notify({ topic: "queue", kind: "changed", threadId, projectId: null });
      return { paused };
    },
    async listTargets({ excludeThreadId, query }) {
      const threads = await host.listThreads({
        archived: false,
        limit: TARGET_SCAN,
      });
      const needle = (query ?? "").trim().toLowerCase();
      const candidates = threads
        .filter((thread) => thread.id !== excludeThreadId)
        .map((thread) => ({
          id: thread.id,
          title: thread.title ?? thread.titleFallback ?? "Untitled thread",
          projectId: thread.projectId ?? null,
        }))
        .filter(
          (thread) => !needle || thread.title.toLowerCase().includes(needle),
        );
      return {
        threads: candidates.slice(0, TARGET_LIMIT),
        total: candidates.length,
      };
    },
    sendPromptToThread({ id, threadId }) {
      return operations.sendById(id, threadId, "cross-thread");
    },
    async overview() {
      const allThreadIds = store.listQueuedThreadIds();
      const allProjectIds = store.listQueuedProjectIds();
      const threadIds = allThreadIds.slice(0, OVERVIEW_THREAD_LIMIT);
      const projectIds = allProjectIds.slice(0, OVERVIEW_PROJECT_LIMIT);

      // Two round-trips per thread, so serial fetching cost seconds once a
      // handful of threads had queues. Order is preserved by mapLimit.
      const [threads, projectNames] = await Promise.all([
        mapLimit(threadIds, OVERVIEW_CONCURRENCY, async (threadId) => {
          const [thread, nativeCount] = await Promise.all([
            // Thread fetch failing is cosmetic; keep the group visible.
            host.getThread(threadId).catch(() => null),
            host
              .listQueuedMessages(threadId)
              .then((messages) => messages.length)
              // Native queue unavailable (e.g. archived) — show zero.
              .catch(() => 0),
          ]);
          return {
            threadId,
            title: thread?.title ?? thread?.titleFallback ?? "Untitled thread",
            projectId: thread?.projectId ?? null,
            paused: store.isPaused(threadId),
            nativeCount,
            prompts: store.listQueued({ scope: "thread", threadId }),
          };
        }),
        host
          .listProjects()
          .then(
            (projects) => new Map(projects.map((project) => [project.id, project.name])),
          )
          .catch(() => new Map<string, string>()),
      ]);

      const { snippets, total: snippetTotal } = store.listSnippets("");
      return {
        globalPrompts: store.listQueued({ scope: "global" }),
        projects: projectIds.map((projectId) => ({
          projectId,
          name: projectNames.get(projectId) ?? "Unknown project",
          prompts: store.listQueued({ scope: "project", projectId }),
        })),
        threads,
        snippets,
        snippetTotal,
        recentlyUsed: store.listAllUsed(30),
        hiddenThreads: allThreadIds.length - threadIds.length,
        hiddenProjects: allProjectIds.length - projectIds.length,
      };
    },
    listNativeQueue({ threadId }) {
      return operations.listNative(threadId);
    },
    pushToNativeQueue({ id, threadId }) {
      return operations.pushToNative(id, threadId);
    },
    stashNativeMessage({ threadId, queuedMessageId }) {
      return operations.stashOneNative(threadId, queuedMessageId);
    },
    stashAllNative({ threadId }) {
      return operations.stashAllNative(threadId);
    },
    sendNativeNow({ threadId, queuedMessageId }) {
      return operations.sendNativeNow(threadId, queuedMessageId);
    },
    queueSnippetGroup({ groupName, ...ref }) {
      return operations.queueSnippetGroup(refOf(ref), groupName);
    },
    suggestSnippets({ refresh }) {
      return miner.read(refresh);
    },
    dismissSuggestion({ key, body }) {
      store.dismissSuggestion(key, body);
      notify({
        topic: "suggestions",
        kind: "changed",
        threadId: null,
        projectId: null,
      });
      return { dismissed: true };
    },
    restoreSuggestions() {
      const restored = store.clearDismissedSuggestions();
      notify({
        topic: "suggestions",
        kind: "changed",
        threadId: null,
        projectId: null,
      });
      return { restored };
    },
    listSnippets({ query, projectId }) {
      return store.listSnippets(query, { projectId });
    },
    addSnippet(input) {
      const snippet = store.addSnippet(input);
      notify({
        topic: "snippets",
        kind: "changed",
        threadId: null,
        projectId: snippet.projectId,
      });
      return { snippet };
    },
    updateSnippet(input) {
      const snippet = store.updateSnippet(input);
      if (snippet)
        notify({
          topic: "snippets",
          kind: "changed",
          threadId: null,
          projectId: snippet.projectId,
        });
      return { snippet };
    },
    deleteSnippet({ id }) {
      const deleted = store.deleteSnippet(id);
      if (deleted)
        notify({
          topic: "snippets",
          kind: "changed",
          threadId: null,
          projectId: null,
        });
      return { deleted };
    },
    useSnippet({ id }) {
      store.touchSnippet(id);
      return { snippet: store.getSnippet(id) };
    },
    fillValues({ tokens }) {
      return { values: store.fillValuesFor(tokens) };
    },
    rememberFillValues({ values }) {
      store.rememberFillValues(values);
      return { saved: true };
    },
  });

  // ---- Auto-send with idle-delay guard ----
  //
  // thread.idle also fires when the agent stops to ask the user a question, so
  // firing instantly would barge into a live exchange. Instead we wait
  // `autoSendDelaySeconds`; thread.active during the window cancels the timer.
  //
  // The whole handler is synchronous by construction. An `await` between the
  // idle event and `setTimeout` would let a `thread.active` in that window fail
  // to cancel a timer that did not exist yet — and the prompt would then fire
  // into a running agent. The epoch is the second lock on that door: a timer
  // whose thread has since transitioned does nothing when it wakes.
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const threadEpoch = new Map<string, number>();

  function bumpEpoch(threadId: string): number {
    const next = (threadEpoch.get(threadId) ?? 0) + 1;
    threadEpoch.set(threadId, next);
    return next;
  }

  function cancelIdleTimer(threadId: string): void {
    const timer = idleTimers.get(threadId);
    if (timer !== undefined) {
      clearTimeout(timer);
      idleTimers.delete(threadId);
    }
  }

  bb.events.on("thread.idle", ({ thread }) => {
    if (store.countQueued(thread.id) === 0) return;
    notify({
      topic: "queue",
      kind: "changed",
      threadId: thread.id,
      projectId: thread.projectId ?? null,
    });
    if (!store.nextArmed(thread.id)) return;
    cancelIdleTimer(thread.id);
    const epoch = bumpEpoch(thread.id);
    const timer = setTimeout(() => {
      idleTimers.delete(thread.id);
      if (threadEpoch.get(thread.id) !== epoch) return;
      void operations.drainOne(thread.id).catch((error) => {
        bb.log.error(`auto-send drain failed: ${errorText(error)}`);
      });
    }, idleDelayMs);
    idleTimers.set(thread.id, timer);
  });

  bb.events.on("thread.active", ({ thread }) => {
    cancelIdleTimer(thread.id);
    bumpEpoch(thread.id);
    // Native queued messages deliver at turn boundaries — nudge any open
    // popover/panel to refetch its "In bb's queue" section, but only for a
    // thread this plugin actually holds something for.
    if (store.countQueued(thread.id) > 0)
      notify({
        topic: "queue",
        kind: "changed",
        threadId: thread.id,
        projectId: thread.projectId ?? null,
      });
  });

  // A failed thread never goes idle, so an armed queue would wait forever
  // behind a banner promising it will send "when the agent finishes". Hold it
  // explicitly instead: pausing is visible, reversible, and says what happened.
  bb.events.on("thread.failed", ({ thread, error }) => {
    cancelIdleTimer(thread.id);
    bumpEpoch(thread.id);
    if (!store.nextArmed(thread.id)) return;
    if (store.isPaused(thread.id)) return;
    store.setPaused(thread.id, true);
    bb.log.warn(
      `thread ${thread.id} failed — auto-send paused with prompts still queued` +
        (error ? `: ${error}` : ""),
    );
    notify({
      topic: "queue",
      kind: "send-failed",
      threadId: thread.id,
      projectId: thread.projectId ?? null,
      message: "Thread failed — auto-send paused, prompts kept.",
    });
  });

  function endThread(thread: { id: string; projectId?: string; title?: string | null; titleFallback?: string | null }): void {
    cancelIdleTimer(thread.id);
    bumpEpoch(thread.id);
    void operations
      .endThread(thread.id, {
        projectId: thread.projectId ?? null,
        title: thread.title ?? thread.titleFallback ?? null,
      })
      .catch((error) => bb.log.error(`thread cleanup failed: ${errorText(error)}`));
  }

  bb.events.on("thread.archived", ({ thread }) => endThread(thread));
  bb.events.on("thread.deleted", ({ thread }) => endThread(thread));

  bb.onDispose(() => {
    // A mine in flight outlives this context by seconds; the flag stops it
    // from logging or publishing through an API that is already gone.
    disposed = true;
    for (const timer of idleTimers.values()) clearTimeout(timer);
    idleTimers.clear();
    threadEpoch.clear();
  });

  // ---- Scheduled sends: fire due prompts regardless of idle state ----
  bb.background.schedule("scheduled-send", "* * * * *", async () => {
    for (const prompt of store.listDue(Date.now())) {
      if (prompt.threadId === null) continue;
      await operations.sendPrompt(prompt, prompt.threadId, "scheduled");
    }
  });

  // ---- Agent awareness ----
  bb.agents.contributeInstructions(({ threadId, projectId }) => {
    if (!threadId) return null;
    const queued = store.countQueued(threadId);
    const project =
      projectId === null || projectId === undefined
        ? 0
        : store.listQueued({ scope: "project", projectId }).length;
    if (queued === 0 && project === 0) return null;
    const parts: string[] = [];
    if (queued > 0)
      parts.push(
        `The user has ${queued} follow-up prompt${queued === 1 ? "" : "s"} queued for this thread ` +
          `(Prompts plugin); they will be injected or auto-sent after the current work. ` +
          `Prefer finishing the current task cleanly over starting new open-ended work.`,
      );
    if (project > 0)
      parts.push(
        `${project} more ${project === 1 ? "prompt is" : "prompts are"} queued for this project — ` +
          `use prompts_list to read them before proposing what to do next.`,
      );
    return parts.join(" ");
  });

  registerAgentTools(bb, { store, operations, notify });

  // ---- @snippet mentions: reference a saved prompt, resolved at send time ----
  bb.ui.registerMentionProvider({
    id: "snippet",
    label: "Snippets",
    triggers: ["@", "~"],
    search({ query, projectId }) {
      return store
        .listSnippets(query, { projectId: projectId ?? null, limit: 8 })
        .snippets.map((snippet) => ({
          id: snippet.id,
          title: snippet.title,
          subtitle:
            snippet.groupName ??
            (snippet.keywords || undefined) ??
            snippet.body.replace(/\s+/g, " ").slice(0, 60),
        }));
    },
    resolve(itemId) {
      const snippet = store.getSnippet(itemId);
      if (!snippet) throw new Error("Snippet no longer exists");
      store.touchSnippet(snippet.id);
      const unfilled = parseTokens(snippet.body);
      return {
        context:
          `# Snippet: ${snippet.title}\n\n${snippet.body}` +
          (unfilled.length > 0
            ? `\n\n(This snippet has unfilled placeholders: ` +
              `${unfilled.map((token) => `{{${token.name}}}`).join(" ")}. Ask the user for them ` +
              `if they matter.)`
            : ""),
      };
    },
  });

  // ---- CLI: bb prompts ----
  bb.cli.register({
    name: "prompts",
    summary:
      "Prompt queue + snippets: stash prompts, auto-send on idle, reusable templates",
    commands: [...CLI_COMMANDS],
    run: createCliRunner({ store, operations, miner, notify }),
  });
}
