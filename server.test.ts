// End-to-end tests for the wiring: rpc handlers, the idle timer, thread
// lifecycle, the native-queue bridge, the CLI, and the agent tools.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./server";
import { createFakeHost, type FakeHarness } from "./lib/test-host";

function idleEvent(harness: FakeHarness, threadId: string) {
  return { thread: harness.addThread({ id: threadId }), lastAssistantText: null };
}

async function setup(options?: Parameters<typeof createFakeHost>[0]) {
  const { bb, harness } = createFakeHost(options);
  harness.addThread({ id: "t1", projectId: "prj_1", title: "Fix the flaky test" });
  harness.addThread({ id: "t2", projectId: "prj_1", title: "Other thread" });
  harness.addProject({ id: "prj_1", name: "Acme Storefront" });
  plugin(bb);
  // The factory reads settings asynchronously; let that land before asserting
  // on anything that depends on them.
  await Promise.resolve();
  return harness;
}

describe("queueing", () => {
  it("queues, lists, and separates the three scopes", async () => {
    const harness = await setup();
    await harness.callRpc("addPrompt", {
      text: "thread one",
      scope: "thread",
      threadId: "t1",
      projectId: null,
      autoSend: false,
    });
    await harness.callRpc("addPrompt", {
      text: "project one",
      scope: "project",
      threadId: null,
      projectId: "prj_1",
      autoSend: false,
    });
    await harness.callRpc("addPrompt", {
      text: "global one",
      scope: "global",
      threadId: null,
      projectId: null,
      autoSend: false,
    });

    const listed = await harness.callRpc<{
      threadPrompts: { text: string; projectId: string | null }[];
      projectPrompts: { text: string }[];
      globalPrompts: { text: string }[];
    }>("listPrompts", { threadId: "t1", projectId: "prj_1" });
    expect(listed.threadPrompts.map((p) => p.text)).toEqual(["thread one"]);
    expect(listed.projectPrompts.map((p) => p.text)).toEqual(["project one"]);
    expect(listed.globalPrompts.map((p) => p.text)).toEqual(["global one"]);
    // A thread prompt learns its project, so it can be promoted later.
    expect(listed.threadPrompts[0]!.projectId).toBe("prj_1");
  });

  it("refuses a scope move with no owner instead of orphaning the prompt", async () => {
    const harness = await setup();
    const { prompt } = await harness.callRpc<{ prompt: { id: string } }>("addPrompt", {
      text: "keep me",
      scope: "global",
      threadId: null,
      projectId: null,
      autoSend: false,
    });
    const moved = await harness.callRpc<{ prompt: unknown; error: string | null }>(
      "movePrompt",
      { id: prompt.id, scope: "thread", threadId: null, projectId: null },
    );
    expect(moved.prompt).toBeNull();
    expect(moved.error).toMatch(/needs a threadId/i);
    // Still exactly where it was — not lost to a list nobody queries.
    const listed = await harness.callRpc<{ globalPrompts: unknown[] }>("listPrompts", {
      threadId: null,
      projectId: null,
    });
    expect(listed.globalPrompts).toHaveLength(1);
  });

  it("moves a prompt to a named thread and back to the project", async () => {
    const harness = await setup();
    const { prompt } = await harness.callRpc<{ prompt: { id: string } }>("addPrompt", {
      text: "move me",
      scope: "global",
      threadId: null,
      projectId: null,
      autoSend: false,
    });
    await harness.callRpc("movePrompt", {
      id: prompt.id,
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
    });
    let listed = await harness.callRpc<{ threadPrompts: unknown[] }>("listPrompts", {
      threadId: "t1",
      projectId: "prj_1",
    });
    expect(listed.threadPrompts).toHaveLength(1);

    await harness.callRpc("movePrompt", {
      id: prompt.id,
      scope: "project",
      threadId: null,
      projectId: "prj_1",
    });
    listed = await harness.callRpc<{ threadPrompts: unknown[]; projectPrompts: unknown[] }>(
      "listPrompts",
      { threadId: "t1", projectId: "prj_1" },
    );
    expect(listed.threadPrompts).toHaveLength(0);
    expect(listed.projectPrompts).toHaveLength(1);
  });

  it("reports a rejected reorder rather than silently ignoring it", async () => {
    const harness = await setup();
    const { prompt } = await harness.callRpc<{ prompt: { id: string } }>("addPrompt", {
      text: "a",
      scope: "global",
      threadId: null,
      projectId: null,
      autoSend: false,
    });
    const result = await harness.callRpc<{ reordered: boolean }>("reorderPrompts", {
      scope: "global",
      threadId: null,
      projectId: null,
      ids: [prompt.id, "pq_missing"],
    });
    expect(result.reordered).toBe(false);
  });
});

