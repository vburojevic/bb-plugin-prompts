// Turning bb's prompt-history rows into minable prompts.

import type { HistoryPrompt } from "./suggest";

/**
 * Mentions that still make sense inside a reusable snippet. A `/command`
 * resolves the same way in any thread; a thread, file, or project mention is
 * a pointer into one moment and would arrive broken.
 */
const PORTABLE_MENTION_KINDS = new Set(["command"]);

export interface HistoryEntryLike {
  createdAt: number;
  input: {
    type: string;
    text?: string;
    visibility?: string;
    mentions?: { resource: { kind: string } }[];
  }[];
}

/** One bb prompt-history row -> zero or one minable prompt. */
export function toHistoryPrompt(entry: HistoryEntryLike): HistoryPrompt[] {
  const texts: string[] = [];
  for (const part of entry.input) {
    // Agent-only parts are context another plugin injected, not user input —
    // and their presence means the whole entry was assembled, not typed.
    if (part.visibility === "agent-only") return [];
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const unportable = (part.mentions ?? []).some(
      (mention) => !PORTABLE_MENTION_KINDS.has(mention.resource.kind),
    );
    if (unportable) return [];
    texts.push(part.text);
  }
  const text = texts.join("\n").trim();
  return text ? [{ text, createdAt: entry.createdAt }] : [];
}
