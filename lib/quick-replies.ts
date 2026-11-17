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
 * Words that do not change what a short prompt asks for. "and" and "or"
 * are not here ("review the PR" is not "review the PR and merge it"), and
 * neither are single letters ("option A" is not "option B").
 */
const FILLER_WORDS = new Set(
  "an the to in on of for it its this that these those please pls now just then also ok okay".split(" "),
);
const NEGATIONS = new Set(["no", "not", "dont", "don", "never", "without", "stop", "skip"]);

function meaningWords(text: string): Set<string> {
  return new Set(
    replyKey(text)
      .replace(/n't\b/g, " not")
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((word) => word && !FILLER_WORDS.has(word)),
  );
}

const negated = (words: ReadonlySet<string>) => [...words].some((word) => NEGATIONS.has(word));

/**
 * Do two prompts ask for the same thing? "use ask mode" and "use ask mode
 * in bb" do: every meaningful word of the shorter is in the longer, which
 * adds at most one more, and both have at least two. "fix it" and "fix all"
 * do not (one word is too little), nor do "push to main" and "don't push to
 * main" (one says no), nor "review the PR" and "review the PR and merge it"
 * (a second step).
 */
export function similarReplies(a: string, b: string): boolean {
  const left = meaningWords(a);
  const right = meaningWords(b);
  if (Math.min(left.size, right.size) < 2) return replyKey(a) === replyKey(b);
  return sameRequest(left, right);
}

/** similarReplies on meaning words already worked out, both at least two. */
function sameRequest(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  if (large.size - small.size > 1) return false;
  for (const word of small) if (!large.has(word)) return false;
  return negated(small) === negated(large);
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

  // Two phrasings of one request ("use ask mode", "use ask mode in bb") are
  // one habit: the counts join, the spelling typed most stays. The same
  // request has the same meaning words, or one more or one fewer, so each
  // phrase looks its matches up by those word sets instead of meeting every
  // kept phrase: that ran for seconds on a long history.
  const merged: { group: (typeof kept)[number]; words: Set<string> }[] = [];
  const bySet = new Map<string, number[]>();
  const byMissingOne = new Map<string, number[]>();
  const setKey = (words: Iterable<string>) => [...words].sort().join(" ");
  const add = (index: Map<string, number[]>, key: string, at: number) => {
    const list = index.get(key);
    if (list) list.push(at);
    else index.set(key, [at]);
  };
  for (const group of kept.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))) {
    const words = meaningWords(group.key);
    const all = setKey(words);
    const fewer = words.size > 2 ? [...words].map((word) => setKey([...words].filter((w) => w !== word))) : [];
    // Under two words only an exact repeat is the same, and keys are unique.
    let home = -1;
    if (words.size >= 2)
      for (const at of [
        ...(bySet.get(all) ?? []),
        ...fewer.flatMap((key) => bySet.get(key) ?? []),
        ...(byMissingOne.get(all) ?? []),
      ])
        if ((home === -1 || at < home) && sameRequest(merged[at]!.words, words)) home = at;
    if (home !== -1) {
      merged[home]!.group.count += group.count;
      continue;
    }
    const at = merged.push({ group, words }) - 1;
    if (words.size < 2) continue;
    add(bySet, all, at);
    for (const key of fewer) add(byMissingOne, key, at);
  }

  return merged
    .map((entry) => entry.group)
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

/** A label cut to fit a chip; the full text belongs in the tooltip. */
export function shortLabel(label: string): string {
  return label.length > QUICK_REPLY_LABEL_CHARS
    ? `${label.slice(0, QUICK_REPLY_LABEL_CHARS - 1).trimEnd()}…`
    : label;
}

// ---------------------------------------------------------------------------
// The row with AI suggestions: what it shows in each moment.

/** Where a chip came from; each kind has its own mark. */
export type RowKind = "answer" | "ai" | "habit" | "snippet" | "any" | "retry";

/**
 * What a tap does. `send` sends (or joins a draft), `retry` re-runs the
 * failed turn, `queue` waits in this plugin's queue for the turn to end,
 * `complete` replaces the draft it matched, `fill` opens a snippet with
 * fill-ins in the composer instead of sending it.
 */
