// The RPC contract, in its own module so the frontend can type against it
// without pulling the backend's imports into its type graph.
import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

export const PROMPT_TEXT_CAP = 32_000;

export const scopeSchema = z.enum(["thread", "project", "global"]);
export type ScopeName = z.infer<typeof scopeSchema>;

export const promptSchema = z.object({
  id: z.string(),
  scope: scopeSchema,
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  originThreadTitle: z.string().nullable(),
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
    .enum([
      "inject",
      "auto-send",
      "cli",
      "scheduled",
      "cross-thread",
      "bb-queue",
      "tool",
    ])
    .nullable(),
});

export const snippetSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  description: z.string(),
  keywords: z.string(),
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
  projectId: z.string().nullable(),
  useCount: z.number(),
  lastUsedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const suggestionSchema = z.object({
  key: z.string(),
  title: z.string(),
  body: z.string(),
  keywords: z.string(),
  count: z.number(),
  lastSeenAt: z.number(),
  variants: z.array(z.string()),
  variantCount: z.number(),
  tokens: z.array(z.string()),
});

/** Where a queue write lands. Every scope carries its own owner id. */
const scopeRefSchema = z.object({
  scope: scopeSchema,
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  listPrompts: {
    input: z
      .object({
        threadId: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .strict(),
    output: z.object({
      threadPrompts: z.array(promptSchema),
      projectPrompts: z.array(promptSchema),
      globalPrompts: z.array(promptSchema),
      recentlyUsed: z.array(promptSchema),
      paused: z.boolean(),
    }),
  },
  addPrompt: {
    input: scopeRefSchema
      .extend({
        text: z.string().min(1).max(PROMPT_TEXT_CAP),
        autoSend: z.boolean(),
        sendAt: z.number().nullable().optional(),
      })
      .strict(),
    output: z.object({ prompt: promptSchema.nullable(), error: z.string().nullable() }),
  },
  updatePrompt: {
    input: z
      .object({
        id: z.string(),
        text: z.string().min(1).max(PROMPT_TEXT_CAP).optional(),
        autoSend: z.boolean().optional(),
        sendAt: z.number().nullable().optional(),
      })
      .strict(),
    output: z.object({ prompt: promptSchema.nullable() }),
  },
  /**
   * Scope changes are their own method precisely because they need an owner
   * id. Folding them into `updatePrompt` is what once produced thread-scoped
   * prompts with no thread — rows no list query could ever return.
   */
  movePrompt: {
    input: scopeRefSchema.extend({ id: z.string() }).strict(),
    output: z.object({
      prompt: promptSchema.nullable(),
      error: z.string().nullable(),
    }),
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
    input: scopeRefSchema
      .extend({ ids: z.array(z.string()).max(500) })
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
    input: z
      .object({
        excludeThreadId: z.string().nullable(),
        query: z.string().max(200).optional(),
      })
      .strict(),
    output: z.object({
      threads: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          projectId: z.string().nullable(),
        }),
      ),
      total: z.number(),
    }),
  },
  sendPromptToThread: {
    input: z.object({ id: z.string(), threadId: z.string() }).strict(),
    output: z.object({ sent: z.boolean(), error: z.string().nullable() }),
  },
  overview: {
    input: z.null(),
    output: z.object({
      globalPrompts: z.array(promptSchema),
      projects: z.array(
        z.object({
          projectId: z.string(),
          name: z.string(),
          prompts: z.array(promptSchema),
        }),
      ),
      threads: z.array(
        z.object({
          threadId: z.string(),
          title: z.string(),
          projectId: z.string().nullable(),
          paused: z.boolean(),
          nativeCount: z.number(),
          prompts: z.array(promptSchema),
        }),
      ),
      snippets: z.array(snippetSchema),
      snippetTotal: z.number(),
      recentlyUsed: z.array(promptSchema),
      /** Groups the server declined to expand, so the UI can say so. */
      hiddenThreads: z.number(),
      hiddenProjects: z.number(),
    }),
  },
  listNativeQueue: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      items: z.array(
        z.object({ id: z.string(), text: z.string(), updatedAt: z.number() }),
      ),
      error: z.string().nullable(),
    }),
  },
  pushToNativeQueue: {
    input: z.object({ id: z.string(), threadId: z.string() }).strict(),
    output: z.object({ pushed: z.boolean(), error: z.string().nullable() }),
  },
  stashNativeMessage: {
    input: z
      .object({ threadId: z.string(), queuedMessageId: z.string() })
      .strict(),
    output: z.object({
      prompt: promptSchema.nullable(),
      error: z.string().nullable(),
    }),
  },
  stashAllNative: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      stashed: z.number(),
      skipped: z.number(),
      error: z.string().nullable(),
    }),
  },
  sendNativeNow: {
    input: z
      .object({ threadId: z.string(), queuedMessageId: z.string() })
      .strict(),
    output: z.object({ sent: z.boolean(), error: z.string().nullable() }),
  },
  listSnippets: {
    input: z
      .object({ query: z.string(), projectId: z.string().nullable() })
      .strict(),
    output: z.object({ snippets: z.array(snippetSchema), total: z.number() }),
  },
  addSnippet: {
    input: z
      .object({
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(PROMPT_TEXT_CAP),
        description: z.string().max(500).optional(),
        keywords: z.string().max(200).optional(),
        groupName: z.string().max(100).nullable().optional(),
        projectId: z.string().nullable().optional(),
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
        projectId: z.string().nullable().optional(),
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
  /** Queue a whole snippet group in writing order — a playbook, in one click. */
  queueSnippetGroup: {
    input: scopeRefSchema.extend({ groupName: z.string().min(1) }).strict(),
    output: z.object({ queued: z.number(), error: z.string().nullable() }),
  },
  suggestSnippets: {
    input: z.object({ refresh: z.boolean() }).strict(),
    output: z.object({
      suggestions: z.array(suggestionSchema),
      analyzed: z.number(),
      considered: z.number(),
      dropped: z.number(),
      computedAt: z.number(),
      dismissedCount: z.number(),
      /** A rescan is running in the background; results arrive over realtime. */
      computing: z.boolean(),
      /** False when the user switched history mining off in settings. */
      enabled: z.boolean(),
      lastError: z.string().nullable(),
    }),
  },
  dismissSuggestion: {
    input: z.object({ key: z.string(), body: z.string() }).strict(),
    output: z.object({ dismissed: z.boolean() }),
  },
  restoreSuggestions: {
    input: z.null(),
    output: z.object({ restored: z.number() }),
  },
  /** Last values the user typed for these {{tokens}}. */
  fillValues: {
    input: z.object({ tokens: z.array(z.string()).max(50) }).strict(),
    output: z.object({ values: z.record(z.string(), z.string()) }),
  },
  rememberFillValues: {
    input: z
      .object({ values: z.record(z.string(), z.string()) })
      .strict(),
    output: z.object({ saved: z.boolean() }),
  },
});

export type RpcContract = typeof rpcContract;

// The frontend imports these with `import type`, so this module — and zod with
// it — is erased from the app bundle. One definition, two sides of the wire.
export type PromptDto = z.infer<typeof promptSchema>;
export type SnippetDto = z.infer<typeof snippetSchema>;
export type SuggestionDto = z.infer<typeof suggestionSchema>;
