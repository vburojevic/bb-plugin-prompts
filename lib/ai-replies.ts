// AI quick replies: the pure half.
//
// A small model reads the end of a thread and proposes the messages the user
// is most likely to send next. This module owns everything that can be tested
// without a model or bb: what the model is told, how its answer is read back,
// which model runs, how the conversation is cut from the thread's events, and
// how the user's taps and dismissals reorder their habits.
//
// No bb or node imports: the server and the frontend share it.

import { labelFor, replyKey } from "./quick-replies";

/** Where a reply came from; the chip shows a different mark for each. */
export type AiReplyKind = "answer" | "ai" | "habit" | "snippet";

export interface AiReply {
  /** Two to five words: what the chip shows. */
  label: string;
  /** The full message the chip sends. */
  text: string;
  kind: AiReplyKind;
  /** One short line on why it fits now; the preview shows it. */
  why: string;
  /** The model's single best next step. Exactly one reply has it. */
  best: boolean;
}

/** Replies shown after a finished turn, before the any-time chips. */
export const AI_REPLY_LIMIT = 5;
const LABEL_CAP = 48;
const TEXT_CAP = 4_000;
const WHY_CAP = 160;

// ---------------------------------------------------------------------------
// The conversation, cut from the thread's events.

export interface TranscriptMessage {
  role: "user" | "agent";
  text: string;
}

export interface ItemEventLike {
  type: string;
  data?: unknown;
}

export interface Transcript {
  /** Oldest first. */
  messages: TranscriptMessage[];
  /**
   * Identifies the turn the suggestions answer: the newest agent message's id.
   * Null while the thread has no agent reply to follow up on.
   */
  turnKey: string | null;
}