export type RowAction = "send" | "retry" | "queue" | "complete" | "fill";

export interface RowItem {
  label: string;
  text: string;
  kind: RowKind;
  /** Why it is there; empty for the user's own chips. */
  why: string;
  /** The model's best next step: the solid chip and the card's default. */
  best: boolean;
  /** Leads after a stop (Continue, retry): the accent outline. */
  primary: boolean;
  action: RowAction;
}

/**
 * - `hidden`: the agent asked something; its answer form owns the composer.
 * - `baseline`: the user's usual chips, no model involved.
 * - `loading`: the usual chips while the model reads the thread; a quiet
 *   "Reading the thread" sits at the row's end until the picks land.
 * - `ai`: the model's picks.
 * - `queue`: the agent is working; chips wait for the turn to end.
 * - `filter`: chips that complete the draft.
 * - `stopped`: a failed turn; Retry leads.
 */
export type RowMode = "hidden" | "baseline" | "loading" | "ai" | "queue" | "filter" | "stopped";

export interface AiReplyLike {
  label: string;
  text: string;
  kind: "answer" | "ai" | "habit" | "snippet";
  why: string;
  best: boolean;
}

export type AiStatus = "idle" | "off" | "empty" | "pending" | "ready" | "error";

export interface RowInput {
  state: QuickReplyState;
  config: QuickReplyConfig;
  learned: readonly QuickReply[];
  snippets: readonly QuickReply[];
  ai: { status: AiStatus; replies: readonly AiReplyLike[] };
  draft: string;
  /** Reply keys the user dismissed for this turn. */
  dismissed: ReadonlySet<string>;
}

export interface Row {
  mode: RowMode;
  items: RowItem[];
}

/** Habits shown while the agent works, before the any-time chips. */
export const QUEUE_CHIPS = 4;

const hasFillIns = (text: string) => /\{\{\s*[^}]+\}\}/.test(text);

function item(
  reply: QuickReply,
  kind: RowKind,
  action: RowAction,
  extra: Partial<Pick<RowItem, "why" | "best" | "primary">> = {},
): RowItem {
  return {
    label: reply.label,
    text: reply.text,
    kind,
    why: extra.why ?? "",
    best: extra.best ?? false,
    primary: extra.primary ?? false,
    action: kind === "snippet" && action === "send" && hasFillIns(reply.text) ? "fill" : action,
  };
}

/**
 * One chip per idea, the first one kept: an exact or near repeat ("Use ask
 * mode" after "Use ask mode in bb") and anything dismissed drop out, and so
 * does a repeat of something dismissed. Two chips never read the same.
 */
function dedupe(items: readonly RowItem[], dismissed: ReadonlySet<string>): RowItem[] {
  const out: RowItem[] = [];
  const seen: RowItem[] = [];
  for (const entry of items) {
    const key = replyKey(entry.text);
    if (!key) continue;
    // Answers to the agent's question are its options: never merged, only
    // an exact repeat drops.
    const answer = entry.kind === "answer";
    const repeats = seen.some(
      (kept) =>
        replyKey(kept.text) === key ||
        replyKey(kept.label) === replyKey(entry.label) ||
        (!answer && kept.kind !== "answer" && similarReplies(kept.text, entry.text)),
    );
    if (repeats) continue;
    seen.push(entry);
    if (!dismissed.has(key)) out.push(entry);
  }
  return out;
}

/** The user's own chips after a finished turn: their list, else what they type most. */
function usual(config: QuickReplyConfig, learned: readonly QuickReply[]): RowItem[] {
  const source =
    config.afterDone.length > 0 ? config.afterDone : learned.length > 0 ? learned : FALLBACK_FOLLOW_UPS;
  const kind: RowKind = config.afterDone.length > 0 ? "any" : learned.length > 0 ? "habit" : "any";
  return source.map((reply) => item(reply, kind, "send"));
}