describe("auto-send on idle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function armed(harness: FakeHarness, threadId = "t1") {
    await harness.callRpc("addPrompt", {
      text: "follow-up",
      scope: "thread",
      threadId,
      projectId: "prj_1",
      autoSend: true,
    });
  }

  it("waits out the idle delay, then sends", async () => {
    const harness = await setup({ settings: { autoSendDelaySeconds: "20" } });
    await armed(harness);
    harness.emit("thread.idle", idleEvent(harness, "t1"));
    expect(harness.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.sends).toEqual([{ threadId: "t1", text: "follow-up" }]);
  });

  /**
   * The regression this whole design exists for: `thread.idle` also fires when
   * the agent stops to ask a question. If the user answers inside the grace
   * window, nothing may fire — not even by a timer that was installed after
   * the cancel arrived.
   */
  it("never fires after the thread goes active again", async () => {
    const harness = await setup({ settings: { autoSendDelaySeconds: "20" } });
    await armed(harness);
    harness.emit("thread.idle", idleEvent(harness, "t1"));
    // The user answers immediately.
    harness.emit("thread.active", { thread: harness.addThread({ id: "t1" }) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.sends).toHaveLength(0);
  });

  it("drains one prompt per idle, in order", async () => {
    const harness = await setup({ settings: { autoSendDelaySeconds: "0" } });
    await harness.callRpc("addPrompt", {
      text: "first",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: true,
    });
    await harness.callRpc("addPrompt", {
      text: "second",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: true,
    });
    harness.emit("thread.idle", idleEvent(harness, "t1"));
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.sends.map((send) => send.text)).toEqual(["first"]);
    harness.emit("thread.idle", idleEvent(harness, "t1"));
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.sends.map((send) => send.text)).toEqual(["first", "second"]);
  });

  it("holds everything while the thread is paused", async () => {
    const harness = await setup({ settings: { autoSendDelaySeconds: "0" } });
    await armed(harness);
    await harness.callRpc("setPaused", { threadId: "t1", paused: true });
    harness.emit("thread.idle", idleEvent(harness, "t1"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.sends).toHaveLength(0);
  });

  it("re-queues a failed send with the error attached", async () => {
    const harness = await setup({
      settings: { autoSendDelaySeconds: "0" },
      sendError: "provider exploded",
    });
    await armed(harness);
    harness.emit("thread.idle", idleEvent(harness, "t1"));
    await vi.advanceTimersByTimeAsync(10);
    const listed = await harness.callRpc<{
      threadPrompts: { lastError: string | null; status: string }[];
    }>("listPrompts", { threadId: "t1", projectId: "prj_1" });
    expect(listed.threadPrompts[0]!.status).toBe("queued");
    expect(listed.threadPrompts[0]!.lastError).toBe("provider exploded");
    expect(
      harness.signals.some((signal) => signal.kind === "send-failed"),
    ).toBe(true);
  });

  it("stays quiet for threads it holds nothing for", async () => {
    const harness = await setup();
    harness.signals.length = 0;
    harness.emit("thread.idle", idleEvent(harness, "t2"));
    harness.emit("thread.active", { thread: harness.addThread({ id: "t2" }) });
    // A publish per lifecycle transition is what made every open panel refetch
    // continuously while any agent was working.
    expect(harness.signals).toHaveLength(0);
  });

  it("picks up a changed idle delay without a reload", async () => {
    const harness = await setup({ settings: { autoSendDelaySeconds: "600" } });
    await harness.setSettings({ autoSendDelaySeconds: "1" });
    await armed(harness);
    harness.emit("thread.idle", idleEvent(harness, "t1"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.sends).toHaveLength(1);
  });

  it("clears pending timers on dispose", async () => {
    const harness = await setup({ settings: { autoSendDelaySeconds: "5" } });
    await armed(harness);
    harness.emit("thread.idle", idleEvent(harness, "t1"));
    harness.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sends).toHaveLength(0);
  });
});