const PROVIDER_ERROR =
  /^(failed to authenticate|api error|provider error|request failed|rate limit|overloaded|you've hit your limit|credit balance)/i;

/** The newest agent reply keeps this much; it is what the user answers. */
const LAST_REPLY_CAP = 6_000;
const EARLIER_REPLY_CAP = 1_200;
const USER_MESSAGE_CAP = 800;

/** Keep the start and the end of a long text: the question is usually last. */
export function clip(text: string, cap: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;
  const head = Math.floor(cap * 0.3);
  const tail = cap - head - 3;
  return `${trimmed.slice(0, head).trimEnd()}\n…\n${trimmed.slice(-tail).trimStart()}`;
}

function itemOf(event: ItemEventLike): Record<string, unknown> | null {
  if (event.type !== "item/completed") return null;
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  const item = (data as { item?: unknown }).item;
  return typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
}

function userText(item: Record<string, unknown>): string {
  const content = item.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n")
    .trim();
}

/**
 * The last `limit` user and agent messages, oldest first, from `item/completed`
 * events listed newest first. A sub-agent's messages (they carry a parent tool
 * call) are the agent talking to itself and stay out.
 */
export function transcriptFromEvents(
  eventsNewestFirst: readonly ItemEventLike[],
  limit = 8,
): Transcript {
  const newestFirst: TranscriptMessage[] = [];
  let turnKey: string | null = null;
  for (const event of eventsNewestFirst) {
    const item = itemOf(event);
    if (!item || item.parentToolCallId) continue;
    if (item.type === "agentMessage") {
      const text = String(item.text ?? "").trim();
      // A provider error shown as the agent's text belongs to a failed turn a
      // later one moved past; offered to the model, it suggests fixing it.
      if (!text || PROVIDER_ERROR.test(text)) continue;
      if (turnKey === null && typeof item.id === "string") turnKey = item.id;
      const first = !newestFirst.some((message) => message.role === "agent");
      newestFirst.push({ role: "agent", text: clip(text, first ? LAST_REPLY_CAP : EARLIER_REPLY_CAP) });
    } else if (item.type === "userMessage") {
      const text = userText(item);
      if (!text) continue;
      newestFirst.push({ role: "user", text: clip(text, USER_MESSAGE_CAP) });
    }
    if (newestFirst.length >= limit) break;
  }
  // A user message newer than every agent reply means a turn is starting:
  // there is nothing to follow up on yet.
  if (newestFirst[0]?.role === "user") turnKey = null;
  return { messages: newestFirst.reverse(), turnKey };
}

// ---------------------------------------------------------------------------
// What the model is told.

export interface SuggestPromptInput {
  title: string | null;
  /** How the latest turn ended. */
  outcome: "finished" | "interrupted";
  messages: readonly TranscriptMessage[];
  /** The short prompts the user sends most, ranked. */
  habits: readonly { text: string; count: number }[];
  /** Saved snippets the model may pick, by id. */
  snippets: readonly { id: string; title: string; body: string }[];
  /** A few of the user's own recent messages, so replies sound like them. */
  voice: readonly string[];
  /** Replies the user dismissed lately; never suggest these again. */
  avoid: readonly string[];
  limit?: number;
}

const HABITS_SHOWN = 12;
const SNIPPETS_SHOWN = 12;
const VOICE_SHOWN = 8;
const AVOID_SHOWN = 20;

function quote(text: string): string {
  return JSON.stringify(text.replace(/\s+/g, " ").trim());
}

export function buildSuggestPrompt(input: SuggestPromptInput): string {
  const limit = input.limit ?? AI_REPLY_LIMIT;
  const conversation = input.messages
    .map((message) =>
      message.role === "user"
        ? `<user>\n${message.text}\n</user>`
        : `<agent>\n${message.text}\n</agent>`,
    )
    .join("\n");
  const habits = input.habits
    .slice(0, HABITS_SHOWN)
    .map((habit) => `- ${quote(habit.text)} (sent ${habit.count} times)`)
    .join("\n");
  const snippets = input.snippets
    .slice(0, SNIPPETS_SHOWN)
    .map(
      (snippet) =>
        `- ${snippet.id}: ${quote(snippet.title)}, starts ${quote(snippet.body.slice(0, 160))}`,
    )
    .join("\n");
  const voice = input.voice
    .slice(0, VOICE_SHOWN)
    .map((text) => `- ${quote(text.slice(0, 200))}`)
    .join("\n");
  const avoid = input.avoid
    .slice(0, AVOID_SHOWN)
    .map((text) => `- ${quote(text)}`)
    .join("\n");

  return [
    // "You are …" also keeps this prompt out of snippet mining, which skips
    // machine-written briefings (suggest.ts, MACHINE_PATTERNS).
    "You are writing quick replies: the next messages a user is most likely to send to their coding agent, shown as one-tap chips above the message box.",
    "Answer from the text below only. Do not use tools, read files or run commands. Do not do the work the conversation is about.",
    "",
    `Thread: ${input.title ? quote(input.title) : "untitled"}`,
    input.outcome === "interrupted"
      ? "The user stopped the agent's last turn before it finished."
      : "The agent's last turn finished.",
    "",
    "Conversation, oldest first. The agent's last reply matters most:",
    conversation || "(empty)",
    "",
    "The user's habits, short prompts they send often:",
    habits || "(none yet)",
    "",
    "The user's saved snippets, by id:",
    snippets || "(none)",
    "",
    "How the user writes, for voice only (do not repeat these):",
    voice || "(no samples)",
    "",
    "Dismissed lately, never suggest again:",
    avoid || "(none)",
    "",
    "Rules:",
    `- Suggest up to ${limit} replies, most useful first. Mark exactly one as best: the single message most worth sending right now.`,
    '- When the agent\'s last reply asks the user a question or offers options, the first replies answer it, one per real option, kind "answer".',
    '- Write replies specific to this thread, kind "ai": name the files, tests, errors and decisions from the conversation.',
    '- Add a habit (kind "habit", text exactly as listed) or a snippet (kind "snippet", with its id) only when it clearly fits what should happen next.',
    "- Never suggest something the agent already did, something the user ruled out, or anything dismissed.",
    "- Every reply asks for something different. Never two that say the same thing in other words, and no habit that repeats a reply you wrote.",
    "- Skip filler: no reply that only thanks or agrees, and no bare \"continue\" unless continuing is clearly the next step.",
    "- Only the latest state counts: an error or question that a later message moved past is settled.",
    "- label: 2 to 5 words, sentence case, no final period.",
    "- text: the full message to send, written the way this user writes: short and direct, lowercase is fine, spelled correctly, no greeting, under 240 characters.",
    "- why: one short line on why it fits now, under 90 characters.",
    "",
    'Reply with JSON only, no prose and no code fence: {"replies":[{"kind":"answer","label":"...","text":"...","why":"...","best":true,"snippet":null}]}',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reading the model's answer back.

/**
 * The first balanced JSON object in `raw` that has a `replies` array. Models
 * wrap JSON in fences or prose, and other plugins' instructions can append a
 * marker with braces of its own after it, so "first `{` to last `}`" is not
 * enough.
 */
export function extractRepliesJson(raw: string): unknown[] | null {
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(raw.slice(start, index + 1)) as { replies?: unknown };
            if (Array.isArray(value.replies)) return value.replies;
          } catch {
            // Not this one; try the next opening brace.
          }
          break;
        }
      }
    }
  }
  return null;
}

function oneLine(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return text.length > cap ? `${text.slice(0, cap - 1).trimEnd()}…` : text;
}

export interface ParseContext {
  habits: readonly { text: string }[];
  snippets: readonly { id: string; title: string; body: string }[];
  limit?: number;
}

/**
 * The model's replies, cleaned: unknown kinds become "ai", a habit sends the
 * user's own spelling, a snippet sends its saved body, duplicates and empties
 * drop, and exactly one reply is best, listed first. An unreadable answer
 * yields no replies, never a throw.
 */
