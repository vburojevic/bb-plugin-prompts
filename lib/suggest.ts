// Snippet suggestions: mine bb's prompt history for prompts the user keeps
// retyping, and propose them as reusable snippets.
//
// Pure functions — no node/bb imports — so the unit tests can drive the whole
// pipeline on plain arrays and the frontend can reuse the shaping helpers.
//
// The pipeline is: drop machine-written prompts -> normalize -> cluster
// near-duplicates (typos included) -> template the slot that varies across a
// cluster into a {{fill-in}} -> drop anything an existing snippet already
// covers -> rank by how often it was retyped.

export interface HistoryPrompt {
  text: string;
  createdAt: number;
}

export interface Suggestion {
  /** Stable across recomputes so dismissals stick. */
  key: string;
  title: string;
  body: string;
  keywords: string;
  /** How many history entries folded into this cluster. */
  count: number;
  lastSeenAt: number;
  /** Distinct phrasings seen, best first. May be trimmed for storage. */
  variants: string[];
  /** How many distinct phrasings there were, even if `variants` was trimmed. */
  variantCount: number;
  /** Fill-in tokens the templater introduced, without braces. */
  tokens: string[];
}

/**
 * Below this a snippet costs more to pick than to retype. Chosen from real
 * history: it keeps multi-clause workflows ("commit, push, open pr, tag …")
 * and drops the reflex prompts ("continue", "do it", "merge it") that
 * dominate raw frequency but nobody wants in a snippet library.
 */
export const MIN_BODY_CHARS = 24;
/** Longer than this is a one-off task spec, not a reusable prompt. */
export const MAX_BODY_CHARS = 2_000;
/** A prompt has to come back at least twice before it is worth saving. */
export const MIN_COUNT = 2;
/** Blended token/trigram similarity above which two prompts are "the same". */
export const CLUSTER_THRESHOLD = 0.62;
/** An existing snippet this close to a suggestion already covers it. */
export const COVERED_THRESHOLD = 0.6;
/** Longest run of differing words still worth turning into one fill-in. */
export const MAX_SLOT_WORDS = 4;
/**
 * Clustering is O(distinct²). A heavy bb holds six figures of prompt history,
 * and the tail of it is a year old — the proposals worth making all come from
 * the recent end, so the corpus is capped there rather than left to grow into
 * a multi-second block of the server's shared event loop.
 */
export const MAX_CANDIDATES = 4_000;
/** Prompts sampled for the spelling-frequency table (normalize is not free). */
export const MAX_FREQUENCY_SAMPLE = 20_000;
/** Comparisons between breaths. Small enough that no single tick is visible. */
export const YIELD_EVERY = 200;
/**
 * Two prompts whose lengths differ by more than this ratio can never clear any
 * useful threshold (see {@link similarityOf}), so the clusterer only ever
 * compares within a length window instead of against every centroid.
 */
const LENGTH_RATIO_FLOOR = 0.45;

/** Hand the event loop back so a long mine never blocks bb's server. */
function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/**
 * Prompts bb itself (or another plugin) injected, not ones the user typed.
 * Kept to general shapes rather than any one plugin's wording: role framing,
 * bb-generated run/thread ids, and directive markers.
 */
