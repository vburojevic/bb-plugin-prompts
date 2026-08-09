// bb-plugin-prompts — backend entry.
//
// Two complementary stores over one SQLite db:
// - QUEUE: one-shot prompts written while agents are busy, scoped to a
//   thread or global. Injected into the composer (consume + undo), sent to
//   any thread, ARMED to auto-send when their thread goes idle, or scheduled
//   for a specific time. Claims are atomic UPDATEs so duplicate idle events
//   or sweep races can never double-send.
// - SNIPPETS: reusable, titled, keyworded prompts with {{fill-in}} tokens,
//   merged in from the retired prompt-snippets plugin. Inserting never
//   consumes them.
//
// Auto-send waits an idle-delay grace period (setting) and is cancelled if
// the thread goes active again — thread.idle also fires when the agent is
// waiting for the user's answer, and barging into that exchange is wrong.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { createStore, MIGRATIONS, type Prompt } from "./lib/store";

const REALTIME_CHANNEL = "prompts";
const PROMPT_TEXT_CAP = 32_000;
const USED_KEEP = 60;
const DEFAULT_IDLE_DELAY_SECONDS = 20;

const scopeSchema = z.enum(["thread", "global"]);

const promptSchema = z.object({
  id: z.string(),
  scope: scopeSchema,
  threadId: z.string().nullable(),
  text: z.string(),
  status: z.enum(["queued", "used"]),
  autoSend: z.boolean(),
  sendAt: z.number().nullable(),
  position: z.number(),
  lastError: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  usedAt: z.number().nullable(),
  usedVia: z
    .enum(["inject", "auto-send", "cli", "scheduled", "cross-thread"])
    .nullable(),
});

const snippetSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  description: z.string(),
  keywords: z.string(),
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
  useCount: z.number(),
  lastUsedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const rpcContract = defineRpcContract({
  listPrompts: {
    input: z.object({ threadId: z.string().nullable() }).strict(),
    output: z.object({
      threadPrompts: z.array(promptSchema),
      globalPrompts: z.array(promptSchema),
      recentlyUsed: z.array(promptSchema),
      paused: z.boolean(),
    }),
  },
  addPrompt: {
    input: z
      .object({
        text: z.string().min(1).max(PROMPT_TEXT_CAP),
        scope: scopeSchema,
        threadId: z.string().nullable(),
        autoSend: z.boolean(),
        sendAt: z.number().nullable().optional(),
      })
      .strict(),
    output: z.object({ prompt: promptSchema }),
  },
  updatePrompt: {
    input: z
      .object({
        id: z.string(),
        text: z.string().min(1).max(PROMPT_TEXT_CAP).optional(),
        autoSend: z.boolean().optional(),
        scope: scopeSchema.optional(),
        sendAt: z.number().nullable().optional(),
      })
      .strict(),
    output: z.object({ prompt: promptSchema.nullable() }),
  },
  deletePrompt: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ deleted: z.boolean(), prompt: promptSchema.nullable() }),
  },
  consumePrompt: {
    input: z.object({ id: z.string(), via: z.enum(["inject", "cli"]) }).strict(),
    output: z.object({ prompt: promptSchema.nullable() }),
  },
  restorePrompt: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ prompt: promptSchema.nullable() }),
  },
  reorderPrompts: {
    input: z
      .object({
        scope: scopeSchema,
        threadId: z.string().nullable(),
        ids: z.array(z.string()).max(500),
      })
      .strict(),
    output: z.object({ reordered: z.boolean() }),
  },
  armAll: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ armed: z.number() }),
  },
  disarmThread: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ disarmed: z.number() }),
  },
  setPaused: {
    input: z.object({ threadId: z.string(), paused: z.boolean() }).strict(),
    output: z.object({ paused: z.boolean() }),
  },
  listTargets: {
    input: z.object({ excludeThreadId: z.string().nullable() }).strict(),
    output: z.object({
      threads: z.array(z.object({ id: z.string(), title: z.string() })),
    }),
  },
  sendPromptToThread: {
    input: z.object({ id: z.string(), threadId: z.string() }).strict(),
    output: z.object({ sent: z.boolean(), error: z.string().nullable() }),
  },
  listSnippets: {
    input: z.object({ query: z.string() }).strict(),
    output: z.object({ snippets: z.array(snippetSchema) }),
  },
  addSnippet: {
    input: z
      .object({
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(PROMPT_TEXT_CAP),
        description: z.string().max(500).optional(),
        keywords: z.string().max(200).optional(),
        groupName: z.string().max(100).nullable().optional(),
      })
      .strict(),
    output: z.object({ snippet: snippetSchema }),
  },
  updateSnippet: {
    input: z
      .object({
        id: z.string(),
        title: z.string().min(1).max(200).optional(),
        body: z.string().min(1).max(PROMPT_TEXT_CAP).optional(),
        description: z.string().max(500).optional(),
        keywords: z.string().max(200).optional(),
        groupName: z.string().max(100).nullable().optional(),
      })
      .strict(),
    output: z.object({ snippet: snippetSchema.nullable() }),
  },
  deleteSnippet: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  useSnippet: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ snippet: snippetSchema.nullable() }),
  },
});