describe("thread lifecycle", () => {
  it("keeps an archived thread's prompts on its project", async () => {
    const harness = await setup();
    await harness.callRpc("addPrompt", {
      text: "still worth asking",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: true,
    });
    harness.emit("thread.archived", {
      thread: harness.addThread({ id: "t1", title: "Fix the flaky test" }),
    });
    await Promise.resolve();
    const listed = await harness.callRpc<{
      threadPrompts: unknown[];
      projectPrompts: { text: string; originThreadTitle: string | null; autoSend: boolean }[];
    }>("listPrompts", { threadId: "t1", projectId: "prj_1" });
    expect(listed.threadPrompts).toHaveLength(0);
    expect(listed.projectPrompts.map((p) => p.text)).toEqual(["still worth asking"]);
    expect(listed.projectPrompts[0]!.originThreadTitle).toBe("Fix the flaky test");
    // Nothing to idle on any more, so the arming is dropped with the move.
    expect(listed.projectPrompts[0]!.autoSend).toBe(false);
  });

  it("keeps a deleted thread's prompts too — the writing was the user's", async () => {
    const harness = await setup();
    await harness.callRpc("addPrompt", {
      text: "survivor",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: false,
    });
    harness.emit("thread.deleted", { thread: harness.addThread({ id: "t1" }) });
    await Promise.resolve();
    const listed = await harness.callRpc<{ projectPrompts: { text: string }[] }>(
      "listPrompts",
      { threadId: null, projectId: "prj_1" },
    );
    expect(listed.projectPrompts.map((p) => p.text)).toEqual(["survivor"]);
  });

  it("deletes instead when the user asked for that", async () => {
    const harness = await setup({ settings: { threadEnd: "delete" } });
    await harness.callRpc("addPrompt", {
      text: "disposable",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: false,
    });
    harness.emit("thread.deleted", { thread: harness.addThread({ id: "t1" }) });
    await Promise.resolve();
    const listed = await harness.callRpc<{
      threadPrompts: unknown[];
      projectPrompts: unknown[];
    }>("listPrompts", { threadId: "t1", projectId: "prj_1" });
    expect(listed.threadPrompts).toHaveLength(0);
    expect(listed.projectPrompts).toHaveLength(0);
  });

  /**
   * A failed thread never goes idle, so an armed queue would wait behind a
   * banner promising it will send "when the agent finishes".
   */
  it("pauses a thread whose run failed, keeping the prompts", async () => {
    const harness = await setup();
    await harness.callRpc("addPrompt", {
      text: "next",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: true,
    });
    harness.emit("thread.failed", {
      thread: harness.addThread({ id: "t1" }),
      error: "provider died",
    });
    const listed = await harness.callRpc<{ paused: boolean; threadPrompts: unknown[] }>(
      "listPrompts",
      { threadId: "t1", projectId: "prj_1" },
    );
    expect(listed.paused).toBe(true);
    expect(listed.threadPrompts).toHaveLength(1);
  });
});

describe("scheduled sends", () => {
  it("fires due prompts from the cron sweep", async () => {
    const harness = await setup();
    await harness.callRpc("addPrompt", {
      text: "at nine",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: false,
      sendAt: Date.now() - 1_000,
    });
    await harness.runSchedule("scheduled-send");
    expect(harness.sends).toEqual([{ threadId: "t1", text: "at nine" }]);
  });

  it("leaves prompts whose time has not come", async () => {
    const harness = await setup();
    await harness.callRpc("addPrompt", {
      text: "later",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: false,
      sendAt: Date.now() + 3_600_000,
    });
    await harness.runSchedule("scheduled-send");
    expect(harness.sends).toHaveLength(0);
  });
});

describe("queueing for a time", () => {
  it("queues a prompt that sends later, without sending it now", async () => {
    const harness = await setup();
    const sendAt = Date.now() + 3_600_000;
    const { prompt } = await harness.callRpc<{
      prompt: { sendAt: number | null; status: string };
    }>("addPrompt", {
      text: "after lunch",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: false,
      sendAt,
    });
    expect(prompt.sendAt).toBe(sendAt);
    expect(prompt.status).toBe("queued");
    expect(harness.sends).toHaveLength(0);
    // Not due yet.
    await harness.runSchedule("scheduled-send");
    expect(harness.sends).toHaveLength(0);
  });

  it("queues a snippet into another thread at a chosen time", async () => {
    const harness = await setup();
    const sendAt = Date.now() - 1;
    await harness.callRpc("addPrompt", {
      text: "run the release checklist",
      scope: "thread",
      threadId: "t2",
      projectId: null,
      autoSend: false,
      sendAt,
    });
    await harness.runSchedule("scheduled-send");
    expect(harness.sends).toEqual([
      { threadId: "t2", text: "run the release checklist" },
    ]);
  });

  it("refuses to schedule a queue with no thread to send to", async () => {
    const harness = await setup();
    for (const scope of ["project", "global"] as const) {
      const result = await harness.callRpc<{
        prompt: unknown;
        error: string | null;
      }>("addPrompt", {
        text: "no thread here",
        scope,
        threadId: null,
        projectId: scope === "project" ? "prj_1" : null,
        autoSend: false,
        sendAt: Date.now() + 60_000,
      });
      expect(result.prompt).toBeNull();
      expect(result.error).toMatch(/thread-scoped/i);
    }
  });
});

