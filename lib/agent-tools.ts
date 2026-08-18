// Agent-facing tools.
//
// The CLI already exposes all of this, but a shell-out is a poor fit for the
// one thing agents do most here: the user says "later" mid-task and the right
// move is to stash the follow-up without leaving the turn.

import { z } from "zod";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { fillTokens, parseTokens } from "./template";
import { parseWhen } from "./time";
import type { Operations, Signal } from "./operations";
import type { Prompt, Store } from "./store";

const QUEUE_INSTRUCTIONS =
  "When the user defers work ('later', 'after this', 'next up'), queue it with " +
  "prompts_queue instead of starting it or dropping it. Only arm or schedule a " +
  "prompt when the user actually asked for it to run on its own.";

function line(prompt: Prompt): string {
  const flags = [
    prompt.autoSend ? "armed" : null,
    prompt.sendAt !== null ? `at ${new Date(prompt.sendAt).toISOString()}` : null,
    prompt.lastError !== null ? "send failed" : null,
  ].filter(Boolean);
  return `${prompt.id} [${prompt.scope}${flags.length ? `, ${flags.join(", ")}` : ""}] ${prompt.text
    .replace(/\s+/g, " ")
    .slice(0, 160)}`;
}

export function registerAgentTools(
  bb: BbPluginApi,
  deps: {
    store: Store;
    operations: Operations;
    notify(signal: Signal): void;
  },
): void {
  const { store, operations, notify } = deps;

  bb.agents.registerTool({
    name: "prompts_queue",
    description:
      "Queue a follow-up prompt for later instead of acting on it now (Prompts plugin). " +
      "Thread scope is the default and stays with this thread; project scope survives " +
      "the thread ending; global scope is reachable from anywhere.",
    instructions: QUEUE_INSTRUCTIONS,
    experimental_statusLabels: {
      pending: "Queueing a follow-up prompt",
      completed: "Queued a follow-up prompt",
    },
    parameters: z.object({
      text: z.string().min(1).describe("The prompt to queue, written as the user would send it"),
      scope: z
        .enum(["thread", "project", "global"])
        .optional()
        .describe("Default 'thread'. Use 'project' for work that outlives this thread."),
      arm: z
        .boolean()
        .optional()
        .describe("Send automatically once this thread goes idle. Only when the user asked."),
      at: z
        .string()
        .optional()
        .describe("Schedule the send: +30s, +5m, +2h, +1d, or an ISO-8601 timestamp"),
    }),
    async execute({ text, scope = "thread", arm = false, at }, ctx) {
      const threadId = ctx.threadId ?? null;
      if (scope === "thread" && threadId === null)
        return { content: [{ type: "text", text: "No thread in context — use scope 'project' or 'global'." }], isError: true };
      let sendAt: number | null = null;
      if (at !== undefined) {
        if (scope !== "thread")
          return { content: [{ type: "text", text: "Only thread-scoped prompts can be scheduled." }], isError: true };
        sendAt = parseWhen(at, Date.now());
        if (sendAt === null)
          return { content: [{ type: "text", text: `Cannot parse "${at}" (use +5m, +2h, +1d, or ISO-8601).` }], isError: true };
      }
      const { prompt, error } = await operations.addPrompt({
        text,
        scope,
        threadId: scope === "thread" ? threadId : null,
        projectId: scope === "project" ? (ctx.projectId ?? null) : null,
        autoSend: arm && scope === "thread",
        sendAt,
      });
      if (!prompt)
        return { content: [{ type: "text", text: error ?? "Could not queue that prompt." }], isError: true };
      return (
        `Queued ${prompt.id} (${prompt.scope})` +
        `${prompt.autoSend ? ", armed to auto-send when this thread goes idle" : ""}` +
        `${prompt.sendAt !== null ? `, scheduled for ${new Date(prompt.sendAt).toISOString()}` : ""}` +
        `. It does not send until then.`
      );
    },
  });

  bb.agents.registerTool({
    name: "prompts_list",
    description:
      "List the user's queued prompts (Prompts plugin) for this thread, this project, and the global queue.",
    parameters: z.object({
      scope: z
        .enum(["all", "thread", "project", "global"])
        .optional()
        .describe("Default 'all'"),
    }),
    execute({ scope = "all" }, ctx) {
      const sections: string[] = [];
      const wanted = (name: string) => scope === "all" || scope === name;
      if (wanted("thread") && ctx.threadId) {
        const prompts = store.listQueued({ scope: "thread", threadId: ctx.threadId });
        sections.push(
          `Thread queue (${prompts.length}${store.isPaused(ctx.threadId) ? ", auto-send paused" : ""}):`,
          ...prompts.map(line),
        );
      }
      if (wanted("project") && ctx.projectId) {
        const prompts = store.listQueued({ scope: "project", projectId: ctx.projectId });
        sections.push(`Project queue (${prompts.length}):`, ...prompts.map(line));
      }
      if (wanted("global")) {
        const prompts = store.listQueued({ scope: "global" });
        sections.push(`Global queue (${prompts.length}):`, ...prompts.map(line));
      }
      return sections.length > 0 ? sections.join("\n") : "Nothing queued.";
    },
  });

  bb.agents.registerTool({
    name: "prompts_snippets",
    description:
      "Search the user's saved prompt snippets (Prompts plugin). Returns ids, titles, and any {{fill-in}} tokens. Empty query lists the most used.",
    instructions:
      "The user keeps reusable prompts as snippets. Search them with prompts_snippets and read one with prompts_snippet_get rather than reinventing a workflow the user has already written down.",
    parameters: z.object({
      query: z.string().optional().describe("Matches title, keywords, body, or group"),
    }),
    execute({ query = "" }, ctx) {
      const { snippets, total } = store.listSnippets(query, {
        projectId: ctx.projectId ?? null,
        limit: 25,
      });
      if (snippets.length === 0) return "No matching snippets.";
      const lines = snippets.map((snippet) => {
        const tokens = parseTokens(snippet.body).map((token) => `{{${token.name}}}`);
        return [
          snippet.id,
          snippet.title,
          snippet.groupName ? `group: ${snippet.groupName}` : null,
          tokens.length > 0 ? `fill-ins: ${tokens.join(" ")}` : null,
        ]
          .filter(Boolean)
          .join(" | ");
      });
      const more = total > snippets.length ? `\n… ${total - snippets.length} more; narrow the query.` : "";
      return `${lines.join("\n")}${more}`;
    },
  });

  bb.agents.registerTool({
    name: "prompts_snippet_get",
    description:
      "Read one saved snippet's full body by id (Prompts plugin), optionally filling its {{tokens}}.",
    parameters: z.object({
      id: z.string().min(1),
      fill: z
        .record(z.string(), z.string())
        .optional()
        .describe("Values for the snippet's {{tokens}}, keyed by token name"),
    }),
    execute({ id, fill }) {
      const snippet = store.getSnippet(id);
      if (!snippet) return { content: [{ type: "text", text: `No snippet with id ${id}.` }], isError: true };
      const body = fill ? fillTokens(snippet.body, fill) : snippet.body;
      const unfilled = parseTokens(body).map((token) => token.name);
      store.touchSnippet(id);
      return (
        `# ${snippet.title}\n\n${body}` +
        (unfilled.length > 0
          ? `\n\n(unfilled tokens: ${unfilled.map((token) => `{{${token}}}`).join(" ")})`
          : "")
      );
    },
  });

  bb.agents.registerTool({
    name: "prompts_snippet_save",
    description:
      "Save a reusable prompt as a snippet (Prompts plugin). Use {{token}} for parts that change between uses.",
    parameters: z.object({
      title: z.string().min(1).max(200),
      body: z.string().min(1),
      keywords: z.string().max(200).optional(),
      group: z.string().max(100).optional().describe("Snippets in one group can be queued together as a checklist"),
      projectOnly: z
        .boolean()
        .optional()
        .describe("Keep it to the current project instead of the shared library"),
    }),
    execute({ title, body, keywords, group, projectOnly }, ctx) {
      const snippet = store.addSnippet({
        title,
        body,
        keywords: keywords ?? "",
        groupName: group ?? null,
        projectId: projectOnly ? (ctx.projectId ?? null) : null,
      });
      notify({
        topic: "snippets",
        kind: "changed",
        threadId: null,
        projectId: snippet.projectId,
      });
      return `Saved snippet ${snippet.id} ("${snippet.title}").`;
    },
  });
}
