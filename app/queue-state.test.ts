import { describe, expect, it } from "vitest";
import { describeQueue } from "./queue-state";
import { EMPTY_QUEUE, type PromptDto, type QueueData } from "./format";

const NOW = 1_800_000_000_000;

function prompt(overrides: Partial<PromptDto> = {}): PromptDto {
  return {
    id: "pq_1",
    scope: "thread",
    threadId: "t1",
    projectId: "prj_1",
    originThreadTitle: null,
    text: "do the thing",
    status: "queued",
    autoSend: false,
    sendAt: null,
    position: 1,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    usedAt: null,
    usedVia: null,
    ...overrides,
  };
}

function queue(overrides: Partial<QueueData> = {}): QueueData {
  return { ...EMPTY_QUEUE, ...overrides };
}

describe("the composer pill's state", () => {
  it("says nothing when there is nothing", () => {
    const state = describeQueue(queue(), { now: NOW });
    expect(state).toMatchObject({
      kind: "idle",
      pending: 0,
      tone: "muted",
      icon: "Layers",
      pulse: false,
    });
  });

  it("counts every queue the composer can reach", () => {
    const state = describeQueue(
      queue({
        threadPrompts: [prompt()],
        projectPrompts: [prompt({ id: "pq_2", scope: "project" })],
        globalPrompts: [
          prompt({ id: "pq_3", scope: "global" }),
          prompt({ id: "pq_4", scope: "global" }),
        ],
      }),
      { now: NOW },
    );
    expect(state.pending).toBe(4);
    expect(state).toMatchObject({ kind: "queued", tone: "neutral", thread: 1 });
    expect(state.label).toContain("1 for this thread");
    expect(state.label).toContain("2 global");
    expect(state.label).toContain("nothing sends on its own");
  });

  it("goes accent once something will send by itself", () => {
    const armed = describeQueue(
      queue({ threadPrompts: [prompt({ autoSend: true })] }),
      { now: NOW },
    );
    expect(armed).toMatchObject({
      kind: "armed",
      tone: "accent",
      icon: "TimeSchedule",
    });
    expect(armed.label).toContain("when the agent finishes");

    const scheduled = describeQueue(
      queue({ threadPrompts: [prompt({ sendAt: NOW + 3_600_000 })] }),
      { now: NOW },
    );
    expect(scheduled).toMatchObject({
      kind: "scheduled",
      tone: "accent",
      icon: "Calendar",
      nextSendAt: NOW + 3_600_000,
    });
    expect(scheduled.label).toContain("in 1 hour");
  });

  it("reports the soonest scheduled send, not the first one queued", () => {
    const state = describeQueue(
      queue({
        threadPrompts: [
          prompt({ id: "pq_1", sendAt: NOW + 7_200_000 }),
          prompt({ id: "pq_2", sendAt: NOW + 900_000 }),
        ],
      }),
      { now: NOW },
    );
    expect(state.nextSendAt).toBe(NOW + 900_000);
    expect(state.scheduled).toBe(2);
  });

  /** Strict priority: failed > paused > armed > scheduled > queued > idle. */
  it("shows the most urgent state when several are true at once", () => {
    const base = {
      threadPrompts: [
        prompt({ id: "pq_1", autoSend: true }),
        prompt({ id: "pq_2", sendAt: NOW + 60_000 }),
      ],
    };
    expect(describeQueue(queue(base), { now: NOW }).kind).toBe("armed");
    expect(describeQueue(queue({ ...base, paused: true }), { now: NOW })).toMatchObject({
      kind: "paused",
      icon: "Pause",
      tone: "neutral",
    });
    const failed = describeQueue(
      queue({
        ...base,
        paused: true,
        globalPrompts: [prompt({ id: "pq_3", scope: "global", lastError: "boom" })],
      }),
      { now: NOW },
    );
    expect(failed).toMatchObject({ kind: "failed", tone: "danger", failed: 1 });
    expect(failed.label).toContain("still queued");
  });

  it("holds the pause state even with only scheduled prompts", () => {
    const state = describeQueue(
      queue({ threadPrompts: [prompt({ sendAt: NOW + 60_000 })], paused: true }),
      { now: NOW },
    );
    expect(state.kind).toBe("paused");
  });

  /**
   * The pulse means "this fires while you watch". A scheduled send runs on the
   * clock regardless, so only an armed queue waiting on a live run pulses.
   */
  it("pulses only while armed prompts wait on a running agent", () => {
    const armed = queue({ threadPrompts: [prompt({ autoSend: true })] });
    expect(describeQueue(armed, { now: NOW, isRunning: true }).pulse).toBe(true);
    expect(describeQueue(armed, { now: NOW, isRunning: false }).pulse).toBe(false);
    expect(
      describeQueue(queue({ threadPrompts: [prompt({ sendAt: NOW + 60_000 })] }), {
        now: NOW,
        isRunning: true,
      }).pulse,
    ).toBe(false);
  });
});