/** CLI `--at` values: +30s, +5m, +2h, +1d, or an ISO-8601 timestamp. */
export function parseWhen(raw: string, nowMs: number): number | null {
  const relative = /^\+(\d+)([smhd])$/.exec(raw.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      relative[2] as "s" | "m" | "h" | "d"
    ];
    return nowMs + amount * unit;
  }
  const absolute = Date.parse(raw);
  return Number.isNaN(absolute) ? null : absolute;
}

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
  });

  function notify(
    threadId: string | null,
    kind: "changed" | "send-failed" | "auto-sent" = "changed",
    message?: string,
  ): void {
    try {
      bb.realtime.publish(REALTIME_CHANNEL, { kind, threadId, message });
    } catch {
      // Best-effort; the UI refetches when reopened.
    }
  }

  const pausedKey = (threadId: string) => `paused:${threadId}`;
  async function isPaused(threadId: string): Promise<boolean> {
    return (await bb.storage.kv.get<boolean>(pausedKey(threadId))) === true;
  }

  async function sendPrompt(
    prompt: Prompt,
    threadId: string,
    via: "auto-send" | "scheduled" | "cross-thread" | "cli",
  ): Promise<{ sent: boolean; error: string | null }> {
    const claimed = store.claimPrompt(prompt.id, via);
    if (!claimed) return { sent: false, error: "Already sent or deleted." };
    try {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: claimed.text, mentions: [] }],
      });
      store.pruneUsed(USED_KEEP);
      notify(claimed.threadId, "auto-sent");
      if (claimed.threadId !== threadId) notify(threadId, "changed");
      bb.log.info(`sent prompt ${claimed.id} to ${threadId} (${via})`);
      return { sent: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.requeuePrompt(claimed.id, message);
      notify(claimed.threadId, "send-failed", message);
      bb.log.error(`send failed for prompt ${claimed.id}: ${message}`);
      return { sent: false, error: message };
    }
  }

  bb.rpc.register(rpcContract, {
    async listPrompts({ threadId }) {
      return {
        threadPrompts:
          threadId === null ? [] : store.listQueued("thread", threadId),
        globalPrompts: store.listQueued("global", null),
        recentlyUsed: store.listRecentlyUsed(threadId, USED_KEEP / 2),
        paused: threadId === null ? false : await isPaused(threadId),
      };
    },
    addPrompt(input) {
      const prompt = store.addPrompt(input);
      notify(prompt.threadId);
      return { prompt };
    },
    updatePrompt({ id, text, autoSend, scope, sendAt }) {
      const existing = store.getPrompt(id);
      if (!existing) return { prompt: null };
      const nextScope = scope ?? existing.scope;
      const nextThreadId = nextScope === "global" ? null : existing.threadId;
      const nextAutoSend =
        nextScope === "global" ? false : (autoSend ?? existing.autoSend);
      const nextSendAt =
        nextScope === "global"
          ? null
          : sendAt === undefined
            ? existing.sendAt
            : sendAt;
      db.prepare(
        `UPDATE prompts SET text = ?, auto_send = ?, scope = ?, thread_id = ?, send_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      ).run(
        text ?? existing.text,
        nextAutoSend ? 1 : 0,
        nextScope,
        nextThreadId,
        nextSendAt,
        Date.now(),
        id,
      );
      notify(existing.threadId);
      return { prompt: store.getPrompt(id) };
    },
    deletePrompt({ id }) {
      const existing = store.getPrompt(id);
      if (!existing) return { deleted: false, prompt: null };
      db.prepare(`DELETE FROM prompts WHERE id = ?`).run(id);
      notify(existing.threadId);
      return { deleted: true, prompt: existing };
    },
    consumePrompt({ id, via }) {
      const prompt = store.claimPrompt(id, via);
      if (prompt) {
        store.pruneUsed(USED_KEEP);
        notify(prompt.threadId);
      }
      return { prompt };
    },
    restorePrompt({ id }) {
      const prompt = store.requeuePrompt(id);
      if (prompt) notify(prompt.threadId);
      return { prompt };
    },
    reorderPrompts({ scope, threadId, ids }) {
      const reordered = store.reorderPrompts(
        scope,
        scope === "global" ? null : threadId,
        ids,
      );
      if (reordered) notify(scope === "global" ? null : threadId);
      return { reordered };
    },
    armAll({ threadId }) {
      const result = db
        .prepare(
          `UPDATE prompts SET auto_send = 1, updated_at = ?
           WHERE thread_id = ? AND status = 'queued' AND auto_send = 0`,
        )
        .run(Date.now(), threadId);
      notify(threadId);
      return { armed: result.changes };
    },
    disarmThread({ threadId }) {
      const result = db
        .prepare(
          `UPDATE prompts SET auto_send = 0, updated_at = ?
           WHERE thread_id = ? AND status = 'queued' AND auto_send = 1`,
        )
        .run(Date.now(), threadId);
      notify(threadId);
      return { disarmed: result.changes };
    },
    async setPaused({ threadId, paused }) {
      if (paused) await bb.storage.kv.set(pausedKey(threadId), true);
      else await bb.storage.kv.delete(pausedKey(threadId));
      notify(threadId);
      return { paused };
    },
    async listTargets({ excludeThreadId }) {
      const threads = await bb.sdk.threads.list({
        archived: false,
        limit: 25,
      });
      return {
        threads: threads
          .filter((thread) => thread.id !== excludeThreadId)
          .slice(0, 15)
          .map((thread) => ({
            id: thread.id,
            title: thread.title ?? thread.titleFallback ?? "Untitled thread",
          })),
      };
    },
    async sendPromptToThread({ id, threadId }) {
      const prompt = store.getPrompt(id);
      if (!prompt || prompt.status !== "queued")
        return { sent: false, error: "Prompt is no longer queued." };
      return sendPrompt(prompt, threadId, "cross-thread");
    },
    listSnippets({ query }) {
      return { snippets: store.listSnippets(query) };
    },
    addSnippet(input) {
      const snippet = store.addSnippet(input);
      notify(null);
      return { snippet };
    },
    updateSnippet(input) {
      const snippet = store.updateSnippet(input);
      if (snippet) notify(null);
      return { snippet };
    },
    deleteSnippet({ id }) {
      const deleted = store.deleteSnippet(id);
      if (deleted) notify(null);
      return { deleted };
    },
    useSnippet({ id }) {
      store.touchSnippet(id);
      return { snippet: store.getSnippet(id) };
    },
  });

  // ---- Auto-send with idle-delay guard ----
  //
  // thread.idle also fires when the agent stops to ask the user a question,
  // so firing instantly would barge into a live exchange. Instead we wait
  // `autoSendDelaySeconds`; thread.active during the window cancels the timer.
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelIdleTimer(threadId: string): void {
    const timer = idleTimers.get(threadId);
    if (timer !== undefined) {
      clearTimeout(timer);
      idleTimers.delete(threadId);
    }
  }

  async function drainOne(threadId: string): Promise<void> {
    if (await isPaused(threadId)) return;
    const next = store.nextArmed(threadId);
    if (!next) return;
    await sendPrompt(next, threadId, "auto-send");
  }

  bb.events.on("thread.idle", ({ thread }) => {
    if (!store.nextArmed(thread.id)) return;
    cancelIdleTimer(thread.id);
    void settings.get().then(({ autoSendDelaySeconds }) => {
      const delay = Math.max(
        0,
        Number(autoSendDelaySeconds) || DEFAULT_IDLE_DELAY_SECONDS,
      );
      const timer = setTimeout(() => {
        idleTimers.delete(thread.id);
        void drainOne(thread.id).catch((error) => {
          bb.log.error(
            `auto-send drain failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }, delay * 1_000);
      idleTimers.set(thread.id, timer);
    });
  });

  bb.events.on("thread.active", ({ thread }) => {
    cancelIdleTimer(thread.id);
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    cancelIdleTimer(thread.id);
    const result = db
      .prepare(`DELETE FROM prompts WHERE thread_id = ?`)
      .run(thread.id);
    void bb.storage.kv.delete(pausedKey(thread.id));
    if (result.changes > 0) notify(thread.id);
  });

  bb.onDispose(() => {
    for (const timer of idleTimers.values()) clearTimeout(timer);
    idleTimers.clear();
  });

  // ---- Scheduled sends: fire due prompts regardless of idle state ----
  bb.background.schedule("scheduled-send", "* * * * *", async () => {
    for (const prompt of store.listDue(Date.now())) {
      if (prompt.threadId === null) continue;
      await sendPrompt(prompt, prompt.threadId, "scheduled");
    }
  });

  // ---- Agent awareness: tell the agent its thread has queued follow-ups ----
  bb.agents.contributeInstructions(({ threadId }) => {
    if (!threadId) return null;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM prompts WHERE thread_id = ? AND status = 'queued'`,
      )
      .get(threadId) as { n: number };
    if (row.n === 0) return null;
    return (
      `The user has ${row.n} follow-up prompt${row.n === 1 ? "" : "s"} queued for this thread ` +
      `(Prompts plugin); they will be injected or auto-sent after the current work. ` +
      `Prefer finishing the current task cleanly over starting new open-ended work.`
    );
  });

  // ---- CLI: bb prompts ----
  bb.cli.register({
    name: "prompts",
    summary: "Prompt queue + snippets: stash prompts, auto-send on idle, reusable templates",
    commands: [
      { name: "list", summary: "List queued prompts (thread + global)", usage: "bb prompts list" },
      {
        name: "add",
        summary: "Queue a prompt (-g global, --arm auto-send, --at +5m/+2h/ISO schedule)",
        usage: "bb prompts add [-g] [--arm] [--at <when>] <text…>",
      },
      { name: "send", summary: "Send a queued prompt to the current thread now", usage: "bb prompts send <id>" },
      { name: "arm", summary: "Arm/disarm auto-send for a prompt", usage: "bb prompts arm|disarm <id>" },
      { name: "run", summary: "Arm every queued prompt in this thread (drain in order)", usage: "bb prompts run" },
      { name: "pause", summary: "Pause/resume auto-send for this thread", usage: "bb prompts pause|resume" },
      { name: "rm", summary: "Delete a queued prompt", usage: "bb prompts rm <id>" },
      { name: "snips", summary: "List/search snippets", usage: "bb prompts snips [query]" },
      {
        name: "snip-add",
        summary: "Save a snippet (reusable prompt; {{tokens}} become fill-ins)",
        usage: "bb prompts snip-add --title <t> [--keywords <k>] [--group <g>] <body…>",
      },
      { name: "snip-show", summary: "Print a snippet's body", usage: "bb prompts snip-show <id>" },
      { name: "snip-rm", summary: "Delete a snippet", usage: "bb prompts snip-rm <id>" },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      const threadId = ctx.threadId ?? null;
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const formatPrompt = (prompt: Prompt) => {
        const flags = [
          prompt.autoSend ? "armed" : null,
          prompt.sendAt !== null
            ? `at ${new Date(prompt.sendAt).toISOString()}`
            : null,
          prompt.lastError !== null ? "FAILED" : null,
        ]
          .filter(Boolean)
          .join(", ");
        return `${prompt.id}  ${flags ? `[${flags}] ` : ""}${prompt.text.replace(/\s+/g, " ").slice(0, 100)}`;
      };

      switch (command) {
        case "list":
        case undefined: {
          const lines: string[] = [];
          if (threadId) {
            const threadPrompts = store.listQueued("thread", threadId);
            lines.push(
              `Thread queue (${threadPrompts.length}${(await isPaused(threadId)) ? ", paused" : ""}):`,
              ...threadPrompts.map(formatPrompt),
            );
          }
          const globalPrompts = store.listQueued("global", null);
          lines.push(
            `Global queue (${globalPrompts.length}):`,
            ...globalPrompts.map(formatPrompt),
          );
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        case "add": {
          const args = [...rest];
          let global = false;
          let arm = false;
          let at: string | null = null;
          const words: string[] = [];
          while (args.length > 0) {
            const arg = args.shift()!;
            if (arg === "-g" || arg === "--global") global = true;
            else if (arg === "--arm") arm = true;
            else if (arg === "--at") at = args.shift() ?? null;
            else words.push(arg);
          }
          const text = words.join(" ").trim();
          if (!text) return fail("Usage: bb prompts add [-g] [--arm] [--at <when>] <text…>");
          if (!global && threadId === null)
            return fail("Not in a thread — use -g to queue globally.");
          let sendAt: number | null = null;
          if (at !== null) {
            if (global) return fail("--at needs a thread-scoped prompt (drop -g).");
            sendAt = parseWhen(at, Date.now());
            if (sendAt === null)
              return fail(`Can't parse --at "${at}" (use +30s/+5m/+2h/+1d or ISO-8601).`);
          }
          const prompt = store.addPrompt({
            text,
            scope: global ? "global" : "thread",
            threadId,
            autoSend: arm,
            sendAt,
          });
          notify(prompt.threadId);
          return {
            exitCode: 0,
            stdout: `Queued ${prompt.id}${prompt.autoSend ? " (armed)" : ""}${
              sendAt !== null ? ` (sends ${new Date(sendAt).toISOString()})` : ""
            }.`,
          };
        }
        case "send": {
          const id = rest[0];
          if (!id) return fail("Usage: bb prompts send <id>");
          if (threadId === null) return fail("Not in a thread.");
          const prompt = store.getPrompt(id);
          if (!prompt || prompt.status !== "queued")
            return fail(`No queued prompt with id ${id}.`);
          const result = await sendPrompt(prompt, threadId, "cli");
          return result.sent
            ? { exitCode: 0, stdout: `Sent ${id}.` }
            : fail(`Send failed: ${result.error}`);
        }
        case "arm":
        case "disarm": {
          const id = rest[0];
          if (!id) return fail(`Usage: bb prompts ${command} <id>`);
          const prompt = store.getPrompt(id);
          if (!prompt || prompt.status !== "queued")
            return fail(`No queued prompt with id ${id}.`);
          if (command === "arm" && prompt.threadId === null)
            return fail("Only thread-scoped prompts can be armed.");
          db.prepare(
            `UPDATE prompts SET auto_send = ?, updated_at = ? WHERE id = ?`,
          ).run(command === "arm" ? 1 : 0, Date.now(), id);
          notify(prompt.threadId);
          return {
            exitCode: 0,
            stdout: `${command === "arm" ? "Armed" : "Disarmed"} ${id}.`,
          };
        }
        case "run": {
          if (threadId === null) return fail("Not in a thread.");
          const result = db
            .prepare(
              `UPDATE prompts SET auto_send = 1, updated_at = ?
               WHERE thread_id = ? AND status = 'queued' AND auto_send = 0`,
            )
            .run(Date.now(), threadId);
          notify(threadId);
          return {
            exitCode: 0,
            stdout: `Armed ${result.changes} prompt(s) — they drain in order as the thread goes idle.`,
          };
        }
        case "pause":
        case "resume": {
          if (threadId === null) return fail("Not in a thread.");
          if (command === "pause")
            await bb.storage.kv.set(pausedKey(threadId), true);
          else await bb.storage.kv.delete(pausedKey(threadId));
          notify(threadId);
          return {
            exitCode: 0,
            stdout: command === "pause" ? "Auto-send paused." : "Auto-send resumed.",
          };
        }
        case "rm": {
          const id = rest[0];
          if (!id) return fail("Usage: bb prompts rm <id>");
          const prompt = store.getPrompt(id);
          if (!prompt) return fail(`No prompt with id ${id}.`);
          db.prepare(`DELETE FROM prompts WHERE id = ?`).run(id);
          notify(prompt.threadId);
          return { exitCode: 0, stdout: `Deleted ${id}.` };
        }
        case "snips": {
          const snippets = store.listSnippets(rest.join(" "));
          const lines = snippets.map(
            (snippet) =>
              `${snippet.id}  ${snippet.title}${snippet.groupName ? ` (${snippet.groupName})` : ""}${
                snippet.keywords ? `  [${snippet.keywords}]` : ""
              }`,
          );
          return {
            exitCode: 0,
            stdout: lines.length > 0 ? lines.join("\n") : "No snippets.",
          };
        }
        case "snip-add": {
          const args = [...rest];
          let title: string | null = null;
          let keywords = "";
          let group: string | null = null;
          const words: string[] = [];
          while (args.length > 0) {
            const arg = args.shift()!;
            if (arg === "--title") title = args.shift() ?? null;
            else if (arg === "--keywords") keywords = args.shift() ?? "";
            else if (arg === "--group") group = args.shift() ?? null;
            else words.push(arg);
          }
          const body = words.join(" ").trim();
          if (!title || !body)
            return fail(
              "Usage: bb prompts snip-add --title <t> [--keywords <k>] [--group <g>] <body…>",
            );
          const snippet = store.addSnippet({ title, body, keywords, groupName: group });
          notify(null);
          return { exitCode: 0, stdout: `Saved snippet ${snippet.id}.` };
        }
        case "snip-show": {
          const snippet = rest[0] ? store.getSnippet(rest[0]) : null;
          if (!snippet) return fail("Usage: bb prompts snip-show <id>");
          return { exitCode: 0, stdout: snippet.body };
        }
        case "snip-rm": {
          const id = rest[0];
          if (!id) return fail("Usage: bb prompts snip-rm <id>");
          if (!store.deleteSnippet(id)) return fail(`No snippet with id ${id}.`);
          notify(null);
          return { exitCode: 0, stdout: `Deleted ${id}.` };
        }
        default:
          return fail(
            `Unknown command "${command}". Commands: list, add, send, arm, disarm, run, pause, resume, rm, snips, snip-add, snip-show, snip-rm.`,
          );
      }
    },
  });
}