/** The first `count` distinct chips: repeats drop before counting, so the next one fills in. */
function take(items: readonly RowItem[], count: number, dismissed: ReadonlySet<string>): RowItem[] {
  return dedupe(items, dismissed).slice(0, count);
}

function aiItems(replies: readonly AiReplyLike[]): RowItem[] {
  return replies.map((reply) =>
    item({ label: reply.label, text: reply.text }, reply.kind, "send", {
      why: reply.why,
      best: reply.best,
    }),
  );
}

/**
 * The row for this moment: the chips in order, which one is the best next
 * step, and whether the card above them shows. A pure function of what the
 * row knows, so every state is testable without a browser.
 */
export function rowFor(input: RowInput): Row {
  const { state, config, ai, dismissed } = input;
  const anyTime = config.anyTime.map((reply) => item(reply, "any", "send"));
  const aiReady = ai.status === "ready" && ai.replies.length > 0;

  if (state === "waiting") return { mode: "hidden", items: []};

  if (state === "running") {
    // The usual follow-ups, waiting for the turn to end; any-time chips
    // (Status) still send at once.
    const queued = take(usual(config, input.learned), QUEUE_CHIPS, dismissed).map((entry) => ({
      ...entry,
      action: "queue" as const,
    }));
    return { mode: "queue", items: dedupe([...queued, ...anyTime], dismissed)};
  }

  // A draft narrows the row to chips that complete it.
  const draft = input.draft.trim();
  if (draft) {
    const pool = dedupe(
      [
        ...(aiReady ? aiItems(ai.replies) : []),
        ...input.learned.map((reply) => item(reply, "habit", "send")),
        ...input.snippets.map((reply) => item(reply, "snippet", "send")),
        ...config.anyTime.map((reply) => item(reply, "any", "send")),
      ],
      dismissed,
    );
    const matches = matchItems(pool, draft).slice(0, QUICK_REPLY_FOLLOW_UPS);
    if (matches.length > 0)
      return {
        mode: "filter",
        items: matches.map((entry, index) => ({
          ...entry,
          best: index === 0,
          primary: false,
          // Completing a draft never sends, so a snippet with fill-ins is safe too.
          action: "complete",
        })),
      };
  }

  if (state === "failed") {
    const lead = config.afterStop.map((reply, index) =>
      item(reply, index === 0 ? "retry" : "any", index === 0 ? "retry" : "send", { primary: index === 0 }),
    );
    return { mode: "stopped", items: dedupe([...lead, ...anyTime], dismissed)};
  }

  if (state === "interrupted" || state === "finished") {
    const lead =
      state === "interrupted"
        ? config.afterStop.slice(0, 1).map((reply) => item(reply, "any", "send", { primary: true }))
        : [];
    if (aiReady) {
      const items = dedupe([...lead, ...aiItems(ai.replies), ...anyTime], dismissed);
      // Dismissing the best one passes "best" to the next model pick.
      if (!items.some((entry) => entry.best)) {
        const next = items.find((entry) => entry.kind !== "any" && !entry.primary);
        if (next) next.best = true;
      }
      return { mode: "ai", items};
    }
    const follow = state === "finished" ? take(usual(config, input.learned), QUICK_REPLY_FOLLOW_UPS, dismissed) : [];
    const items = dedupe([...lead, ...follow, ...anyTime], dismissed);
    return { mode: ai.status === "pending" ? "loading" : "baseline", items };
  }

  return { mode: "baseline", items: dedupe(anyTime, dismissed)};
}

function matchItems(items: readonly RowItem[], draft: string): RowItem[] {
  const needle = replyKey(draft);
  if (!needle) return [];
  const starts = (value: string) => {
    const key = replyKey(value);
    return key.startsWith(needle) || key.includes(` ${needle}`);
  };
  const prefix = items.filter(
    (entry) => replyKey(entry.label).startsWith(needle) || replyKey(entry.text).startsWith(needle),
  );
  const word = items.filter((entry) => !prefix.includes(entry) && (starts(entry.label) || starts(entry.text)));
  // A chip that only repeats the draft completes nothing.
  return [...prefix, ...word].filter((entry) => replyKey(entry.text) !== needle);
}
