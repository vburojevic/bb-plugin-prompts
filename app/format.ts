// Types and formatting with no React in them.
//
// Split out from shared.ts so the pure parts — the pill's state machine, the
// queue-target policy — can be unit tested without a composer to mount them in.
import type { PromptDto, SnippetDto, SuggestionDto } from "../lib/contract";

export type { PromptDto, SnippetDto, SuggestionDto };
export type Scope = PromptDto["scope"];

export interface NativeQueueItem {
  id: string;
  text: string;
  updatedAt: number;
}

/** What a queue view is looking at. Every write needs all three. */
export interface QueueScope {
  threadId: string | null;
  projectId: string | null;
}

export interface Signal {
  topic: "queue" | "snippets" | "suggestions" | "native";
  kind: "changed" | "send-failed" | "auto-sent" | "promoted";
  threadId: string | null;
  projectId: string | null;
  message?: string;
}

export type LoadState = "loading" | "ready" | "error";

export interface QueueData {
  threadPrompts: PromptDto[];
  projectPrompts: PromptDto[];
  globalPrompts: PromptDto[];
  recentlyUsed: PromptDto[];
  paused: boolean;
}

export const EMPTY_QUEUE: QueueData = {
  threadPrompts: [],
  projectPrompts: [],
  globalPrompts: [],
  recentlyUsed: [],
  paused: false,
};

export function previewText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 42 minutes" / "3 hours ago" — coarse on purpose. */
export function formatRelative(ms: number, now = Date.now()): string {
  const delta = ms - now;
  const seconds = Math.round(Math.abs(delta) / 1000);
  const [value, unit] =
    seconds < 60
      ? [seconds, "second"]
      : seconds < 3600
        ? [Math.round(seconds / 60), "minute"]
        : seconds < 86400
          ? [Math.round(seconds / 3600), "hour"]
          : [Math.round(seconds / 86400), "day"];
  const plural = value === 1 ? unit : `${unit}s`;
  return delta >= 0 ? `in ${value} ${plural}` : `${value} ${plural} ago`;
}

export function usedViaLabel(prompt: PromptDto): string {
  switch (prompt.usedVia) {
    case "auto-send":
      return "auto-sent";
    case "scheduled":
      return "scheduled send";
    case "cross-thread":
      return "sent to another thread";
    case "bb-queue":
      return "moved to bb's queue";
    case "tool":
      return "used by the agent";
    default:
      return "used";
  }
}

export const SCOPE_LABEL: Record<Scope, string> = {
  thread: "this thread",
  project: "this project",
  global: "everywhere",
};