describe("bb's native queue", () => {
  it("pushes a stashed prompt into bb's queue", async () => {
    const harness = await setup();
    const { prompt } = await harness.callRpc<{ prompt: { id: string } }>("addPrompt", {
      text: "push me",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: false,
    });
    const result = await harness.callRpc<{ pushed: boolean }>("pushToNativeQueue", {
      id: prompt.id,
      threadId: "t1",
    });
    expect(result.pushed).toBe(true);
    expect(harness.queued.get("t1")).toHaveLength(1);
    const listed = await harness.callRpc<{ threadPrompts: unknown[] }>("listPrompts", {
      threadId: "t1",
      projectId: "prj_1",
    });
    expect(listed.threadPrompts).toHaveLength(0);
  });

  it("stashes everything bb has queued, in one call", async () => {
    const harness = await setup();
    harness.queued.set("t1", [
      { id: "qm_1", content: [{ type: "text", text: "one" }], updatedAt: 1 },
      { id: "qm_2", content: [{ type: "text", text: "two" }], updatedAt: 2 },
      { id: "qm_3", content: [{ type: "image" }], updatedAt: 3 },
    ]);
    const result = await harness.callRpc<{ stashed: number; skipped: number }>(
      "stashAllNative",
      { threadId: "t1" },
    );
    expect(result).toMatchObject({ stashed: 2, skipped: 1 });
    expect(harness.queued.get("t1")).toHaveLength(1);
    const listed = await harness.callRpc<{ threadPrompts: { text: string }[] }>(
      "listPrompts",
      { threadId: "t1", projectId: "prj_1" },
    );
    expect(listed.threadPrompts.map((p) => p.text)).toEqual(["one", "two"]);
  });

  it("reports a native-queue read failure instead of showing an empty list", async () => {
    const harness = await setup();
    const result = await harness.callRpc<{ error: string | null }>("listNativeQueue", {
      threadId: "missing",
    });
    expect(result.error).toBeTruthy();
  });
});

describe("snippets", () => {
  it("queues a whole group in writing order", async () => {
    const harness = await setup();
    for (const title of ["First", "Second"]) {
      await harness.callRpc("addSnippet", {
        title,
        body: `${title} step`,
        groupName: "Ship",
      });
    }
    const result = await harness.callRpc<{ queued: number }>("queueSnippetGroup", {
      groupName: "Ship",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
    });
    expect(result.queued).toBe(2);
    const listed = await harness.callRpc<{ threadPrompts: { text: string }[] }>(
      "listPrompts",
      { threadId: "t1", projectId: "prj_1" },
    );
    expect(listed.threadPrompts.map((p) => p.text)).toEqual([
      "First step",
      "Second step",
    ]);
  });

  it("remembers fill-in values between uses", async () => {
    const harness = await setup();
    await harness.callRpc("rememberFillValues", { values: { branch: "main" } });
    const result = await harness.callRpc<{ values: Record<string, string> }>(
      "fillValues",
      { tokens: ["branch", "other"] },
    );
    expect(result.values).toEqual({ branch: "main" });
  });
});