const MACHINE_PATTERNS: RegExp[] = [
  /^you are (an? |the )?[a-z]/i, // "You are Agent A", "You are a quick delegated worker"
  /^you (rewrite|will|must|should) /i,
  /^\[bb [a-z]+ /i, // "[BB workflow name · run wfr_…]"
  /\b(?:thr|wfr|rl|qk|prj|env)_[a-z0-9]{6,}\b/, // bb-generated ids
  /^(?:relay|quick dispatch|workflow) [a-z0-9_]{6,}/i,
  /^round \d+ of \d+/i,
  /::[a-z][a-z-]*\{/, // ::directive markers
  // Strict machine output contracts — one agent briefing another, never a
  // prompt worth keeping as a snippet.
  /\breply with (?:only|exactly|just)\b/i,
  /\bno (?:prose|preamble) (?:before|or)\b/i,
  /\bno markdown fence\b/i,
];

const FILLER_PREFIX =
  /^(?:ok(?:ay)?|also|and|now|then|so|well|yeah|yes|please|hey|btw|lets|let's|can (?:we|you)|could (?:we|you)|i want (?:to|you to)|we (?:should|need to))\b[\s,.:;-]*/i;

const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those it its is are was " +
    "were be been being do does did doing done to of in on at for with from by " +
    "as into over about all any some more most other our your my me i we you " +
    "they he she them us not no so up out if when while can could should would " +
    "will just now also please make made get got go going too very lets let's")
    .split(" "),
);

/** Machine-written prompts never belong in a snippet library. */
export function isMachinePrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return MACHINE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Lowercase, punctuation-free, whitespace-collapsed form used for matching. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ") // fenced code is never the reusable part
    .replace(/[`*_~#>]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalized form with a leading filler word ("also", "ok", "can we") removed. */
export function stripFiller(text: string): string {
  let out = text.trim();
  // Two passes: "ok also commit and push" sheds both.
  for (let i = 0; i < 2; i += 1) out = out.replace(FILLER_PREFIX, "").trim();
  return out || text.trim();
}

const trigramCache = new Map<string, Set<string>>();

function trigrams(value: string): Set<string> {
  const cached = trigramCache.get(value);
  if (cached) return cached;
  const padded = `  ${value} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3));
  // Bounded so a long session cannot grow this without limit.
  if (trigramCache.size > 20_000) trigramCache.clear();
  trigramCache.set(value, out);
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** Edit distance, capped: words this different are not typos of each other. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Two words count as the same when one is a plausible typo of the other.
 * Edit distance rather than trigrams: transpositions ("conitnue") are the
 * common typo and trigram overlap barely notices them.
 */
const WORD_MATCH_THRESHOLD = 0.75;

function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // Below 4 chars every edit is a large fraction of the word — "do"/"go".
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 3) return false;
  const longest = Math.max(a.length, b.length);
  return 1 - editDistance(a, b) / longest >= WORD_MATCH_THRESHOLD;
}

/**
 * A prompt in the form the comparisons want, computed once. Clustering is
 * O(n²) over the corpus, so re-deriving word sets per comparison is the
 * difference between a panel that opens instantly and one that hangs.
 */
export interface Prepared {
  normalized: string;
  words: string[];
  wordSet: Set<string>;
  /** Words bucketed by first two chars — typos rarely change the head. */
  heads: Map<string, string[]>;
  tri: Set<string>;
}

/** Long prompts have plenty of exact words; fuzzy matching them is wasted work. */
const FUZZY_WORD_CAP = 80;

export function prepare(normalized: string): Prepared {
  const words = [...new Set(normalized.split(" ").filter(Boolean))];
  const heads = new Map<string, string[]>();
  for (const word of words) {
    const head = word.slice(0, 2);
    const bucket = heads.get(head);
    if (bucket) bucket.push(word);
    else heads.set(head, [word]);
  }
  return { normalized, words, wordSet: new Set(words), heads, tri: trigrams(normalized) };
}

function exactJaccard(a: Prepared, b: Prepared): number {
  let shared = 0;
  for (const word of a.words) if (b.wordSet.has(word)) shared += 1;
  return shared / (a.words.length + b.words.length - shared);
}

/**
 * Like {@link exactJaccard}, but a word also counts as shared when an
 * unclaimed word in `b` is a plausible typo of it. That is what makes "fic
 * all issues and do all followupd" cluster with the spelled-right version.
 */
function fuzzyJaccard(a: Prepared, b: Prepared): number {
  const claimed = new Set<string>();
  let shared = 0;
  for (const word of a.words) {
    if (b.wordSet.has(word) && !claimed.has(word)) {
      claimed.add(word);
      shared += 1;
      continue;
    }
    const candidates = b.heads.get(word.slice(0, 2));
    const hit = candidates?.find(
      (other) => !claimed.has(other) && wordsMatch(word, other),
    );
    if (hit !== undefined) {
      claimed.add(hit);
      shared += 1;
    }
  }
  return shared / (a.words.length + b.words.length - shared);
}

function blend(words: number, chars: number, minWords: number): number {
  // Few-word prompts carry too little word signal to weight it heavily.
  const wordWeight = minWords < 3 ? 0.25 : 0.6;
  return wordWeight * words + (1 - wordWeight) * chars;
}

/**
 * Blended similarity of two prepared prompts. The word half catches reordered
 * clauses and misspellings; the trigram half carries short prompts, where a
 * single typo ("conitnue") leaves no word to match on.
 *
 * The exact-word pass runs first and the fuzzy pass only when the pair lands
 * just under the bar — typo tolerance is what makes this expensive, and pairs
 * that are nowhere close never need it.
 */
