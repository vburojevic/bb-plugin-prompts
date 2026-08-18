// Where a queue write lands.
//
// The default has to be the most specific queue the surface actually sits in —
// a snippet added from inside a thread belongs to that thread, not to a global
// junk drawer — and the caller must always be able to say otherwise.
import type { Scope } from "./format";

export interface QueueTarget {
  scope: Scope;
  threadId: string | null;
  projectId: string | null;
  /** Menu label. */
  label: string;
  /** "queued for this thread" — reads correctly inside a sentence. */
  phrase: string;
}

export const GLOBAL_TARGET: QueueTarget = {
  scope: "global",
  threadId: null,
  projectId: null,
  label: "Global queue",
  phrase: "the global queue",
};

/**
 * The queues this surface can reach, most specific first. The first entry is
 * the default, so the order here is the whole policy.
 */
export function queueTargets(
  threadId: string | null,
  projectId: string | null,
): QueueTarget[] {
  const targets: QueueTarget[] = [];
  if (threadId !== null)
    targets.push({
      scope: "thread",
      threadId,
      projectId,
      label: "This thread",
      phrase: "this thread",
    });
  if (projectId !== null)
    targets.push({
      scope: "project",
      threadId: null,
      projectId,
      label: "This project",
      phrase: "this project",
    });
  targets.push(GLOBAL_TARGET);
  return targets;
}

export function defaultQueueTarget(
  threadId: string | null,
  projectId: string | null,
): QueueTarget {
  return queueTargets(threadId, projectId)[0]!;
}

/** Another thread, picked from the thread list. */
export function threadTarget(id: string, title: string): QueueTarget {
  return {
    scope: "thread",
    threadId: id,
    projectId: null,
    label: title,
    phrase: `“${title}”`,
  };
}

/** Only a thread has somewhere for a scheduled send to arrive. */
export function canSchedule(target: QueueTarget): boolean {
  return target.scope === "thread" && target.threadId !== null;
}

/** The `addPrompt` shape for this target. */
export function targetInput(target: QueueTarget): {
  scope: Scope;
  threadId: string | null;
  projectId: string | null;
} {
  return {
    scope: target.scope,
    threadId: target.scope === "thread" ? target.threadId : null,
    projectId: target.scope === "project" ? target.projectId : null,
  };
}