describe("the agent's view", () => {
  it("tells the agent what is waiting, and nothing when nothing is", async () => {
    const harness = await setup();
    expect(harness.instructionsFor({ threadId: "t1", projectId: "prj_1" })).toBeNull();
    await harness.callRpc("addPrompt", {
      text: "after this",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: false,
    });
    await harness.callRpc("addPrompt", {
      text: "project level",
      scope: "project",
      threadId: null,
      projectId: "prj_1",
      autoSend: false,
    });
    const text = harness.instructionsFor({ threadId: "t1", projectId: "prj_1" });
    expect(text).toContain("1 follow-up prompt");
    expect(text).toContain("queued for this project");
  });

  it("registers the tools an agent needs to stash and reuse prompts", async () => {
    const harness = await setup();
    expect(harness.toolNames().sort()).toEqual([
      "prompts_list",
      "prompts_queue",
      "prompts_snippet_get",
      "prompts_snippet_save",
      "prompts_snippets",
    ]);
  });

  it("queues from a tool call without sending anything", async () => {
    const harness = await setup();
    const result = await harness.callTool(
      "prompts_queue",
      { text: "run the migration afterwards" },
      { threadId: "t1", projectId: "prj_1" },
    );
    expect(String(result)).toContain("Queued");
    expect(harness.sends).toHaveLength(0);
    const listed = await harness.callRpc<{ threadPrompts: { text: string }[] }>(
      "listPrompts",
      { threadId: "t1", projectId: "prj_1" },
    );
    expect(listed.threadPrompts.map((p) => p.text)).toEqual([
      "run the migration afterwards",
    ]);
  });

  it("refuses a thread-scoped tool call with no thread", async () => {
    const harness = await setup();
    const result = (await harness.callTool("prompts_queue", {
      text: "nowhere to put this",
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("fills a snippet's tokens for the agent", async () => {
    const harness = await setup();
    await harness.callRpc("addSnippet", {
      title: "Deploy",
      body: "Deploy {{service}} to {{env=staging}}",
    });
    const { snippets } = await harness.callRpc<{ snippets: { id: string }[] }>(
      "listSnippets",
      { query: "Deploy", projectId: null },
    );
    const filled = await harness.callTool("prompts_snippet_get", {
      id: snippets[0]!.id,
      fill: { service: "api" },
    });
    expect(String(filled)).toContain("Deploy api to staging");
  });

  it("resolves an @snippet mention to the snippet's body", async () => {
    const harness = await setup();
    await harness.callRpc("addSnippet", { title: "Review", body: "Review the diff" });
    const provider = harness.mention("snippet");
    const found = provider.search({ query: "rev", projectId: "prj_1" }) as {
      id: string;
      title: string;
    }[];
    expect(found[0]!.title).toBe("Review");
    const resolved = provider.resolve(found[0]!.id) as { context: string };
    expect(resolved.context).toContain("Review the diff");
    expect(() => provider.resolve("snip_missing")).toThrow();
  });
});

describe("the cli", () => {
  it("queues, lists, and deletes", async () => {
    const harness = await setup();
    const added = await harness.runCli(["add", "commit", "and", "push"], {
      threadId: "t1",
      projectId: "prj_1",
    });
    expect(added.exitCode).toBe(0);
    const id = /Queued (pq_[a-z0-9]+)/.exec(added.stdout ?? "")?.[1];
    expect(id).toBeTruthy();

    const listed = await harness.runCli(["list"], { threadId: "t1", projectId: "prj_1" });
    expect(listed.stdout).toContain("commit and push");

    const json = await harness.runCli(["list", "--json"], { threadId: "t1" });
    expect(JSON.parse(json.stdout ?? "{}").thread).toHaveLength(1);

    const removed = await harness.runCli(["rm", id!], { threadId: "t1" });
    expect(removed.exitCode).toBe(0);
  });

  it("keeps text after a `--` separator, dashes and all", async () => {
    const harness = await setup();
    const added = await harness.runCli(["add", "--", "-g", "is", "part", "of", "the", "text"], {
      threadId: "t1",
    });
    const listed = await harness.runCli(["list", "--json"], { threadId: "t1" });
    expect(added.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout ?? "{}").thread[0].text).toBe(
      "-g is part of the text",
    );
  });

  it("routes -p and -g to the project and global queues", async () => {
    const harness = await setup();
    await harness.runCli(["add", "-p", "project scoped"], {
      threadId: "t1",
      projectId: "prj_1",
    });
    await harness.runCli(["add", "-g", "global scoped"], { threadId: "t1" });
    const listed = JSON.parse(
      (await harness.runCli(["list", "--json"], { threadId: "t1", projectId: "prj_1" }))
        .stdout ?? "{}",
    );
    expect(listed.project).toHaveLength(1);
    expect(listed.global).toHaveLength(1);
  });

  it("promotes a thread queue to the project", async () => {
    const harness = await setup();
    await harness.runCli(["add", "keep me"], { threadId: "t1", projectId: "prj_1" });
    const promoted = await harness.runCli(["promote"], {
      threadId: "t1",
      projectId: "prj_1",
    });
    expect(promoted.stdout).toContain("Kept 1 prompt(s)");
    const listed = JSON.parse(
      (await harness.runCli(["list", "--json"], { threadId: "t1", projectId: "prj_1" }))
        .stdout ?? "{}",
    );
    expect(listed.thread).toHaveLength(0);
    expect(listed.project).toHaveLength(1);
  });

  it("fills a snippet's tokens from --set", async () => {
    const harness = await setup();
    const saved = await harness.runCli(
      ["snip-add", "--title", "Deploy", "Deploy {{service}} to {{env=staging}}"],
      {},
    );
    const id = /snippet (snip_[a-z0-9]+)/.exec(saved.stdout ?? "")?.[1];
    const shown = await harness.runCli(["snip-show", id!, "--set", "service=api"], {});
    expect(shown.stdout).toBe("Deploy api to staging");
  });

  it("names every command when it does not recognise one", async () => {
    const harness = await setup();
    const result = await harness.runCli(["nope"], {});
    expect(result.exitCode).toBe(1);
    for (const command of ["push", "stash", "promote", "group", "suggest"])
      expect(result.stderr).toContain(command);
  });

  it("refuses a thread command outside a thread", async () => {
    const harness = await setup();
    expect((await harness.runCli(["stash"], {})).exitCode).toBe(1);
    expect((await harness.runCli(["run"], {})).exitCode).toBe(1);
    expect((await harness.runCli(["add", "text"], {})).stderr).toContain("-p");
  });
});

describe("suggestions", () => {
  it("answers from cache and mines in the background", async () => {
    const harness = await setup();
    harness.setPromptHistory("thread:t1", [
      { createdAt: 1, input: [{ type: "text", text: "audit the plugin and polish it up" }] },
      { createdAt: 2, input: [{ type: "text", text: "audit the plugin and polish it up" }] },
    ]);
    const first = await harness.callRpc<{ suggestions: unknown[]; computing: boolean }>(
      "suggestSnippets",
      { refresh: true },
    );
    // The read never waits on the mine.
    expect(first.suggestions).toHaveLength(0);
    expect(first.computing).toBe(true);
    // Let the background pass finish and announce itself.
    await vi.waitFor(async () => {
      const next = await harness.callRpc<{ suggestions: { body: string }[] }>(
        "suggestSnippets",
        { refresh: false },
      );
      expect(next.suggestions).toHaveLength(1);
      expect(next.suggestions[0]!.body).toContain("audit the plugin");
    });
    expect(
      harness.signals.some((signal) => signal.topic === "suggestions"),
    ).toBe(true);
  });

  it("does not touch prompt history when mining is switched off", async () => {
    const harness = await setup({ settings: { mineHistory: "off" } });
    harness.setPromptHistory("thread:t1", [
      { createdAt: 1, input: [{ type: "text", text: "audit the plugin and polish it up" }] },
    ]);
    const result = await harness.callRpc<{ enabled: boolean; computing: boolean }>(
      "suggestSnippets",
      { refresh: true },
    );
    expect(result.enabled).toBe(false);
    expect(result.computing).toBe(false);
  });
});

describe("the manager overview", () => {
  it("groups by project and thread, and says what it did not expand", async () => {
    const harness = await setup();
    await harness.callRpc("addPrompt", {
      text: "thread work",
      scope: "thread",
      threadId: "t1",
      projectId: "prj_1",
      autoSend: false,
    });
    await harness.callRpc("addPrompt", {
      text: "project work",
      scope: "project",
      threadId: null,
      projectId: "prj_1",
      autoSend: false,
    });
    const overview = await harness.callRpc<{
      projects: { projectId: string; name: string; prompts: unknown[] }[];
      threads: { threadId: string; title: string; prompts: unknown[] }[];
      hiddenThreads: number;
      hiddenProjects: number;
    }>("overview", null);
    expect(overview.projects[0]).toMatchObject({ projectId: "prj_1", name: "Acme Storefront" });
    expect(overview.projects[0]!.prompts).toHaveLength(1);
    expect(overview.threads[0]).toMatchObject({
      threadId: "t1",
      title: "Fix the flaky test",
    });
    expect(overview.hiddenThreads).toBe(0);
    expect(overview.hiddenProjects).toBe(0);
  });
});