export function similarityOf(a: Prepared, b: Prepared, threshold = CLUSTER_THRESHOLD): number {
  if (a.normalized === b.normalized) return 1;
  // Cheap bail: lengths this far apart cannot clear any useful threshold.
  const shorter = Math.min(a.normalized.length, b.normalized.length);
  const longer = Math.max(a.normalized.length, b.normalized.length);
  if (longer === 0 || shorter / longer < 0.45) return 0;
  if (a.words.length === 0 || b.words.length === 0) return 0;

  const minWords = Math.min(a.words.length, b.words.length);
  const chars = dice(a.tri, b.tri);
  const exact = blend(exactJaccard(a, b), chars, minWords);
  if (exact >= threshold) return exact;
  if (exact < threshold - 0.3) return exact;
  if (minWords > FUZZY_WORD_CAP) return exact;
  return Math.max(exact, blend(fuzzyJaccard(a, b), chars, minWords));
}

/** Convenience wrapper for callers holding raw normalized strings. */
export function similarity(a: string, b: string): number {
  return similarityOf(prepare(a), prepare(b));
}

/** FNV-1a — stable across processes, unlike a hashed object identity. */
export function suggestionKey(body: string): string {
  let hash = 0x811c9dc5;
  const basis = normalize(body);
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `sg_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function tokenName(after: string | undefined, before: string | undefined): string {
  for (const candidate of [after, before]) {
    const word = (candidate ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (word && word.length > 2 && !STOPWORDS.has(word)) return word;
  }
  return "value";
}

/**
 * Where a cluster's phrasings differ in exactly one contiguous run, turn that
 * run into a {{fill-in}} — "Audit the existing Handoff plugin…" and "Audit the
 * existing Flair plugin…" become "Audit the existing {{plugin}} plugin…".
 * Returns the input body unchanged when the variants do not line up.
 */
export function templateFromVariants(variants: string[]): {
  body: string;
  tokens: string[];
} {
  const distinct = [...new Set(variants.map((v) => v.trim()))].filter(Boolean);
  const base = distinct[0] ?? "";
  if (distinct.length < 2) return { body: base, tokens: [] };

  const split = distinct.map((variant) => variant.split(/\s+/));
  const shortest = Math.min(...split.map((words) => words.length));

  let prefix = 0;
  while (
    prefix < shortest &&
    split.every((words) => words[prefix].toLowerCase() === split[0][prefix].toLowerCase())
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    prefix + suffix < shortest &&
    split.every((words) => {
      const word = words[words.length - 1 - suffix];
      return word.toLowerCase() === split[0][split[0].length - 1 - suffix].toLowerCase();
    })
  ) {
    suffix += 1;
  }

  // Every variant must actually have something in the slot, and the shared
  // wording has to dominate — otherwise this is two prompts, not a template.
  const middles = split.map((words) => words.slice(prefix, words.length - suffix));
  if (middles.some((middle) => middle.length === 0)) return { body: base, tokens: [] };
  if (prefix + suffix < Math.ceil(shortest * 0.6)) return { body: base, tokens: [] };

  // A fill-in is a value, not a clause. When the part that varies runs on for
  // half the prompt these are two different prompts that happen to share an
  // opening, and templating them produces a {{value}} nobody can fill in.
  if (middles.some((middle) => middle.length > MAX_SLOT_WORDS)) {
    return { body: base, tokens: [] };
  }

  // A slot whose contents are just misspellings of each other ("oplan"/"plan")
  // is one phrasing typed twice, not a variable.
  const slots = middles.map((middle) => normalize(middle.join(" ")));
  if (slots.every((slot) => wordsMatch(slot, slots[0]))) {
    return { body: base, tokens: [] };
  }

  const words = split[0];
  const name = tokenName(words[words.length - suffix], words[prefix - 1]);
  const body = [
    ...words.slice(0, prefix),
    `{{${name}}}`,
    ...words.slice(words.length - suffix),
  ].join(" ");
  return { body, tokens: [name] };
}

/** A short, human title for a proposed snippet. */
export function titleFor(body: string): string {
  const cleaned = stripFiller(body.replace(/\{\{([^}]*)\}\}/g, "$1"))
    .replace(/\s+/g, " ")
    .trim();
  const clause = cleaned.split(/(?<=[.!?])\s|\s[—–-]\s|\n/)[0] ?? cleaned;
  let title = clause.trim();
  if (title.length > 60) {
    const cut = title.slice(0, 60);
    const boundary = cut.lastIndexOf(" ");
    const kept = (boundary > 24 ? cut.slice(0, boundary) : cut).trim();
    title = `${kept.replace(/[,;:.–—-]+$/, "")}…`;
  }
  title = title.replace(/[,;:]$/, "");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * How often each word appears across the whole history. Used as a spell check
 * without a dictionary: the user writes "issues" far more often than "issus",
 * so the corpus itself says which spelling of a cluster is the intended one.
 */
export function wordFrequency(prompts: HistoryPrompt[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const prompt of prompts) {
    for (const word of normalize(prompt.text).split(" ")) {
      if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Order a cluster's phrasings best-first: the one typed most often, and among
 * equals the one spelled the way the user usually spells those words. The
 * winner seeds the snippet body.
 */
export function rankVariants(
  variants: { text: string; count: number }[],
  frequency: Map<string, number>,
): string[] {
  function spelling(text: string): number {
    const words = [...new Set(normalize(text).split(" "))].filter(Boolean);
    if (words.length === 0) return 0;
    const total = words.reduce(
      (sum, word) => sum + Math.log1p(frequency.get(word) ?? 0),
      0,
    );
    return total / words.length;
  }
  return [...variants]
    .sort(
      (a, b) =>
        b.count - a.count ||
        spelling(b.text) - spelling(a.text) ||
        b.text.length - a.text.length,
    )
    .map((variant) => variant.text);
}

/** The most distinctive words in a cluster, for snippet search. */
export function keywordsFor(bodies: string[], max = 5): string {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    for (const word of new Set(normalize(body).split(" "))) {
      if (word.length < 4 || STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([word]) => word)
    .join(" ");
}

export interface ClusterMember {
  text: string;
  normalized: string;
  createdAt: number;
}

export interface Cluster {
  centroid: string;
  members: ClusterMember[];
}

interface OpenCluster {
  centroid: Prepared;
  members: ClusterMember[];
  /** Creation order, so ties resolve exactly as a full linear scan would. */
  seq: number;
  length: number;
}

/** Index of the first entry whose length is >= `length`. */
function lowerBound(entries: OpenCluster[], length: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (entries[mid]!.length < length) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Greedy single-pass clustering. Exactly-repeated prompts collapse first, so
 * the similarity pass only ever sees distinct phrasings — on a real history
 * the 97 identical "continue"s cost one comparison, not 97.
 *
 * Candidates come from a length-sorted window rather than the whole cluster
 * list: `similarityOf` already scores anything outside that window as 0, so
 * the window is a pure speedup, not a different answer. The pass yields to the
 * event loop periodically because it runs inside the bb server process.
 */
export async function clusterPrompts(
  prompts: HistoryPrompt[],
  threshold = CLUSTER_THRESHOLD,
  options: { yieldEvery?: number } = {},
): Promise<Cluster[]> {
  const yieldEvery = options.yieldEvery ?? YIELD_EVERY;
  const groups = new Map<string, ClusterMember[]>();
  const order: string[] = [];
  for (const prompt of prompts) {
    const normalized = stripFiller(normalize(prompt.text));
    if (!normalized) continue;
    const member = { text: prompt.text.trim(), normalized, createdAt: prompt.createdAt };
    const existing = groups.get(normalized);
    if (existing) existing.push(member);
    else {
      groups.set(normalized, [member]);
      order.push(normalized);
    }
  }

  const clusters: OpenCluster[] = [];
  const byLength: OpenCluster[] = [];
  let processed = 0;
  for (const normalized of order) {
    if (yieldEvery > 0 && processed > 0 && processed % yieldEvery === 0)
      await yieldToLoop();
    processed += 1;

    const members = groups.get(normalized) ?? [];
    const prepared = prepare(normalized);
    const length = normalized.length;

    // Only centroids whose length is within the ratio floor can score above 0.
    const from = lowerBound(byLength, Math.ceil(length * LENGTH_RATIO_FLOOR));
    const until = lowerBound(byLength, Math.floor(length / LENGTH_RATIO_FLOOR) + 1);
    const window = byLength.slice(from, until);
    window.sort((a, b) => a.seq - b.seq);

    let best: OpenCluster | null = null;
    let bestScore = threshold;
    for (const cluster of window) {
      const score = similarityOf(prepared, cluster.centroid, threshold);
      if (score >= bestScore) {
        best = cluster;
        bestScore = score;
      }
    }
    if (best) {
      best.members.push(...members);
      continue;
    }
    const cluster: OpenCluster = {
      centroid: prepared,
      members,
      seq: clusters.length,
      length,
    };
    clusters.push(cluster);
    byLength.splice(lowerBound(byLength, length), 0, cluster);
  }
  return clusters.map((cluster) => ({
    centroid: cluster.centroid.normalized,
    members: cluster.members,
  }));
}

export interface FilterOptions {
  /** Bodies of snippets that already exist — suppresses duplicates. */
  existingBodies?: string[];
  /** Suggestion keys the user dismissed. */
  dismissedKeys?: string[];
  limit?: number;
}

/**
 * Drop proposals the user already has or already said no to. Split out from
 * {@link suggestSnippets} so a cached proposal list can be re-filtered without
 * re-clustering the whole history every time a snippet is saved.
 */
export function filterSuggestions(
  suggestions: Suggestion[],
  options: FilterOptions = {},
): Suggestion[] {
  const { existingBodies = [], dismissedKeys = [], limit = 8 } = options;
  const dismissed = new Set(dismissedKeys);
  const existing = existingBodies.map((body) => prepare(stripFiller(normalize(body))));

  return suggestions
    .filter((suggestion) => {
      if (dismissed.has(suggestion.key)) return false;
      const body = prepare(stripFiller(normalize(suggestion.body)));
      return !existing.some(
        (other) => similarityOf(body, other, COVERED_THRESHOLD) >= COVERED_THRESHOLD,
      );
    })
    .slice(0, limit);
}

export interface SuggestOptions extends FilterOptions {
  history: HistoryPrompt[];
  minCount?: number;
  /** Newest-first cap on the prompts actually clustered. */
  maxCandidates?: number;
  yieldEvery?: number;
}

export interface SuggestResult {
  suggestions: Suggestion[];
  /** History entries handed in. */
  analyzed: number;
  /** How many survived the filters and were actually clustered. */
  considered: number;
  /** Candidates dropped by the newest-first cap; 0 when nothing was cut. */
  dropped: number;
}

/** Full pipeline: history in, ranked snippet proposals out. */
export async function suggestSnippets(
  options: SuggestOptions,
): Promise<SuggestResult> {
  const {
    history,
    existingBodies = [],
    dismissedKeys = [],
    limit = 8,
    minCount = MIN_COUNT,
    maxCandidates = MAX_CANDIDATES,
    yieldEvery = YIELD_EVERY,
  } = options;

  const eligible = history.filter((prompt) => {
    const text = prompt.text.trim();
    return (
      text.length >= MIN_BODY_CHARS &&
      text.length <= MAX_BODY_CHARS &&
      !isMachinePrompt(text)
    );
  });
  // Newest first, then cut: a proposal mined from prompts the user stopped
  // typing a year ago is not a proposal worth making.
  const ordered = [...eligible].sort((a, b) => b.createdAt - a.createdAt);
  const candidates = ordered.slice(0, maxCandidates);
  const dropped = ordered.length - candidates.length;

  // Frequencies come from the unfiltered history — the more evidence about how
  // this user spells things, the better — but sampled, because normalizing six
  // figures of prompts is itself a visible block.
  const frequency = wordFrequency(
    history.length > MAX_FREQUENCY_SAMPLE
      ? history.slice(-MAX_FREQUENCY_SAMPLE)
      : history,
  );

  const suggestions: Suggestion[] = [];
  for (const cluster of await clusterPrompts(candidates, CLUSTER_THRESHOLD, {
    yieldEvery,
  })) {
    if (cluster.members.length < minCount) continue;

    const byText = new Map<string, number>();
    for (const member of cluster.members) {
      byText.set(member.text, (byText.get(member.text) ?? 0) + 1);
    }
    const variants = rankVariants(
      [...byText.entries()].map(([text, count]) => ({ text, count })),
      frequency,
    );

    const { body, tokens } = templateFromVariants(variants);
    if (body.length < MIN_BODY_CHARS) continue;

    suggestions.push({
      key: suggestionKey(body),
      title: titleFor(body),
      body,
      keywords: keywordsFor(variants),
      count: cluster.members.length,
      lastSeenAt: Math.max(...cluster.members.map((member) => member.createdAt)),
      variants,
      variantCount: variants.length,
      tokens,
    });
  }

  suggestions.sort(
    (a, b) =>
      b.count - a.count ||
      b.tokens.length - a.tokens.length ||
      b.lastSeenAt - a.lastSeenAt,
  );
  return {
    suggestions: filterSuggestions(suggestions, {
      existingBodies,
      dismissedKeys,
      limit,
    }),
    analyzed: history.length,
    considered: candidates.length,
    dropped,
  };
}
