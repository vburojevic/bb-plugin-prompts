// AI quick replies: the service the RPC answers from.
//
// One generation per thread per turn. A read never waits on the model: it
// answers from the cache, or starts a generation and answers "pending", and
// the finished replies arrive over realtime. Only the frontend reads, and only
// for a thread on screen, so threads nobody looks at never cost a model call.

import {
  AI_REPLY_LIMIT,
  buildSuggestPrompt,
  lightestReasoning,
  parseSuggestReply,
  rankHabits,
  smallModelFor,
  type AiReply,
  type CatalogModel,
  type ReplyFeedback,
  type Transcript,
} from "./ai-replies";

export type AiReplyStatus = "off" | "empty" | "pending" | "ready" | "error";

export interface AiReplyRead {
  status: AiReplyStatus;
  /** The turn these replies answer; the frontend drops a read for an older one. */
  turnKey: string | null;
  replies: AiReply[];
  error: string | null;
  /** The model that wrote them, for the settings line and debugging. */
  model: string | null;
}

export interface ThreadMeta {
  id: string;
  providerId: string | null;
  projectId: string | null;
  environmentId: string | null;
  title: string | null;
}

export interface ModelRequest {
  providerId: string;
  model: string | null;
  reasoningLevel: string | null;
  prompt: string;
  thread: ThreadMeta;
}

export interface AiServiceDeps {
  enabled(): boolean;
  transcript(threadId: string): Promise<Transcript>;
  thread(threadId: string): Promise<ThreadMeta | null>;
  /** The short prompts the user types most, most typed first. */
  habits(): Promise<{ text: string; count: number }[]>;
  snippets(projectId: string | null): { id: string; title: string; body: string }[];
  feedback(projectId: string | null): ReadonlyMap<string, ReplyFeedback>;
  /** Replies the user dismissed lately in this project. */
  avoid(projectId: string | null): string[];
  catalog(providerId: string): Promise<CatalogModel[] | null>;
  overrides(): ReadonlyMap<string, string>;
  run(request: ModelRequest, signal: AbortSignal): Promise<string>;
  kvGet(key: string): Promise<unknown>;
  kvSet(key: string, value: unknown): Promise<void>;
  /** Announce that a thread's replies changed. */
  publish(threadId: string, projectId: string | null): void;
  log: { info(message: string): void; warn(message: string): void };
  isDisposed(): boolean;
  now?: () => number;
  timeoutMs?: number;
}

/** Longest a generation may take before the row stays on the usual chips. */
export const AI_TIMEOUT_MS = 120_000;
const KV_PREFIX = "quick-replies:v1:";

interface Entry {
  turnKey: string;
  status: "pending" | "ready" | "error";
  replies: AiReply[];
  error: string | null;
  model: string | null;
  controller: AbortController | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAiReplies(deps: AiServiceDeps) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? AI_TIMEOUT_MS;
  const entries = new Map<string, Entry>();

  const view = (entry: Entry): AiReplyRead => ({
    status: entry.status,
    turnKey: entry.turnKey,
    replies: entry.replies,
    error: entry.error,
    model: entry.model,
  });

  async function persisted(threadId: string): Promise<Entry | null> {
    try {
      const value = (await deps.kvGet(KV_PREFIX + threadId)) as
        | { turnKey?: unknown; replies?: unknown; model?: unknown }
        | undefined;
      if (!value || typeof value.turnKey !== "string" || !Array.isArray(value.replies)) return null;
      return {
        turnKey: value.turnKey,
        status: "ready",
        replies: value.replies as AiReply[],
        error: null,
        model: typeof value.model === "string" ? value.model : null,
        controller: null,
      };
    } catch {
      return null;
    }
  }

