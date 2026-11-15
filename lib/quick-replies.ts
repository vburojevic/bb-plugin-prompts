// Quick replies: the chip row above the composer.
//
// Pure functions, no bb or node imports, so the server (learning) and the
// frontend (state and chip choice) share one tested implementation.
//
// Three inputs decide the row:
// - the thread's state: running, waiting on the user, or idle after a turn
//   that finished, failed, or was interrupted;
// - the user's chip lists from settings, one chip per line;
// - the short prompts the user types most, learned from local prompt history.

import { isMachinePrompt } from "./suggest";

export interface QuickReply {
  /** What the chip shows. */
  label: string;
  /** What the chip sends. */
  text: string;
}

export interface LearnedReply extends QuickReply {
  /** History entries folded into this reply, typos included. */
  count: number;
}

/** A prompt longer than this is a request, not a reflex. */
export const QUICK_REPLY_MAX_CHARS = 40;
/** Typed fewer times than this, it is not a habit yet. */
export const QUICK_REPLY_MIN_COUNT = 3;
/** Learned replies kept in the cache; the row shows fewer. */
export const QUICK_REPLY_CACHE_SIZE = 12;
/** Chips shown after a finished turn, before the any-time ones. */
export const QUICK_REPLY_FOLLOW_UPS = 5;
/** A label longer than this is cut with an ellipsis; the full text stays in the tooltip. */
export const QUICK_REPLY_LABEL_CHARS = 28;

/**
 * Shown after a finished turn when nothing has been learned yet (a fresh
 * install, or history scanning switched off). Invented, generic phrases.
 */
export const FALLBACK_FOLLOW_UPS: readonly QuickReply[] = [
  { label: "Continue", text: "continue" },
  { label: "Run the tests", text: "run the tests" },
  { label: "Summarize what changed", text: "summarize what changed" },
];

export const DEFAULT_AFTER_STOP = "Continue | continue";
export const DEFAULT_ANY_TIME = "Status | status";

// ---------------------------------------------------------------------------
// Settings: one chip per line, "Label | text to send" or just the text.

/** Sentence case for a label: "commit and push" -> "Commit and push". */
export function labelFor(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.startsWith("/")) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Parse a settings value into chips. Blank lines and `#` comments are
 * skipped; a line without `|` sends what it shows. Duplicate texts keep the
 * first. Settings are untrusted input: every line is trimmed and capped.
 */
export function parseReplyLines(value: string | null | undefined): QuickReply[] {
  if (typeof value !== "string") return [];
  const out: QuickReply[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const bar = line.indexOf("|");
    const label = bar === -1 ? "" : line.slice(0, bar).trim();
    const text = (bar === -1 ? line : line.slice(bar + 1)).trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: (label || labelFor(text)).slice(0, 80),
      text: text.slice(0, 2_000),
    });
    if (out.length >= 20) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Learning: the short prompts this user types most.

/** Matching form: lowercase, trailing punctuation off, spaces collapsed. */
export function replyKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!?,;:]+$/u, "")
    .replace(/^[\s.!?,;:]+/u, "")
    .trim();
}

/**
 * Optimal string alignment distance (Levenshtein plus adjacent swaps), capped:
 * returns `max + 1` as soon as the answer is known to exceed `max`.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) d[i]![0] = i;
  for (let j = 0; j < cols; j += 1) d[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, d[i - 2]![j - 2]! + 1);
      d[i]![j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/**
 * Is `variant` a typo of `canonical`? One slip (a wrong, missing, extra or
 * swapped letter) in a word long enough that a slip is unlikely to make a
 * different word, and rare next to the spelling it slipped from. Two real
 * phrases one letter apart ("fix it" and "fix all" are not) both stay.
 */
function isTypoOf(
  variant: { key: string; count: number },
  canonical: { key: string; count: number },
): boolean {
  if (variant.key.length < 5 || canonical.key.length < 5) return false;
  if (variant.count * 3 > canonical.count) return false;
  return editDistance(variant.key, canonical.key, 1) <= 1;
}

