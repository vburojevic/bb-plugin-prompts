// `bb prompts …` — the agent- and terminal-facing surface.

import { fillTokens, parseTokens } from "./template";
import { parseWhen } from "./time";
import type { Miner } from "./mining";
import type { Operations, Signal } from "./operations";
import type { Prompt, Scope, Snippet, Store } from "./store";

/** How long `bb prompts suggest` waits on an in-flight scan before reporting. */
const CLI_SCAN_WAIT_MS = 5_000;

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface CliContext {
  threadId?: string;
  projectId?: string;
}

export interface CliDeps {
  store: Store;
  operations: Operations;
  miner: Miner;
  /** CLI writes are user actions like any other — open panels must hear them. */
  notify(signal: Signal): void;
  now?: () => number;
}

interface Flags {
  booleans: Set<string>;
  values: Map<string, string>;
  rest: string[];
}

/**
 * A tiny flag parser. `--` ends option parsing, so a prompt that starts with a
 * dash is still queueable.
 */
function parseFlags(
  argv: string[],
  spec: { booleans?: string[]; values?: string[] } = {},
): Flags {
  const booleanNames = new Set(spec.booleans ?? []);
  const valueNames = new Set(spec.values ?? []);
  const flags: Flags = { booleans: new Set(), values: new Map(), rest: [] };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--") {
      flags.rest.push(...args);
      break;
    }
    if (booleanNames.has(arg)) flags.booleans.add(arg);
    else if (valueNames.has(arg)) {
      const value = args.shift();
      if (value !== undefined) flags.values.set(arg, value);
    } else flags.rest.push(arg);
  }
  return flags;
}

function formatPrompt(prompt: Prompt): string {
  const flags = [
    prompt.scope,
    prompt.autoSend ? "armed" : null,
    prompt.sendAt !== null ? `at ${new Date(prompt.sendAt).toISOString()}` : null,
    prompt.lastError !== null ? "FAILED" : null,
  ].filter(Boolean);
  return `${prompt.id}  [${flags.join(", ")}] ${prompt.text
    .replace(/\s+/g, " ")
    .slice(0, 100)}`;
}

function formatSnippet(snippet: Snippet): string {
  const tokens = parseTokens(snippet.body).map((token) => `{{${token.name}}}`);
  return [
    snippet.id,
    snippet.title,
    snippet.groupName ? `(${snippet.groupName})` : null,
    snippet.keywords ? `[${snippet.keywords}]` : null,
    tokens.length > 0 ? tokens.join(" ") : null,
    snippet.projectId ? "project-only" : null,
  ]
    .filter(Boolean)
    .join("  ");
}

/** `--set key=value` pairs for filling a snippet's tokens. */
function collectSets(rest: string[]): { values: Record<string, string>; rest: string[] } {
  const values: Record<string, string> = {};
  const remaining: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--set") {
      const pair = rest[index + 1];
      index += 1;
      if (pair === undefined) continue;
      const split = pair.indexOf("=");
      if (split > 0) values[pair.slice(0, split)] = pair.slice(split + 1);
      continue;
    }
    remaining.push(arg);
  }
  return { values, rest: remaining };
}

export const CLI_COMMANDS = [
  { name: "list", summary: "List queued prompts (thread + project + global)", usage: "bb prompts list [--json]" },
  {
    name: "add",
    summary: "Queue a prompt (-p project, -g global, --arm auto-send, --at +5m/ISO schedule)",
    usage: "bb prompts add [-p|-g] [--arm] [--at <when>] <text…>",
  },
  { name: "send", summary: "Send a queued prompt to the current thread now", usage: "bb prompts send <id>" },
  {
    name: "push",
    summary: "Move a queued prompt into bb's native queue (auto-delivers next turn)",
    usage: "bb prompts push <id>",
  },
  {
    name: "stash",
    summary: "Pull ALL of bb's queued messages for this thread into the stash (stops auto-delivery)",
    usage: "bb prompts stash",
  },
  { name: "arm", summary: "Arm/disarm auto-send for a prompt", usage: "bb prompts arm|disarm <id>" },
  { name: "run", summary: "Arm every queued prompt in this thread (drain in order)", usage: "bb prompts run" },
  { name: "pause", summary: "Pause/resume auto-send for this thread", usage: "bb prompts pause|resume" },
  {
    name: "promote",
    summary: "Keep a thread prompt for the project so it survives the thread (all of them by default)",
    usage: "bb prompts promote [<id>]",
  },
  { name: "rm", summary: "Delete a queued prompt", usage: "bb prompts rm <id>" },
  { name: "snips", summary: "List/search snippets", usage: "bb prompts snips [query] [--json]" },
  {
    name: "snip-add",
    summary: "Save a snippet (reusable prompt; {{tokens}} become fill-ins, {{token=default}} pre-fills)",
    usage: "bb prompts snip-add --title <t> [--keywords <k>] [--group <g>] [--project] <body…>",
  },
  {
    name: "snip-show",
    summary: "Print a snippet's body, optionally filling its tokens",
    usage: "bb prompts snip-show <id> [--set key=value …]",
  },
  { name: "snip-rm", summary: "Delete a snippet", usage: "bb prompts snip-rm <id>" },
  {
    name: "group",
    summary: "Queue every snippet in a group, in writing order — a checklist in one command",
    usage: "bb prompts group <name> [-p|-g]",
  },
  {
    name: "suggest",
    summary: "Snippets worth saving, mined from prompts you keep retyping",
    usage: "bb prompts suggest [--refresh] [--json]",
  },
] as const;

