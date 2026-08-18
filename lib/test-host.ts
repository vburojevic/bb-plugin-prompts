// A fake bb host, just faithful enough to drive server.ts end to end.
//
// The plugin's riskiest code is not in the store — it is the wiring: the idle
// timer, the lifecycle handlers, the CLI, the tools. None of that was
// reachable from a unit test before this existed.
import Database from "better-sqlite3";
import type { Signal } from "./operations";

export interface FakeThread {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  status: string;
}

export interface FakeQueuedMessage {
  id: string;
  content: { type: string; text?: string }[];
  updatedAt: number;
}

export interface FakeHostOptions {
  settings?: Record<string, string>;
  /** Reject `threads.send` with this message instead of recording it. */
  sendError?: string | null;
}

export function createFakeHost(options: FakeHostOptions = {}) {
  const db = new Database(":memory:");
  const kv = new Map<string, unknown>();
  const signals: Signal[] = [];
  const logs: { level: string; message: string }[] = [];
  const threads = new Map<string, FakeThread>();
  const queued = new Map<string, FakeQueuedMessage[]>();
  const sends: { threadId: string; text: string }[] = [];
  const promptHistory = new Map<string, unknown[]>();
  const projects: { id: string; name: string }[] = [];

  let settingValues: Record<string, string> = { ...options.settings };
  let sendError = options.sendError ?? null;
  const settingsListeners: ((
    next: Record<string, string>,
    prev: Record<string, string>,
  ) => void)[] = [];

  const rpcHandlers: Record<string, (input: unknown) => unknown> = {};
  const eventHandlers = new Map<string, ((payload: unknown) => void)[]>();
  const schedules = new Map<string, () => Promise<void> | void>();
  const tools = new Map<
    string,
    {
      parameters: { parse(value: unknown): unknown };
      execute(params: unknown, ctx: unknown): unknown;
    }
  >();
  const mentionProviders = new Map<
    string,
    {
      search(context: unknown): unknown;
      resolve(itemId: string): unknown;
    }
  >();
  const disposers: (() => void)[] = [];
  let cli: {
    run(argv: string[], ctx: unknown): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  } | null = null;
  let instructions: ((ctx: { threadId: string; projectId: string }) => string | null) | null =
    null;

  function assertThread(threadId: string): FakeThread {
    const thread = threads.get(threadId);
    if (!thread) throw new Error(`No thread ${threadId}`);
    return thread;
  }

  const bb = {
    pluginId: "prompts",
    log: {
      debug: (message: string) => logs.push({ level: "debug", message }),
      info: (message: string) => logs.push({ level: "info", message }),
      warn: (message: string) => logs.push({ level: "warn", message }),
      error: (message: string) => logs.push({ level: "error", message }),
    },
    settings: {
      define: () => ({
        get: async () => ({ ...settingValues }),
        onChange: (listener: (next: Record<string, string>, prev: Record<string, string>) => void) =>
          settingsListeners.push(listener),
      }),
    },
    storage: {
      database: () => db,
      migrate: (target: typeof db, statements: string[]) => {
        for (const statement of statements) target.exec(statement);
      },
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
        delete: async (key: string) => {
          kv.delete(key);
        },
        list: async (prefix?: string) =>
          [...kv.keys()].filter((key) => !prefix || key.startsWith(prefix)),
      },
    },
    realtime: {
      publish: (_channel: string, payload: unknown) => {
        signals.push(payload as Signal);
      },
    },
    rpc: {
      register: (_contract: unknown, handlers: Record<string, (input: unknown) => unknown>) => {
        Object.assign(rpcHandlers, handlers);
      },
    },
    events: {
      on: (event: string, handler: (payload: unknown) => void) => {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
      },
    },
    background: {
      schedule: (name: string, _cron: string, handler: () => Promise<void> | void) => {
        schedules.set(name, handler);
      },
      service: () => {},
    },
    agents: {
      registerTool: (tool: {
        name: string;
        parameters: { parse(value: unknown): unknown };
        execute(params: unknown, ctx: unknown): unknown;
      }) => {
        tools.set(tool.name, tool);
      },
      contributeInstructions: (
        provider: (ctx: { threadId: string; projectId: string }) => string | null,
      ) => {
        instructions = provider;
      },
      configure: () => {},
    },
    ui: {
      registerMentionProvider: (provider: {
        id: string;
        search(context: unknown): unknown;
        resolve(itemId: string): unknown;
      }) => {
        mentionProviders.set(provider.id, provider);
      },
      requestInput: async () => ({ outcome: "cancelled" as const }),
    },
    cli: {
      register: (registration: {
        run(argv: string[], ctx: unknown): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
      }) => {
        cli = registration;
      },
    },
    onDispose: (hook: () => void) => disposers.push(hook),
    status: { needsConfiguration: () => {} },
    sdk: {
      threads: {
        send: async ({ threadId, input }: { threadId: string; input: { text?: string }[] }) => {
          if (sendError !== null) throw new Error(sendError);
          assertThread(threadId);
          sends.push({ threadId, text: input.map((part) => part.text ?? "").join("\n") });
          return { id: "msg" };
        },
        get: async ({ threadId }: { threadId: string }) => assertThread(threadId),
        list: async ({ limit }: { limit?: number } = {}) =>
          [...threads.values()].slice(0, limit ?? 100),
        promptHistory: async ({ threadId }: { threadId: string }) =>
          promptHistory.get(`thread:${threadId}`) ?? [],
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) => {
            assertThread(threadId);
            return queued.get(threadId) ?? [];
          },
          create: async ({
            threadId,
            input,
          }: {
            threadId: string;
            input: { type: string; text?: string }[];
          }) => {
            const list = queued.get(threadId) ?? [];
            list.push({
              id: `qm_${list.length + 1}`,
              content: input,
              updatedAt: 1,
            });
            queued.set(threadId, list);
            return { id: `qm_${list.length}` };
          },
          delete: async ({
            threadId,
            queuedMessageId,
          }: {
            threadId: string;
            queuedMessageId: string;
          }) => {
            const list = queued.get(threadId) ?? [];
            const index = list.findIndex((message) => message.id === queuedMessageId);
            if (index < 0) throw new Error("no such queued message");
            list.splice(index, 1);
            queued.set(threadId, list);
          },
          send: async ({
            threadId,
            queuedMessageId,
          }: {
            threadId: string;
            queuedMessageId: string;
          }) => {
            const list = queued.get(threadId) ?? [];
            const index = list.findIndex((message) => message.id === queuedMessageId);
            if (index < 0) throw new Error("no such queued message");
            const [message] = list.splice(index, 1);
            sends.push({
              threadId,
              text: message!.content.map((part) => part.text ?? "").join("\n"),
            });
          },
        },
      },
      projects: {
        list: async () => projects,
        promptHistory: async ({ projectId }: { projectId: string }) =>
          promptHistory.get(`project:${projectId}`) ?? [],
      },
    },
  };

  const harness = {
    db,
    signals,
    logs,
    sends,
    queued,
    kv,
    /** Signals of one topic, newest last. */
    signalsFor: (topic: Signal["topic"]) =>
      signals.filter((signal) => signal.topic === topic),
    addThread(thread: Partial<FakeThread> & { id: string }) {
      const full: FakeThread = {
        projectId: "prj_1",
        title: thread.id,
        titleFallback: null,
        status: "idle",
        ...thread,
      };
      threads.set(full.id, full);
      return full;
    },
    addProject(project: { id: string; name: string }) {
      projects.push(project);
    },
    setPromptHistory(key: string, entries: unknown[]) {
      promptHistory.set(key, entries);
    },
    setSendError(message: string | null) {
      sendError = message;
    },
    async callRpc<T = unknown>(method: string, input: unknown): Promise<T> {
      const handler = rpcHandlers[method];
      if (!handler) throw new Error(`No rpc handler ${method}`);
      // Round-trip through JSON like the wire does.
      return (await handler(JSON.parse(JSON.stringify(input ?? null)))) as T;
    },
    emit(event: string, payload: unknown) {
      for (const handler of eventHandlers.get(event) ?? []) handler(payload);
    },
    async runSchedule(name: string) {
      await schedules.get(name)?.();
    },
    async runCli(argv: string[], ctx: { threadId?: string; projectId?: string } = {}) {
      if (!cli) throw new Error("no cli registered");
      return cli.run(argv, ctx);
    },
    async callTool(name: string, params: unknown, ctx: { threadId?: string; projectId?: string } = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`No tool ${name}`);
      return tool.execute(tool.parameters.parse(params), ctx);
    },
    toolNames: () => [...tools.keys()],
    mention(id: string) {
      const provider = mentionProviders.get(id);
      if (!provider) throw new Error(`No mention provider ${id}`);
      return provider;
    },
    instructionsFor(ctx: { threadId: string; projectId: string }) {
      return instructions?.(ctx) ?? null;
    },
    async setSettings(next: Record<string, string>) {
      const prev = settingValues;
      settingValues = { ...settingValues, ...next };
      for (const listener of settingsListeners) listener(settingValues, prev);
    },
    dispose() {
      for (const hook of [...disposers].reverse()) hook();
    },
  };

  return { bb: bb as never, harness };
}

export type FakeHarness = ReturnType<typeof createFakeHost>["harness"];