/** Text that cannot be a chip: commands, digits-only answers, links, multi-line. */
function isChipable(text: string): boolean {
  if (text.length > QUICK_REPLY_MAX_CHARS) return false;
  if (/[\r\n]/.test(text)) return false;
  // A typed "/command" is a mention pill in the composer; sent as plain text
  // it would not run the command. Leave commands to settings, where the user
  // decides.
  if (text.startsWith("/")) return false;
  if (/https?:\/\//i.test(text)) return false;
  // "1", "2", "ok": answers to a question on screen, not habits worth a chip.
  if ((text.match(/\p{L}/gu) ?? []).length < 3) return false;
  return !isMachinePrompt(text);
}

/**
 * The short prompts typed most, typos folded into the spelling typed most.
 * Each reply sends the most common way the user actually wrote it.
 */
export function learnQuickReplies(
  history: readonly { text: string }[],
  limit = QUICK_REPLY_CACHE_SIZE,
): LearnedReply[] {
  const groups = new Map<string, { count: number; forms: Map<string, number> }>();
  for (const entry of history) {
    const raw = entry.text.trim();
    if (/[\r\n]/.test(raw)) continue;
    const text = raw.replace(/\s+/g, " ");
    if (!isChipable(text)) continue;
    const key = replyKey(text);
    if (!key) continue;
    const group = groups.get(key) ?? { count: 0, forms: new Map<string, number>() };
    group.count += 1;
    group.forms.set(text, (group.forms.get(text) ?? 0) + 1);
    groups.set(key, group);
  }

  const ranked = [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  // Most typed first, so a typo always meets its canonical spelling already
  // kept. Only a phrase typed at least QUICK_REPLY_MIN_COUNT times can absorb
  // typos (isTypoOf wants it three times as common), so the long tail is
  // never compared pairwise: that ran for seconds on a large history.
  const kept: { key: string; count: number; forms: Map<string, number> }[] = [];
  const absorbers: typeof kept = [];
  for (const group of ranked) {
    const home = absorbers.find((candidate) => isTypoOf(group, candidate));
    if (home) {
      home.count += group.count;
      continue;
    }
    const entry = { key: group.key, count: group.count, forms: new Map(group.forms) };
    kept.push(entry);
    if (entry.count >= QUICK_REPLY_MIN_COUNT) absorbers.push(entry);
  }

  return kept
    .filter((group) => group.count >= QUICK_REPLY_MIN_COUNT)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((group) => {
      const text = [...group.forms.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]![0];
      return { label: labelFor(text), text, count: group.count };
    });
}

// ---------------------------------------------------------------------------
// Thread state.

/** How the thread's latest turn ended, as far as the event log says. */
export type TurnOutcome = "completed" | "failed" | "interrupted" | "none";

export interface TurnEventLike {
  type: string;
  data?: unknown;
}

/**
 * Read the latest turn's outcome from thread events, newest first, of the
 * types `turn/started`, `turn/completed` and `system/thread/interrupted`.
 * An interrupt can land as its own event next to a `turn/completed` that says
 * "completed", so any interrupt since the latest turn started wins.
 */
export function turnOutcomeFromEvents(eventsNewestFirst: readonly TurnEventLike[]): TurnOutcome {
  let outcome: TurnOutcome = "none";
  for (const event of eventsNewestFirst) {
    if (event.type === "turn/started") break;
    if (event.type === "system/thread/interrupted") return "interrupted";
    if (event.type === "turn/completed" && outcome === "none") {
      const status =
        typeof event.data === "object" && event.data !== null
          ? (event.data as { status?: unknown }).status
          : undefined;
      outcome =
        status === "failed" || status === "interrupted" || status === "completed"
          ? status
          : "completed";
    }
  }
  return outcome;
}

/** What the row reacts to. */
export type QuickReplyState =
  /** The agent is working. */
  | "running"
  /** The agent asked something; the answer form owns the composer. */
  | "waiting"
  /** The latest turn failed: a provider error, a rate limit. */
  | "failed"
  /** The user or bb stopped the latest turn. */
  | "interrupted"
  /** The latest turn ended normally. */
  | "finished"
  /** Nothing has run yet, or the thread state is still loading. */
  | "unknown";

export function quickReplyState(input: {
  /** The thread's execution status ("idle", "active", "error", …). */
  status: string | null;
  isRunning: boolean;
  hasPendingInteraction: boolean;
  outcome: TurnOutcome;
}): QuickReplyState {
  if (input.hasPendingInteraction) return "waiting";
  if (input.isRunning) return "running";
  const status = input.status;
  if (status === "active" || status === "starting" || status === "stopping" || status === "pending")
    return "running";
  if (status === "error") return "failed";
  if (input.outcome === "failed") return "failed";
  if (input.outcome === "interrupted") return "interrupted";
  if (input.outcome === "completed") return "finished";
  return "unknown";
}

export interface QuickReplyConfig {
  afterStop: readonly QuickReply[];
  /** From settings; empty means "use what was learned". */
  afterDone: readonly QuickReply[];
  anyTime: readonly QuickReply[];
}

export interface Chip extends QuickReply {
  /** Leads the row: the chip the state calls for. */
  primary: boolean;
  /** Re-run the failed turn instead of sending text. */
  retry: boolean;
}

/**
 * The chips for a state, in order: what the state calls for first, then the
 * any-time ones. A text shown twice keeps its first place.
 */
export function chipsFor(
  state: QuickReplyState,
  config: QuickReplyConfig,
  learned: readonly QuickReply[],
): Chip[] {
  const lead: Chip[] = [];
  if (state === "failed" || state === "interrupted") {
    config.afterStop.forEach((reply, index) =>
      lead.push({
        ...reply,
        primary: index === 0,
        // Only after a failure, and only the first chip: that is the one the
        // owner picked to re-run the failed turn. An interrupt was on purpose;
        // the next message is the user's to write, so it is sent as text.
        retry: state === "failed" && index === 0,
      }),
    );
  } else if (state === "finished") {
    const source =
      config.afterDone.length > 0
        ? config.afterDone
        : learned.length > 0
          ? learned
          : FALLBACK_FOLLOW_UPS;
    for (const reply of source.slice(0, QUICK_REPLY_FOLLOW_UPS))
      lead.push({ label: reply.label, text: reply.text, primary: false, retry: false });
  } else if (state === "waiting") {
    return [];
  }

  const out: Chip[] = [];
  const seen = new Set<string>();
  for (const chip of [
    ...lead,
    ...config.anyTime.map((reply) => ({ ...reply, primary: false, retry: false })),
  ]) {
    const key = replyKey(chip.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chip);
  }
  return out;
}

/** A label cut to fit a chip; the full text belongs in the tooltip. */
export function shortLabel(label: string): string {
  return label.length > QUICK_REPLY_LABEL_CHARS
    ? `${label.slice(0, QUICK_REPLY_LABEL_CHARS - 1).trimEnd()}…`
    : label;
}
