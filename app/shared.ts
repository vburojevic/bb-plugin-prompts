// Types, formatting, and the realtime/fetch plumbing every surface shares.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBbContext,
  useComposerView,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "../lib/contract";
import {
  EMPTY_QUEUE,
  type LoadState,
  type QueueData,
  type QueueScope,
  type Signal,
  type SnippetDto,
} from "./format";

// One import for consumers: the pure half re-exported through the hook half.
export * from "./format";
export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

// ---------------------------------------------------------------------------
// Direct rpc
// ---------------------------------------------------------------------------

/**
 * Rpc for host-rendered callbacks (the composer's plus-menu rows) that cannot
 * use the useRpc hook — they are not React components. Same wire as the hook:
 * the local-auth plugin rpc route.
 */
export async function callRpcDirect(
  method: string,
  input: unknown,
): Promise<unknown> {
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

// ---------------------------------------------------------------------------
// Composer / route scope
// ---------------------------------------------------------------------------

/** Thread the composer's messages land in, or null on the new-thread screen. */
export function useComposerThreadId(): string | null {
  const view = useComposerView();
  return composerThreadIdFromScope(view.scope);
}

export function composerThreadIdFromScope(scope: {
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

export function composerProjectIdFromScope(scope: {
  kind: string;
  projectId?: string | null;
}): string | null {
  return scope.projectId ?? null;
}

/**
 * The project a composer surface belongs to. The composer scope knows it for
 * new-thread and side-chat composers; inside a thread the route does.
 */
export function useComposerProjectId(): string | null {
  const view = useComposerView();
  const context = useBbContext();
  return composerProjectIdFromScope(view.scope) ?? context.projectId ?? null;
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/**
 * Subscribe to this plugin's signals, filtered by topic and by whose state
 * changed, and coalesced — a busy machine emits idle/active transitions in
 * bursts, and every one of them used to cost a full refetch in every mounted
 * surface.
 */
export function usePromptSignal(
  topics: Signal["topic"][],
  scope: QueueScope | null,
  handler: (signal: Signal) => void,
  options: { debounceMs?: number } = {},
): void {
  const debounceMs = options.debounceMs ?? 120;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const topicKey = topics.join(",");
  const pending = useRef<Signal | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  useRealtime("prompts", (payload) => {
    const signal = payload as Signal;
    if (!topicKey.split(",").includes(signal.topic)) return;
    if (scope !== null && signal.threadId !== null && signal.projectId !== null) {
      // A signal naming both an owner and a project is only interesting to a
      // surface watching one of them.
      const mine =
        signal.threadId === scope.threadId || signal.projectId === scope.projectId;
      if (!mine) return;
    } else if (scope !== null && signal.threadId !== null) {
      if (signal.threadId !== scope.threadId) return;
    }
    pending.current = signal;
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const latest = pending.current;
      pending.current = null;
      if (latest) handlerRef.current(latest);
    }, debounceMs);
  });
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

/**
 * The queue for one surface. Exposes a real load state: a failed fetch used to
 * render as "No queued prompts", which is the one message guaranteed to make
 * someone retype a prompt they had already saved.
 */
export function useQueue(scope: QueueScope, enabled = true) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<QueueData>(EMPTY_QUEUE);
  const [state, setState] = useState<LoadState>(enabled ? "loading" : "ready");
  const { threadId, projectId } = scope;

  const refresh = useCallback(() => {
    if (!enabled) return;
    void rpc
      .call("listPrompts", { threadId, projectId })
      .then((result) => {
        setData(result);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, [rpc, threadId, projectId, enabled]);

  useEffect(refresh, [refresh]);
  usePromptSignal(["queue"], { threadId, projectId }, refresh);

  return { data, state, refresh, rpc };
}

export function useSnippets(
  rpc: Rpc,
  query: string,
  projectId: string | null,
  enabled = true,
) {
  const [snippets, setSnippets] = useState<SnippetDto[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>(enabled ? "loading" : "ready");

  const refresh = useCallback(() => {
    if (!enabled) return;
    void rpc
      .call("listSnippets", { query, projectId })
      .then((result) => {
        setSnippets(result.snippets);
        setTotal(result.total);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, [rpc, query, projectId, enabled]);

  useEffect(refresh, [refresh]);
  usePromptSignal(["snippets"], null, refresh);

  return { snippets, total, state, refresh };
}

/** Groups present in a snippet list, for the filter chips. */
export function useSnippetGroups(snippets: SnippetDto[]): string[] {
  return useMemo(
    () =>
      [
        ...new Set(
          snippets
            .map((snippet) => snippet.groupName)
            .filter((name): name is string => name !== null),
        ),
      ].sort(),
    [snippets],
  );
}
