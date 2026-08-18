// What the composer pill is trying to say.
//
// The queue has five states worth a glance, and they are strictly ordered: a
// failed send outranks a hold, a hold outranks anything armed, and anything
// armed outranks a queue that is only sitting there. Kept pure so the ordering
// and the wording are testable without mounting a composer.
import {
  formatRelative,
  formatWhen,
  type PromptDto,
  type QueueData,
} from "./format";

export type QueueStateKind =
  | "idle"
  | "queued"
  | "scheduled"
  | "armed"
  | "paused"
  | "failed";

export type PillTone = "muted" | "neutral" | "accent" | "danger";

export interface QueueState {
  kind: QueueStateKind;
  /** Badge number: everything reachable from this composer. */
  pending: number;
  thread: number;
  project: number;
  global: number;
  armed: number;
  scheduled: number;
  failed: number;
  /** Soonest scheduled send, if any. */
  nextSendAt: number | null;
  icon: "Layers" | "TimeSchedule" | "Calendar" | "Pause" | "AlertCircle";
  tone: PillTone;
  /** Slow pulse: something will fire on its own while the agent works. */
  pulse: boolean;
  /** One line for the tooltip and the accessible name. */
  label: string;
}

function countScheduled(prompts: PromptDto[]): PromptDto[] {
  return prompts.filter((prompt) => prompt.sendAt !== null);
}

export function describeQueue(
  data: QueueData,
  options: { isRunning?: boolean; now?: number } = {},
): QueueState {
  const now = options.now ?? Date.now();
  const all = [
    ...data.threadPrompts,
    ...data.projectPrompts,
    ...data.globalPrompts,
  ];
  const thread = data.threadPrompts.length;
  const project = data.projectPrompts.length;
  const global = data.globalPrompts.length;
  const pending = all.length;
  const armed = data.threadPrompts.filter((prompt) => prompt.autoSend).length;
  const scheduledPrompts = countScheduled(data.threadPrompts);
  const failed = all.filter((prompt) => prompt.lastError !== null).length;
  const nextSendAt = scheduledPrompts.length
    ? Math.min(...scheduledPrompts.map((prompt) => prompt.sendAt!))
    : null;

  const kind: QueueStateKind =
    failed > 0
      ? "failed"
      : data.paused && (armed > 0 || scheduledPrompts.length > 0)
        ? "paused"
        : armed > 0
          ? "armed"
          : nextSendAt !== null
            ? "scheduled"
            : pending > 0
              ? "queued"
              : "idle";

  const icon =
    kind === "failed"
      ? "AlertCircle"
      : kind === "paused"
        ? "Pause"
        : kind === "armed"
          ? "TimeSchedule"
          : kind === "scheduled"
            ? "Calendar"
            : "Layers";

  const tone: PillTone =
    kind === "failed"
      ? "danger"
      : kind === "armed" || kind === "scheduled"
        ? "accent"
        : kind === "queued" || kind === "paused"
          ? "neutral"
          : "muted";

  return {
    kind,
    pending,
    thread,
    project,
    global,
    armed,
    scheduled: scheduledPrompts.length,
    failed,
    nextSendAt,
    icon,
    tone,
    // A scheduled send fires on the clock whether or not the agent is working;
    // an armed one is waiting for this run to end, which is what the pulse is
    // reporting.
    pulse: kind === "armed" && options.isRunning === true,
    label: describeLabel({ kind, thread, project, global, armed, failed, nextSendAt, now }),
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "2 for this thread · 1 global" — only the parts that exist. */
function whereLine(thread: number, project: number, global: number): string {
  const parts: string[] = [];
  if (thread > 0) parts.push(`${thread} for this thread`);
  if (project > 0) parts.push(`${project} for this project`);
  if (global > 0) parts.push(`${global} global`);
  return parts.join(" · ");
}

function describeLabel(input: {
  kind: QueueStateKind;
  thread: number;
  project: number;
  global: number;
  armed: number;
  failed: number;
  nextSendAt: number | null;
  now: number;
}): string {
  const { kind, thread, project, global, armed, failed, nextSendAt, now } = input;
  const where = whereLine(thread, project, global);
  switch (kind) {
    case "failed":
      return `Prompts — ${plural(failed, "send")} failed, still queued${where ? ` · ${where}` : ""}`;
    case "paused":
      return `Prompts — on hold, ${plural(armed, "prompt")} armed${where ? ` · ${where}` : ""}`;
    case "armed":
      return `Prompts — ${plural(armed, "prompt")} will send when the agent finishes${
        where ? ` · ${where}` : ""
      }`;
    case "scheduled":
      return `Prompts — next send ${
        nextSendAt === null ? "scheduled" : `${formatRelative(nextSendAt, now)} (${formatWhen(nextSendAt)})`
      }${where ? ` · ${where}` : ""}`;
    case "queued":
      return `Prompts — ${where}, nothing sends on its own`;
    default:
      return "Prompts — queue & snippets";
  }
}
