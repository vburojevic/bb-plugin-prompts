// Everything that does something, in one place.
//
// Three callers reach these: the RPC handlers, the `bb prompts` CLI, and the
// agent tools. They used to hold three copies of "stash bb's queue" and two of
// "push a prompt", which drifted. The host boundary is a narrow interface so
// tests can drive all of it without a bb server.

import {
  errorText,
  queuedMessageText,
  stashMessages,
  type QueuedMessageLike,
} from "./queued-messages";
import type { Prompt, Scope, ScopeRef, Store } from "./store";
import type { HistoryEntryLike } from "./history";

export const USED_KEEP = 60;

export interface ThreadInfo {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  status: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
}

/** The slice of bb this plugin touches, as plain functions. */
export interface PromptsHost {
  send(threadId: string, text: string): Promise<void>;
  getThread(threadId: string): Promise<ThreadInfo | null>;
  listThreads(options: {
    limit: number;
    archived?: boolean;
  }): Promise<ThreadInfo[]>;
  listProjects(): Promise<ProjectInfo[]>;
  projectHistory(projectId: string, limit: number): Promise<HistoryEntryLike[]>;
  threadHistory(threadId: string, limit: number): Promise<HistoryEntryLike[]>;
  listQueuedMessages(threadId: string): Promise<QueuedMessageLike[]>;
  createQueuedMessage(threadId: string, text: string): Promise<void>;
  deleteQueuedMessage(threadId: string, queuedMessageId: string): Promise<void>;
  sendQueuedMessage(threadId: string, queuedMessageId: string): Promise<void>;
}

export type SignalTopic = "queue" | "snippets" | "suggestions" | "native";
export type SignalKind =
  | "changed"
  | "send-failed"
  | "auto-sent"
  | "promoted";

export interface Signal {
  topic: SignalTopic;
  kind: SignalKind;
  threadId: string | null;
  projectId: string | null;
  message?: string;
}

export interface OperationsDeps {
  store: Store;
  host: PromptsHost;
  notify(signal: Signal): void;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  /** What happens to a thread's leftovers when the thread ends. */
  threadEndMode(): "promote" | "delete";
}

export interface SendOutcome {
  sent: boolean;
  error: string | null;
}

