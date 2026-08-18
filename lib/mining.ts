// Snippet-suggestion mining: the cache in front of it, and the single
// background pass that refreshes it.
//
// Mining is slow — not because clustering is, but because the history behind
// it is hundreds of SDK round-trips. RPC handlers run on the server's shared
// event loop, so none of them may ever await it: reads answer from cache and
// kick at most one background mine, which announces itself over realtime.

import {
  filterSuggestions,
  suggestSnippets,
  type HistoryPrompt,
  type Suggestion,
} from "./suggest";

export const SUGGESTION_CACHE_KEY = "suggestions:v2";
/** Proposals kept in the cache so filters can be re-applied without a recompute. */
export const SUGGESTION_CACHE_SIZE = 40;
/** How long a mined proposal list stays fresh. A full mine is minutes of I/O. */
export const SUGGESTION_TTL_MS = 6 * 3_600_000;

export interface SuggestionCache {
  computedAt: number;
  analyzed: number;
  considered: number;
  dropped: number;
  suggestions: Suggestion[];
}

export interface MinerDeps {
  loadHistory(): Promise<HistoryPrompt[]>;
  /** Bodies of snippets that already exist — read fresh on every filter pass. */
  existingBodies(): string[];
  dismissedKeys(): string[];
  dismissedCount(): number;
  kvGet(key: string): Promise<SuggestionCache | undefined>;
  kvSet(key: string, value: SuggestionCache): Promise<void>;
  log: { info(message: string): void; warn(message: string): void };
  /** Announce a finished mine so open panels pick it up. */
  onMined(): void;
  isDisposed(): boolean;
  /** Settings gate: false means never scan history at all. */
  isEnabled(): boolean;
  now?: () => number;
}

export interface SuggestionRead {
  suggestions: Suggestion[];
  analyzed: number;
  considered: number;
  dropped: number;
  computedAt: number;
  dismissedCount: number;
  computing: boolean;
  enabled: boolean;
  lastError: string | null;
}

export function createMiner(deps: MinerDeps) {
  const now = deps.now ?? Date.now;
  let cached: SuggestionCache | null = null;
  let mining: Promise<void> | null = null;
  let lastError: string | null = null;

  async function readCache(): Promise<SuggestionCache | null> {
    if (cached) return cached;
    try {
      cached = (await deps.kvGet(SUGGESTION_CACHE_KEY)) ?? null;
    } catch {
      // An unreadable cache just means "mine again" — never a failed panel load.
    }
    return cached;
  }

  /** Kick a mine unless one is already running. Never throws, never awaits. */
  function start(): Promise<void> {
    if (mining) return mining;
    if (deps.isDisposed() || !deps.isEnabled()) return Promise.resolve();
    const run = (async () => {
      const startedAt = now();
      const history = await deps.loadHistory();
      if (deps.isDisposed()) return;
      const result = await suggestSnippets({
        history,
        limit: SUGGESTION_CACHE_SIZE,
      });
      if (deps.isDisposed()) return;
      const fresh: SuggestionCache = {
        computedAt: now(),
        analyzed: result.analyzed,
        considered: result.considered,
        dropped: result.dropped,
        // kv rows cap at 256KB; the variants are only ever shown as a count and
        // a preview, so they are the cheap thing to trim.
        suggestions: result.suggestions.map((suggestion) => ({
          ...suggestion,
          variants: suggestion.variants
            .slice(0, 3)
            .map((variant) => variant.slice(0, 300)),
        })),
      };
      // The in-memory copy is authoritative for this process: if the kv write
      // fails, a stale-forever cache would re-mine on every single read.
      cached = fresh;
      lastError = null;
      try {
        await deps.kvSet(SUGGESTION_CACHE_KEY, fresh);
      } catch (error) {
        if (!deps.isDisposed())
          deps.log.warn(`suggestion cache write failed: ${message(error)}`);
      }
      if (deps.isDisposed()) return;
      deps.log.info(
        `mined ${fresh.suggestions.length} snippet suggestions from ` +
          `${result.considered} of ${result.analyzed} prompts` +
          `${result.dropped > 0 ? ` (${result.dropped} older candidates skipped)` : ""}` +
          ` in ${Math.round((now() - startedAt) / 100) / 10}s`,
      );
      deps.onMined();
    })()
      .catch((error) => {
        lastError = message(error);
        if (!deps.isDisposed())
          deps.log.warn(`snippet mining failed: ${lastError}`);
      })
      .finally(() => {
        if (mining === run) mining = null;
      });
    mining = run;
    return run;
  }

  /**
   * The cached proposals plus the filters (already saved, already dismissed),
   * re-applied on every read so the list reacts instantly to what the user
   * does with it. A stale or missing cache triggers a background mine; the
   * caller gets whatever exists right now.
   */
  async function read(refresh: boolean): Promise<SuggestionRead> {
    const enabled = deps.isEnabled();
    const cache = enabled ? await readCache() : null;
    const stale =
      cache === null || now() - cache.computedAt >= SUGGESTION_TTL_MS;
    if (enabled && (refresh || stale)) void start();
    return {
      suggestions: filterSuggestions(cache?.suggestions ?? [], {
        existingBodies: deps.existingBodies(),
        dismissedKeys: deps.dismissedKeys(),
      }),
      analyzed: cache?.analyzed ?? 0,
      considered: cache?.considered ?? 0,
      dropped: cache?.dropped ?? 0,
      computedAt: cache?.computedAt ?? 0,
      dismissedCount: deps.dismissedCount(),
      computing: mining !== null,
      enabled,
      lastError,
    };
  }

  return {
    read,
    start,
    /** The in-flight mine, for callers that want to wait briefly on it. */
    inFlight: () => mining,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type Miner = ReturnType<typeof createMiner>;