const COMMAND_NAMES = [
  "list",
  "add",
  "send",
  "push",
  "stash",
  "arm",
  "disarm",
  "run",
  "pause",
  "resume",
  "promote",
  "rm",
  "snips",
  "snip-add",
  "snip-show",
  "snip-rm",
  "group",
  "suggest",
];

export function createCliRunner(deps: CliDeps) {
  const { store, operations, miner, notify } = deps;
  const now = deps.now ?? Date.now;

  return async function run(argv: string[], ctx: CliContext): Promise<CliResult> {
    const [command, ...rest] = argv;
    const threadId = ctx.threadId ?? null;
    const projectId = ctx.projectId ?? null;
    const fail = (message: string): CliResult => ({ exitCode: 1, stderr: message });
    const ok = (stdout: string): CliResult => ({ exitCode: 0, stdout });
    const queueChanged = () =>
      notify({ topic: "queue", kind: "changed", threadId, projectId });
    const snippetsChanged = () =>
      notify({ topic: "snippets", kind: "changed", threadId: null, projectId });

    switch (command) {
      case "list":
      case undefined: {
        const json = rest.includes("--json");
        const thread = threadId
          ? store.listQueued({ scope: "thread", threadId })
          : [];
        const project = projectId
          ? store.listQueued({ scope: "project", projectId })
          : [];
        const global = store.listQueued({ scope: "global" });
        if (json)
          return ok(
            JSON.stringify(
              {
                thread,
                project,
                global,
                paused: threadId ? store.isPaused(threadId) : false,
              },
              null,
              2,
            ),
          );
        const lines: string[] = [];
        if (threadId)
          lines.push(
            `Thread queue (${thread.length}${store.isPaused(threadId) ? ", paused" : ""}):`,
            ...thread.map(formatPrompt),
          );
        if (projectId)
          lines.push(`Project queue (${project.length}):`, ...project.map(formatPrompt));
        lines.push(`Global queue (${global.length}):`, ...global.map(formatPrompt));
        return ok(lines.join("\n"));
      }

      case "add": {
        const flags = parseFlags(rest, {
          booleans: ["-g", "--global", "-p", "--project", "--arm"],
          values: ["--at"],
        });
        const global = flags.booleans.has("-g") || flags.booleans.has("--global");
        const project = flags.booleans.has("-p") || flags.booleans.has("--project");
        const text = flags.rest.join(" ").trim();
        if (!text)
          return fail("Usage: bb prompts add [-p|-g] [--arm] [--at <when>] <text…>");
        if (global && project) return fail("Pick one of -g or -p.");
        const scope: Scope = global ? "global" : project ? "project" : "thread";
        if (scope === "thread" && threadId === null)
          return fail("Not in a thread — use -p for the project queue or -g for the global one.");
        if (scope === "project" && projectId === null)
          return fail("No project in context — use -g to queue globally.");
        const at = flags.values.get("--at") ?? null;
        let sendAt: number | null = null;
        if (at !== null) {
          if (scope !== "thread")
            return fail("--at needs a thread-scoped prompt (drop -p/-g).");
          sendAt = parseWhen(at, now());
          if (sendAt === null)
            return fail(`Can't parse --at "${at}" (use +30s/+5m/+2h/+1d or ISO-8601).`);
        }
        const { prompt, error } = await operations.addPrompt({
          text,
          scope,
          threadId: scope === "thread" ? threadId : null,
          projectId: scope === "project" ? projectId : null,
          autoSend: flags.booleans.has("--arm") && scope === "thread",
          sendAt,
        });
        if (!prompt) return fail(error ?? "Could not queue that prompt.");
        return ok(
          `Queued ${prompt.id} (${prompt.scope})${prompt.autoSend ? " (armed)" : ""}${
            sendAt !== null ? ` (sends ${new Date(sendAt).toISOString()})` : ""
          }.`,
        );
      }

      case "send": {
        const id = rest[0];
        if (!id) return fail("Usage: bb prompts send <id>");
        if (threadId === null) return fail("Not in a thread.");
        const result = await operations.sendById(id, threadId, "cli");
        return result.sent ? ok(`Sent ${id}.`) : fail(`Send failed: ${result.error}`);
      }

      case "push": {
        const id = rest[0];
        if (!id) return fail("Usage: bb prompts push <id>");
        if (threadId === null) return fail("Not in a thread.");
        const result = await operations.pushToNative(id, threadId);
        return result.pushed
          ? ok(`Pushed ${id} to bb's queue.`)
          : fail(`Push failed: ${result.error}`);
      }

      case "stash": {
        if (threadId === null) return fail("Not in a thread.");
        const result = await operations.stashAllNative(threadId);
        if (result.error) return fail(`Stash failed: ${result.error}`);
        return ok(
          `Stashed ${result.stashed} message(s) — they will not auto-send.` +
            (result.skipped > 0 ? ` ${result.skipped} left in place.` : ""),
        );
      }

      case "arm":
      case "disarm": {
        const id = rest[0];
        if (!id) return fail(`Usage: bb prompts ${command} <id>`);
        const prompt = store.getPrompt(id);
        if (!prompt || prompt.status !== "queued")
          return fail(`No queued prompt with id ${id}.`);
        if (prompt.scope !== "thread")
          return fail("Only thread-scoped prompts can be armed.");
        store.updatePromptFields(id, { autoSend: command === "arm" });
        queueChanged();
        return ok(`${command === "arm" ? "Armed" : "Disarmed"} ${id}.`);
      }

      case "run": {
        if (threadId === null) return fail("Not in a thread.");
        const armed = store.setArmedForThread(threadId, true);
        queueChanged();
        return ok(
          `Armed ${armed} prompt(s) — they drain in order as the thread goes idle.`,
        );
      }

      case "pause":
      case "resume": {
        if (threadId === null) return fail("Not in a thread.");
        store.setPaused(threadId, command === "pause");
        queueChanged();
        return ok(command === "pause" ? "Auto-send paused." : "Auto-send resumed.");
      }

      case "promote": {
        if (threadId === null) return fail("Not in a thread.");
        const id = rest[0];
        const target = projectId ?? (await operations.resolveProjectId(threadId));
        if (id) {
          const prompt = store.getPrompt(id);
          if (!prompt || prompt.status !== "queued")
            return fail(`No queued prompt with id ${id}.`);
          const moved = store.movePrompt(
            id,
            target === null
              ? { scope: "global" }
              : { scope: "project", projectId: target },
          );
          if (!moved) return fail(`Could not promote ${id}.`);
          queueChanged();
          return ok(
            `${id} now lives on the ${target ? "project" : "global"} queue — it survives this thread.`,
          );
        }
        const promoted = store.promoteThreadPrompts(threadId, { projectId: target });
        if (promoted.length > 0) queueChanged();
        return ok(
          promoted.length === 0
            ? "Nothing queued for this thread."
            : `Kept ${promoted.length} prompt(s) on the ${target ? "project" : "global"} queue.`,
        );
      }

      case "rm": {
        const id = rest[0];
        if (!id) return fail("Usage: bb prompts rm <id>");
        const prompt = store.getPrompt(id);
        if (!prompt) return fail(`No prompt with id ${id}.`);
        store.deletePrompt(id);
        queueChanged();
        return ok(`Deleted ${id}.`);
      }

      case "snips": {
        const json = rest.includes("--json");
        const query = rest.filter((arg) => arg !== "--json").join(" ");
        const { snippets, total } = store.listSnippets(query, { projectId });
        if (json) return ok(JSON.stringify({ snippets, total }, null, 2));
        if (snippets.length === 0) return ok("No snippets.");
        const more =
          total > snippets.length ? `\n… ${total - snippets.length} more.` : "";
        return ok(`${snippets.map(formatSnippet).join("\n")}${more}`);
      }

      case "snip-add": {
        const flags = parseFlags(rest, {
          booleans: ["--project"],
          values: ["--title", "--keywords", "--group"],
        });
        const title = flags.values.get("--title") ?? null;
        const body = flags.rest.join(" ").trim();
        if (!title || !body)
          return fail(
            "Usage: bb prompts snip-add --title <t> [--keywords <k>] [--group <g>] [--project] <body…>",
          );
        const snippet = store.addSnippet({
          title,
          body,
          keywords: flags.values.get("--keywords") ?? "",
          groupName: flags.values.get("--group") ?? null,
          projectId: flags.booleans.has("--project") ? projectId : null,
        });
        snippetsChanged();
        return ok(`Saved snippet ${snippet.id}.`);
      }

      case "snip-show": {
        const { values, rest: remaining } = collectSets(rest);
        const id = remaining[0];
        const snippet = id ? store.getSnippet(id) : null;
        if (!snippet) return fail("Usage: bb prompts snip-show <id> [--set key=value …]");
        store.touchSnippet(snippet.id);
        const body = fillTokens(snippet.body, values);
        const unfilled = parseTokens(body);
        return ok(
          unfilled.length > 0
            ? `${body}\n\n(unfilled: ${unfilled.map((token) => `--set ${token.name}=…`).join(" ")})`
            : body,
        );
      }

      case "snip-rm": {
        const id = rest[0];
        if (!id) return fail("Usage: bb prompts snip-rm <id>");
        if (!store.deleteSnippet(id)) return fail(`No snippet with id ${id}.`);
        snippetsChanged();
        return ok(`Deleted ${id}.`);
      }

      case "group": {
        const flags = parseFlags(rest, {
          booleans: ["-g", "--global", "-p", "--project"],
        });
        const name = flags.rest.join(" ").trim();
        if (!name) return fail("Usage: bb prompts group <name> [-p|-g]");
        const global = flags.booleans.has("-g") || flags.booleans.has("--global");
        const project = flags.booleans.has("-p") || flags.booleans.has("--project");
        const scope: Scope = global ? "global" : project ? "project" : "thread";
        if (scope === "thread" && threadId === null)
          return fail("Not in a thread — use -p or -g.");
        if (scope === "project" && projectId === null)
          return fail("No project in context — use -g.");
        const result = await operations.queueSnippetGroup(
          {
            scope,
            threadId: scope === "thread" ? threadId : null,
            projectId: scope === "project" ? projectId : null,
          },
          name,
        );
        if (result.error) return fail(result.error);
        return ok(`Queued ${result.queued} prompt(s) from "${name}".`);
      }

      case "suggest": {
        const json = rest.includes("--json");
        let result = await miner.read(rest.includes("--refresh"));
        if (!result.enabled)
          return ok(
            "History mining is off — enable it with `bb plugin config prompts set mineHistory on`.",
          );
        // A mine is hundreds of history round-trips, so the CLI only ever waits
        // on it when there is nothing at all to print — and then only briefly,
        // rather than holding the shared event loop for the scan.
        if (result.computing && result.computedAt === 0) {
          await Promise.race([
            miner.inFlight() ?? Promise.resolve(),
            new Promise((resolve) => setTimeout(resolve, CLI_SCAN_WAIT_MS)),
          ]);
          result = await miner.read(false);
        }
        if (json) return ok(JSON.stringify(result, null, 2));
        const { suggestions } = result;
        if (suggestions.length === 0)
          return ok(
            result.computing
              ? "Scanning prompt history… re-run `bb prompts suggest` in a moment."
              : `No suggestions from ${result.considered} prompts — everything you repeat is already a snippet.`,
          );
        const lines = suggestions.map((suggestion) => {
          const tokens = suggestion.tokens.map((token) => `{{${token}}}`).join(" ");
          return [
            `${String(suggestion.count).padStart(3)}×  ${suggestion.title}${tokens ? `  ${tokens}` : ""}`,
            `      ${suggestion.body.replace(/\s+/g, " ").slice(0, 160)}`,
          ].join("\n");
        });
        return ok(
          [
            `${suggestions.length} suggestion(s) from ${result.considered} of ${result.analyzed} prompts:`,
            ...lines,
            "",
            ...(result.computing
              ? ["A rescan is running — re-run for the updated list.", ""]
              : []),
            "Save one with: bb prompts snip-add --title <t> <body…>",
          ].join("\n"),
        );
      }

      default:
        return fail(
          `Unknown command "${command}". Commands: ${COMMAND_NAMES.join(", ")}.`,
        );
    }
  };
}