export function createOperations(deps: OperationsDeps) {
  const { store, host, notify, log } = deps;

  // thread -> project. Threads never change project, so this only ever grows
  // by one entry per thread the user actually queues into.
  const projectOfThread = new Map<string, string | null>();

  async function resolveProjectId(
    threadId: string | null,
  ): Promise<string | null> {
    if (threadId === null) return null;
    const cached = projectOfThread.get(threadId);
    if (cached !== undefined) return cached;
    try {
      const thread = await host.getThread(threadId);
      const projectId = thread?.projectId ?? null;
      projectOfThread.set(threadId, projectId);
      return projectId;
    } catch {
      // A thread we cannot read just means "no project association yet"; the
      // prompt is still queued, it simply cannot be promoted later.
      return null;
    }
  }

  function forgetThread(threadId: string): void {
    projectOfThread.delete(threadId);
  }

  /**
   * Queue a prompt, filling in the project when the caller did not know it.
   * Thread-scoped prompts carry their project so they can outlive the thread.
   */
  async function addPrompt(input: {
    text: string;
    scope: Scope;
    threadId: string | null;
    projectId: string | null;
    autoSend?: boolean;
    sendAt?: number | null;
  }): Promise<{ prompt: Prompt | null; error: string | null }> {
    const projectId =
      input.projectId ??
      (input.scope === "global" ? null : await resolveProjectId(input.threadId));
    try {
      const prompt = store.addPrompt({ ...input, projectId });
      notify({
        topic: "queue",
        kind: "changed",
        threadId: prompt.threadId,
        projectId: prompt.projectId,
      });
      return { prompt, error: null };
    } catch (error) {
      return { prompt: null, error: errorText(error) };
    }
  }

  /**
   * Claim a prompt and deliver it to a thread. The claim is an atomic UPDATE,
   * so a duplicate idle event or a sweep racing the UI can never double-send;
   * a failed delivery puts the prompt back with the error attached.
   */
  async function sendPrompt(
    prompt: Prompt,
    threadId: string,
    via: "auto-send" | "scheduled" | "cross-thread" | "cli" | "tool",
  ): Promise<SendOutcome> {
    const claimed = store.claimPrompt(prompt.id, via);
    if (!claimed) return { sent: false, error: "Already sent or deleted." };
    try {
      await host.send(threadId, claimed.text);
      store.pruneUsed(USED_KEEP);
      notify({
        topic: "queue",
        kind: "auto-sent",
        threadId: claimed.threadId,
        projectId: claimed.projectId,
      });
      if (claimed.threadId !== threadId)
        notify({
          topic: "queue",
          kind: "changed",
          threadId,
          projectId: null,
        });
      log.info(`sent prompt ${claimed.id} to ${threadId} (${via})`);
      return { sent: true, error: null };
    } catch (error) {
      const message = errorText(error);
      store.requeuePrompt(claimed.id, message);
      notify({
        topic: "queue",
        kind: "send-failed",
        threadId: claimed.threadId,
        projectId: claimed.projectId,
        message,
      });
      log.error(`send failed for prompt ${claimed.id}: ${message}`);
      return { sent: false, error: message };
    }
  }

  /** Send one queued prompt by id, checking it is still sendable. */
  async function sendById(
    id: string,
    threadId: string,
    via: "cross-thread" | "cli" | "tool",
  ): Promise<SendOutcome> {
    const prompt = store.getPrompt(id);
    if (!prompt || prompt.status !== "queued")
      return { sent: false, error: "Prompt is no longer queued." };
    return sendPrompt(prompt, threadId, via);
  }

  /** The next armed prompt for a thread, sent unless the thread is paused. */
  async function drainOne(threadId: string): Promise<SendOutcome | null> {
    if (store.isPaused(threadId)) return null;
    const next = store.nextArmed(threadId);
    if (!next) return null;
    return sendPrompt(next, threadId, "auto-send");
  }

  // ---- bb's native queue ----

  async function listNative(
    threadId: string,
  ): Promise<{ items: { id: string; text: string; updatedAt: number }[]; error: string | null }> {
    try {
      const messages = await host.listQueuedMessages(threadId);
      return {
        items: messages.map((message) => ({
          id: message.id,
          text: queuedMessageText(message),
          updatedAt: message.updatedAt,
        })),
        error: null,
      };
    } catch (error) {
      return { items: [], error: errorText(error) };
    }
  }

  async function pushToNative(
    id: string,
    threadId: string,
  ): Promise<{ pushed: boolean; error: string | null }> {
    const claimed = store.claimPrompt(id, "bb-queue");
    if (!claimed) return { pushed: false, error: "Prompt is no longer queued." };
    try {
      await host.createQueuedMessage(threadId, claimed.text);
      store.pruneUsed(USED_KEEP);
      notify({
        topic: "native",
        kind: "changed",
        threadId,
        projectId: claimed.projectId,
      });
      return { pushed: true, error: null };
    } catch (error) {
      const message = errorText(error);
      store.requeuePrompt(claimed.id, message);
      notify({
        topic: "queue",
        kind: "changed",
        threadId: claimed.threadId,
        projectId: claimed.projectId,
      });
      return { pushed: false, error: message };
    }
  }

  function stashDeps(threadId: string, projectId: string | null) {
    return {
      deleteMessage: (target: string, queuedMessageId: string) =>
        host.deleteQueuedMessage(target, queuedMessageId),
      stash: (text: string) =>
        store.addPrompt({
          text,
          scope: "thread" as const,
          threadId,
          projectId,
          autoSend: false,
        }),
      unstash: (id: string) => {
        store.deletePrompt(id);
      },
    };
  }

  async function stashAllNative(
    threadId: string,
  ): Promise<{ stashed: number; skipped: number; error: string | null }> {
    let messages: QueuedMessageLike[];
    try {
      messages = await host.listQueuedMessages(threadId);
    } catch (error) {
      return { stashed: 0, skipped: 0, error: errorText(error) };
    }
    const projectId = await resolveProjectId(threadId);
    const outcome = await stashMessages(
      threadId,
      messages,
      stashDeps(threadId, projectId),
    );
    if (outcome.stashed > 0)
      notify({ topic: "queue", kind: "changed", threadId, projectId });
    return outcome;
  }

  async function stashOneNative(
    threadId: string,
    queuedMessageId: string,
  ): Promise<{ prompt: Prompt | null; error: string | null }> {
    let messages: QueuedMessageLike[];
    try {
      messages = await host.listQueuedMessages(threadId);
    } catch (error) {
      return { prompt: null, error: errorText(error) };
    }
    const message = messages.find((entry) => entry.id === queuedMessageId);
    if (!message) return { prompt: null, error: "Message is no longer queued." };
    if (!queuedMessageText(message))
      return { prompt: null, error: "Only text messages can be stashed." };
    const projectId = await resolveProjectId(threadId);
    const outcome = await stashMessages(
      threadId,
      [message],
      stashDeps(threadId, projectId),
    );
    if (outcome.stashed === 0)
      return { prompt: null, error: "bb would not release that message." };
    // The stash appends, so the newest tail entry is the one just written.
    const queue = store.listQueued({ scope: "thread", threadId });
    notify({ topic: "queue", kind: "changed", threadId, projectId });
    return { prompt: queue[queue.length - 1] ?? null, error: null };
  }

  async function sendNativeNow(
    threadId: string,
    queuedMessageId: string,
  ): Promise<SendOutcome> {
    try {
      await host.sendQueuedMessage(threadId, queuedMessageId);
      notify({ topic: "native", kind: "changed", threadId, projectId: null });
      return { sent: true, error: null };
    } catch (error) {
      return { sent: false, error: errorText(error) };
    }
  }

  // ---- Snippets ----

  /** Queue a whole group in writing order: a checklist, in one action. */
  async function queueSnippetGroup(
    ref: ScopeRef,
    groupName: string,
  ): Promise<{ queued: number; error: string | null }> {
    const snippets = store.listGroupSnippets(groupName);
    if (snippets.length === 0)
      return { queued: 0, error: `No snippets in group "${groupName}".` };
    const projectId =
      ref.projectId ??
      (ref.scope === "global" ? null : await resolveProjectId(ref.threadId ?? null));
    let queued = 0;
    for (const snippet of snippets) {
      try {
        store.addPrompt({
          text: snippet.body,
          scope: ref.scope,
          threadId: ref.threadId ?? null,
          projectId,
          autoSend: false,
        });
        store.touchSnippet(snippet.id);
        queued += 1;
      } catch (error) {
        return { queued, error: errorText(error) };
      }
    }
    notify({
      topic: "queue",
      kind: "changed",
      threadId: ref.threadId ?? null,
      projectId,
    });
    return { queued, error: null };
  }

  // ---- Thread lifecycle ----

  /**
   * A thread ended. Its queued prompts are the user's writing, not the
   * thread's — by default they move to the project so the next session in that
   * project still has them, which is the whole reason a project scope exists.
   */
  async function endThread(
    threadId: string,
    context: { projectId?: string | null; title?: string | null } = {},
  ): Promise<{ promoted: number; deleted: number }> {
    const owned = store.listQueued({ scope: "thread", threadId });
    store.forgetThread(threadId);
    if (owned.length === 0) {
      forgetThread(threadId);
      return { promoted: 0, deleted: 0 };
    }
    if (deps.threadEndMode() === "delete") {
      const deleted = store.deleteThreadPrompts(threadId);
      forgetThread(threadId);
      notify({ topic: "queue", kind: "changed", threadId, projectId: null });
      log.info(`thread ${threadId} ended: dropped ${deleted} queued prompt(s)`);
      return { promoted: 0, deleted };
    }
    const projectId =
      context.projectId ??
      owned[0]!.projectId ??
      (await resolveProjectId(threadId));
    const promoted = store.promoteThreadPrompts(threadId, {
      projectId,
      threadTitle: context.title ?? owned[0]!.originThreadTitle ?? null,
    });
    forgetThread(threadId);
    if (promoted.length > 0) {
      notify({
        topic: "queue",
        kind: "promoted",
        threadId,
        projectId,
        message: `${promoted.length} prompt${promoted.length === 1 ? "" : "s"} kept${
          projectId ? " for the project" : " globally"
        }`,
      });
      log.info(
        `thread ${threadId} ended: kept ${promoted.length} prompt(s) on ` +
          `${projectId ? `project ${projectId}` : "the global queue"}`,
      );
    }
    return { promoted: promoted.length, deleted: 0 };
  }

  return {
    resolveProjectId,
    forgetThread,
    addPrompt,
    sendPrompt,
    sendById,
    drainOne,
    listNative,
    pushToNative,
    stashAllNative,
    stashOneNative,
    sendNativeNow,
    queueSnippetGroup,
    endThread,
  };
}

export type Operations = ReturnType<typeof createOperations>;