  async function generate(
    threadId: string,
    transcript: Transcript,
    outcome: "finished" | "interrupted",
    entry: Entry,
  ): Promise<void> {
    const signal = entry.controller!.signal;
    const startedAt = now();
    let projectId: string | null = null;
    try {
      const meta = await deps.thread(threadId);
      if (!meta?.providerId) throw new Error("This thread has no provider to ask");
      projectId = meta.projectId;
      const habits = rankHabits(await deps.habits(), deps.feedback(meta.projectId));
      const snippets = deps.snippets(meta.projectId);
      const catalog = await deps.catalog(meta.providerId).catch(() => null);
      const model = smallModelFor(meta.providerId, catalog, deps.overrides());
      entry.model = model;
      const prompt = buildSuggestPrompt({
        title: meta.title,
        outcome,
        messages: transcript.messages,
        habits,
        snippets,
        voice: [
          ...transcript.messages.filter((m) => m.role === "user").map((m) => m.text),
          ...habits.slice(0, 4).map((habit) => habit.text),
        ],
        avoid: deps.avoid(meta.projectId),
        limit: AI_REPLY_LIMIT,
      });
      const raw = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          entry.controller?.abort();
          reject(new Error("The model took too long to answer"));
        }, timeoutMs);
        deps
          .run(
            {
              providerId: meta.providerId!,
              model,
              reasoningLevel: lightestReasoning(catalog?.find((entry) => entry.model === model)),
              prompt,
              thread: meta,
            },
            signal,
          )
          .then(resolve, reject)
          .finally(() => clearTimeout(timer));
      });
      if (signal.aborted || deps.isDisposed()) return;
      const replies = parseSuggestReply(raw, { habits, snippets });
      if (replies.length === 0) throw new Error("The model answered without usable replies");
      entry.status = "ready";
      entry.replies = replies;
      entry.error = null;
      deps.log.info(
        `quick replies for ${threadId}: ${replies.length} from ${model ?? "the provider default"} ` +
          `in ${Math.round((now() - startedAt) / 100) / 10}s`,
      );
      void deps
        .kvSet(KV_PREFIX + threadId, { turnKey: entry.turnKey, replies, model })
        .catch(() => {});
    } catch (error) {
      // A newer turn or a regenerate replaced this entry; its failure is moot.
      if (deps.isDisposed() || entries.get(threadId) !== entry) return;
      entry.status = "error";
      entry.error = message(error);
      deps.log.warn(`quick replies for ${threadId} failed: ${entry.error}`);
    } finally {
      entry.controller = null;
    }
    if (!deps.isDisposed() && entries.get(threadId) === entry) deps.publish(threadId, projectId);
  }

  /**
   * The replies for the thread's latest turn. A new turn, or `refresh`,
   * starts a generation; anything else answers from the cache.
   */
  async function read(
    threadId: string,
    options: { outcome: "finished" | "interrupted"; refresh: boolean },
  ): Promise<AiReplyRead> {
    if (!deps.enabled())
      return { status: "off", turnKey: null, replies: [], error: null, model: null };
    const transcript = await deps.transcript(threadId);
    if (transcript.turnKey === null)
      return { status: "empty", turnKey: null, replies: [], error: null, model: null };

    let entry = entries.get(threadId) ?? null;
    if (entry === null || entry.turnKey !== transcript.turnKey) {
      const saved = await persisted(threadId);
      if (saved && saved.turnKey === transcript.turnKey) {
        entries.set(threadId, saved);
        entry = saved;
      }
    }
    const current = entry !== null && entry.turnKey === transcript.turnKey;
    if (current && !options.refresh) return view(entry!);
    if (current && entry!.status === "pending") return view(entry!);

    entry?.controller?.abort();
    const fresh: Entry = {
      turnKey: transcript.turnKey,
      status: "pending",
      replies: [],
      error: null,
      model: null,
      controller: new AbortController(),
    };
    entries.set(threadId, fresh);
    void generate(threadId, transcript, options.outcome, fresh);
    return view(fresh);
  }

  /** Stop every generation; the plugin is unloading. */
  function dispose(): void {
    for (const entry of entries.values()) entry.controller?.abort();
    entries.clear();
  }

  return { read, dispose };
}

export type AiReplies = ReturnType<typeof createAiReplies>;