export function parseSuggestReply(raw: string, context: ParseContext): AiReply[] {
  const items = extractRepliesJson(raw);
  if (!items) return [];
  const limit = context.limit ?? AI_REPLY_LIMIT;
  const habitsByKey = new Map(context.habits.map((habit) => [replyKey(habit.text), habit.text]));
  const snippetsById = new Map(context.snippets.map((snippet) => [snippet.id, snippet]));
  const out: AiReply[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    let kind: AiReplyKind =
      entry.kind === "answer" || entry.kind === "habit" || entry.kind === "snippet"
        ? entry.kind
        : "ai";
    let label = oneLine(entry.label, LABEL_CAP);
    let text = typeof entry.text === "string" ? entry.text.trim().slice(0, TEXT_CAP) : "";

    if (kind === "snippet") {
      const snippet =
        typeof entry.snippet === "string" ? snippetsById.get(entry.snippet.trim()) : undefined;
      if (snippet) {
        text = snippet.body;
        label = label || oneLine(snippet.title, LABEL_CAP);
      } else kind = "ai";
    }
    if (kind === "habit") {
      const own = habitsByKey.get(replyKey(text));
      if (own) text = own;
      else kind = "ai";
    }
    if (!text) continue;
    if (!label) label = oneLine(text, LABEL_CAP);
    const key = replyKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: labelFor(label),
      text,
      kind,
      why: oneLine(entry.why, WHY_CAP),
      best: entry.best === true,
    });
    if (out.length >= limit) break;
  }

  const bestIndex = Math.max(
    0,
    out.findIndex((reply) => reply.best),
  );
  return out
    .map((reply, index) => ({ ...reply, best: out.length > 0 && index === bestIndex }))
    .sort((a, b) => Number(b.best) - Number(a.best));
}

// ---------------------------------------------------------------------------
// Which model runs.

export interface CatalogModel {
  model: string;
  displayName?: string | null;
  description?: string | null;
  /** Reasoning levels the model takes, in bb's order. */
  reasoningLevels?: readonly string[];
}

/**
 * The fastest small model per provider. Quick replies are latency-bound, so
 * they are the one place this plugin does not use a provider's flagship (the
 * owner's call, 2026-11-17). A test pins these.
 */
export const SMALL_MODELS: Readonly<Record<string, string>> = {
  "claude-code": "claude-haiku-5-5",
  codex: "gpt-6-luna",
};

const SMALL_WORDS = /\b(haiku|mini|nano|flash|lite|small|luna)\b/;
const FAST_WORDS = /\b(fast|fastest|quick|cheap|affordable)\b/;
const OLD_WORDS = /\b(older|legacy|deprecated|preview)\b/;

/**
 * The model quick replies use for `providerId`: the user's override, else the
 * pinned small model when the provider still offers it, else the catalog
 * model that reads smallest and fastest. Null means "the provider's default".
 */
export function smallModelFor(
  providerId: string,
  catalog: readonly CatalogModel[] | null,
  overrides: ReadonlyMap<string, string> = new Map(),
): string | null {
  const override = overrides.get(providerId);
  if (override) return override;
  const pinned = SMALL_MODELS[providerId] ?? null;
  if (!catalog || catalog.length === 0) return pinned;
  if (pinned && catalog.some((entry) => entry.model === pinned)) return pinned;
  let best: { model: string; score: number } | null = null;
  for (const entry of catalog) {
    const hay = `${entry.model} ${entry.displayName ?? ""} ${entry.description ?? ""}`.toLowerCase();
    let score = 0;
    if (SMALL_WORDS.test(hay)) score += 2;
    if (FAST_WORDS.test(hay)) score += 2;
    if (OLD_WORDS.test(hay)) score -= 1;
    if (best === null || score > best.score) best = { model: entry.model, score };
  }
  return best !== null && best.score > 0 ? best.model : pinned;
}

/**
 * The thinking level quick replies ask for: medium (the owner's call,
 * 2026-11-17), when the model lists it. Null leaves the model's default.
 */
export const QUICK_REPLY_REASONING = "medium";

export function reasoningFor(model: CatalogModel | undefined): string | null {
  return model?.reasoningLevels?.includes(QUICK_REPLY_REASONING) ? QUICK_REPLY_REASONING : null;
}

/**
 * Overrides from settings, one per line: `provider = model`. Blank lines and
 * `#` comments are skipped; a line without `=` is ignored.
 */
export function parseModelOverrides(value: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value !== "string") return out;
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const provider = line.slice(0, eq).trim();
    const model = line.slice(eq + 1).trim();
    if (/^[\w.-]+$/.test(provider) && /^[\w.:/@-]+$/.test(model)) out.set(provider, model);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Learning from taps and dismissals.

export interface ReplyFeedback {
  taps: number;
  dismissals: number;
}

/**
 * Habits reordered by what the user did with them in this project: a tap is
 * worth five sends, and a habit dismissed more often than tapped is dropped,
 * the same rule that keeps the model from suggesting it again.
 */
export function rankHabits<T extends { text: string; count: number }>(
  habits: readonly T[],
  feedback: ReadonlyMap<string, ReplyFeedback>,
): T[] {
  const scored = habits
    .map((habit, index) => {
      const fb = feedback.get(replyKey(habit.text));
      const taps = fb?.taps ?? 0;
      const dismissals = fb?.dismissals ?? 0;
      return { habit, index, taps, dismissals, score: habit.count + taps * 5 };
    })
    .filter((entry) => entry.dismissals <= entry.taps);
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.habit);
}
