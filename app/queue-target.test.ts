import { describe, expect, it } from "vitest";
import {
  canSchedule,
  defaultQueueTarget,
  queueTargets,
  targetInput,
  threadTarget,
} from "./queue-target";

describe("queue targets", () => {
  it("defaults to the thread when there is one", () => {
    const target = defaultQueueTarget("t1", "prj1");
    expect(target.scope).toBe("thread");
    expect(target.threadId).toBe("t1");
    // The snippets popover has no tab strip, and its writes used to fall
    // through to the global queue even from inside a thread.
    expect(queueTargets("t1", "prj1").map((entry) => entry.scope)).toEqual([
      "thread",
      "project",
      "global",
    ]);
  });

  it("falls back to the project, then to global", () => {
    expect(defaultQueueTarget(null, "prj1").scope).toBe("project");
    expect(queueTargets(null, "prj1").map((entry) => entry.scope)).toEqual([
      "project",
      "global",
    ]);
    expect(defaultQueueTarget(null, null).scope).toBe("global");
    expect(queueTargets(null, null).map((entry) => entry.scope)).toEqual([
      "global",
    ]);
  });

  it("maps a target onto the addPrompt shape, one owner at a time", () => {
    expect(targetInput(defaultQueueTarget("t1", "prj1"))).toEqual({
      scope: "thread",
      threadId: "t1",
      projectId: null,
    });
    expect(targetInput(queueTargets("t1", "prj1")[1]!)).toEqual({
      scope: "project",
      threadId: null,
      projectId: "prj1",
    });
    expect(targetInput(queueTargets("t1", "prj1")[2]!)).toEqual({
      scope: "global",
      threadId: null,
      projectId: null,
    });
  });

  it("only a thread can receive a scheduled send", () => {
    const [thread, project, global] = queueTargets("t1", "prj1");
    expect(canSchedule(thread!)).toBe(true);
    expect(canSchedule(project!)).toBe(false);
    expect(canSchedule(global!)).toBe(false);
    expect(canSchedule(threadTarget("t2", "Other thread"))).toBe(true);
  });

  it("names another thread by its title", () => {
    const target = threadTarget("t2", "Fix the flaky test");
    expect(targetInput(target)).toEqual({
      scope: "thread",
      threadId: "t2",
      projectId: null,
    });
    expect(target.phrase).toContain("Fix the flaky test");
  });
});
