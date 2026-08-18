import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createStore, MIGRATIONS, type Db } from "./store";

function makeStore(nowRef?: { value: number }) {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = createStore(
    db as unknown as Db,
    nowRef ? () => nowRef.value : undefined,
  );
  return { db, store };
}

describe("queue", () => {
  it("adds thread, project, and global prompts with increasing positions", () => {
    const { store } = makeStore();
    const first = store.addPrompt({
      text: "a",
      scope: "thread",
      threadId: "t1",
      autoSend: false,
    });
    const second = store.addPrompt({
      text: "b",
      scope: "thread",
      threadId: "t1",
      autoSend: false,
    });
    const project = store.addPrompt({
      text: "p",
      scope: "project",
      projectId: "prj1",
      autoSend: true, // must be dropped: only threads have an idle event
    });
    const other = store.addPrompt({
      text: "c",
      scope: "global",
      autoSend: true, // same
    });
    expect(second.position).toBeGreaterThan(first.position);
    expect(project.autoSend).toBe(false);
    expect(other.autoSend).toBe(false);
    expect(
      store.listQueued({ scope: "thread", threadId: "t1" }).map((p) => p.text),
    ).toEqual(["a", "b"]);
    expect(store.listQueued({ scope: "project", projectId: "prj1" })).toHaveLength(1);
    expect(store.listQueued({ scope: "global" })).toHaveLength(1);
  });

  it("keeps a thread prompt's project so it can be promoted later", () => {
    const { store } = makeStore();
    const prompt = store.addPrompt({
      text: "a",
      scope: "thread",
      threadId: "t1",
      projectId: "prj1",
      autoSend: false,
    });
    expect(prompt.threadId).toBe("t1");
    expect(prompt.projectId).toBe("prj1");
  });

  it("rejects a scope with no owner, and scheduling anything but a thread", () => {
    const { store } = makeStore();
    expect(() =>
      store.addPrompt({ text: "x", scope: "thread", threadId: null, autoSend: false }),
    ).toThrow();
    expect(() =>
      store.addPrompt({ text: "x", scope: "project", projectId: null, autoSend: false }),
    ).toThrow();
    expect(() =>
      store.addPrompt({ text: "x", scope: "global", autoSend: false, sendAt: 123 }),
    ).toThrow();
  });

  it("claims atomically: the second claim loses", () => {
    const { store } = makeStore();
    const prompt = store.addPrompt({
      text: "once",
      scope: "thread",
      threadId: "t1",
      autoSend: true,
    });
    const won = store.claimPrompt(prompt.id, "auto-send");
    const lost = store.claimPrompt(prompt.id, "auto-send");
    expect(won?.status).toBe("used");
    expect(won?.usedVia).toBe("auto-send");
    expect(lost).toBeNull();
    expect(store.nextArmed("t1")).toBeNull();
  });

  it("requeues a failed send at the tail with the error recorded", () => {
    const { store } = makeStore();
    const first = store.addPrompt({
      text: "first",
      scope: "thread",
      threadId: "t1",
      autoSend: true,
    });
    store.addPrompt({
      text: "second",
      scope: "thread",
      threadId: "t1",
      autoSend: false,
    });
    store.claimPrompt(first.id, "auto-send");
    const requeued = store.requeuePrompt(first.id, "boom");
    expect(requeued?.status).toBe("queued");
    expect(requeued?.lastError).toBe("boom");
    // Tail position: after "second".
    expect(
      store.listQueued({ scope: "thread", threadId: "t1" }).map((p) => p.text),
    ).toEqual(["second", "first"]);
    // A clean claim clears the error.
    const reclaimed = store.claimPrompt(first.id, "inject");
    expect(reclaimed?.lastError).toBeNull();
  });

  it("reorders only with a complete id permutation", () => {
    const { store } = makeStore();
    const a = store.addPrompt({ text: "a", scope: "global", autoSend: false });
    const b = store.addPrompt({ text: "b", scope: "global", autoSend: false });
    const c = store.addPrompt({ text: "c", scope: "global", autoSend: false });
    expect(
      store.reorderPrompts({ scope: "global" }, [c.id, a.id, b.id]),
    ).toBe(true);
    expect(store.listQueued({ scope: "global" }).map((p) => p.text)).toEqual([
      "c",
      "a",
      "b",
    ]);
    // Partial or foreign lists are refused.
    expect(store.reorderPrompts({ scope: "global" }, [a.id, b.id])).toBe(false);
    expect(
      store.reorderPrompts({ scope: "global" }, [a.id, b.id, "pq_nope"]),
    ).toBe(false);
  });

  it("drains armed prompts in position order", () => {
    const { store } = makeStore();
    const a = store.addPrompt({ text: "a", scope: "thread", threadId: "t1", autoSend: true });
    const b = store.addPrompt({ text: "b", scope: "thread", threadId: "t1", autoSend: true });
    store.reorderPrompts({ scope: "thread", threadId: "t1" }, [b.id, a.id]);
    expect(store.nextArmed("t1")?.text).toBe("b");
    store.claimPrompt(b.id, "auto-send");
    expect(store.nextArmed("t1")?.text).toBe("a");
  });

  it("lists due scheduled prompts", () => {
    const nowRef = { value: 1_000 };
    const { store } = makeStore(nowRef);
    store.addPrompt({
      text: "later",
      scope: "thread",
      threadId: "t1",
      autoSend: false,
      sendAt: 5_000,
    });
    expect(store.listDue(4_999)).toHaveLength(0);
    expect(store.listDue(5_000)).toHaveLength(1);
  });

  it("prunes used prompts beyond the keep limit", () => {
    const nowRef = { value: 0 };
    const { store } = makeStore(nowRef);
    for (let i = 0; i < 5; i++) {
      nowRef.value = i;
      const prompt = store.addPrompt({
        text: `p${i}`,
        scope: "global",
        autoSend: false,
      });
      store.claimPrompt(prompt.id, "inject");
    }
    store.pruneUsed(2);
    expect(store.listRecentlyUsed(null, null, 10)).toHaveLength(2);
  });
});

describe("scope moves", () => {
  it("never produces a prompt no list can return", () => {
    const { store } = makeStore();
    const prompt = store.addPrompt({ text: "a", scope: "global", autoSend: false });
    // The shipped bug: "move to this thread" with no thread id wrote
    // scope='thread', thread_id=NULL — a row that matched no query.
    expect(() => store.movePrompt(prompt.id, { scope: "thread" })).toThrow();
    expect(() => store.movePrompt(prompt.id, { scope: "project" })).toThrow();
    expect(store.listQueued({ scope: "global" })).toHaveLength(1);
  });

  it("moves between all three scopes and clears thread-only state", () => {
    const { store } = makeStore();
    const prompt = store.addPrompt({
      text: "a",
      scope: "thread",
      threadId: "t1",
      projectId: "prj1",
      autoSend: true,
      sendAt: 5_000,
    });
    const project = store.movePrompt(prompt.id, {
      scope: "project",
      projectId: "prj1",
    });
    expect(project?.scope).toBe("project");
    expect(project?.threadId).toBeNull();
    // Arming and scheduling belong to threads; they cannot survive the move.
    expect(project?.autoSend).toBe(false);
    expect(project?.sendAt).toBeNull();
    expect(store.listQueued({ scope: "project", projectId: "prj1" })).toHaveLength(1);

    const back = store.movePrompt(prompt.id, { scope: "thread", threadId: "t2" });
    expect(back?.threadId).toBe("t2");
    expect(back?.projectId).toBe("prj1");
    expect(store.listQueued({ scope: "thread", threadId: "t2" })).toHaveLength(1);

    const global = store.movePrompt(prompt.id, { scope: "global" });
    expect(global?.scope).toBe("global");
    expect(global?.threadId).toBeNull();
    expect(store.listQueued({ scope: "global" })).toHaveLength(1);
  });

  it("repairs prompts a previous version orphaned", () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS.slice(0, 7)) db.exec(statement);
    // Exactly what the old updatePrompt wrote for "move to this thread".
    db.prepare(
      `INSERT INTO prompts (id, scope, thread_id, text, status, auto_send, position, created_at, updated_at)
       VALUES ('pq_orphan', 'thread', NULL, 'lost', 'queued', 0, 1, 1, 1)`,
    ).run();
    for (const statement of MIGRATIONS.slice(7)) db.exec(statement);
    const store = createStore(db as unknown as Db);
    expect(store.listQueued({ scope: "global" }).map((p) => p.text)).toEqual([
      "lost",
    ]);
  });
});

describe("thread lifecycle", () => {
  it("promotes a thread's prompts to its project, keeping order and origin", () => {
    const { store } = makeStore();
    store.addPrompt({
      text: "a",
      scope: "thread",
      threadId: "t1",
      projectId: "prj1",
      autoSend: true,
    });
    store.addPrompt({
      text: "b",
      scope: "thread",
      threadId: "t1",
      projectId: "prj1",
      autoSend: false,
    });
    const promoted = store.promoteThreadPrompts("t1", {
      projectId: "prj1",
      threadTitle: "Fix the flaky test",
    });
    expect(promoted).toHaveLength(2);
    const project = store.listQueued({ scope: "project", projectId: "prj1" });
    expect(project.map((p) => p.text)).toEqual(["a", "b"]);
    expect(project[0]!.originThreadTitle).toBe("Fix the flaky test");
    expect(project[0]!.autoSend).toBe(false);
    expect(store.listQueued({ scope: "thread", threadId: "t1" })).toHaveLength(0);
  });

  it("falls back to the global queue when the thread has no project", () => {
    const { store } = makeStore();
    store.addPrompt({ text: "a", scope: "thread", threadId: "t1", autoSend: false });
    const promoted = store.promoteThreadPrompts("t1");
    expect(promoted[0]!.scope).toBe("global");
    expect(store.listQueued({ scope: "global" })).toHaveLength(1);
  });

  it("deletes only the thread's own queued prompts", () => {
    const { store } = makeStore();
    store.addPrompt({ text: "a", scope: "thread", threadId: "t1", autoSend: false });
    store.addPrompt({ text: "b", scope: "global", autoSend: false });
    expect(store.deleteThreadPrompts("t1")).toBe(1);
    expect(store.listQueued({ scope: "global" })).toHaveLength(1);
  });

  it("tracks pause state per thread", () => {
    const { store } = makeStore();
    expect(store.isPaused("t1")).toBe(false);
    store.setPaused("t1", true);
    expect(store.isPaused("t1")).toBe(true);
    expect(store.pausedThreadIds()).toEqual(["t1"]);
    store.setPaused("t1", false);
    expect(store.isPaused("t1")).toBe(false);
    expect(store.pausedThreadIds()).toEqual([]);
  });

  it("counts and arms a thread's queue", () => {
    const { store } = makeStore();
    store.addPrompt({ text: "a", scope: "thread", threadId: "t1", autoSend: false });
    store.addPrompt({ text: "b", scope: "thread", threadId: "t1", autoSend: false });
    store.addPrompt({ text: "c", scope: "global", autoSend: false });
    expect(store.countQueued("t1")).toBe(2);
    expect(store.setArmedForThread("t1", true)).toBe(2);
    expect(store.setArmedForThread("t1", true)).toBe(0);
    expect(store.setArmedForThread("t1", false)).toBe(2);
  });
});

describe("snippets", () => {
  it("creates groups on demand and reuses them by name", () => {
    const { store } = makeStore();
    const a = store.addSnippet({ title: "A", body: "x", groupName: "Infra" });
    const b = store.addSnippet({ title: "B", body: "y", groupName: "Infra" });
    expect(a.groupId).toBe(b.groupId);
    expect(a.groupName).toBe("Infra");
  });

  it("searches title, keywords, body, and group name", () => {
    const { store } = makeStore();
    store.addSnippet({ title: "Deploy checklist", body: "steps", groupName: "Infra" });
    store.addSnippet({ title: "Review", body: "review this code", keywords: "quality" });
    expect(store.listSnippets("deploy").snippets).toHaveLength(1);
    expect(store.listSnippets("quality").snippets).toHaveLength(1);
    expect(store.listSnippets("infra").snippets).toHaveLength(1);
    expect(store.listSnippets("code").snippets).toHaveLength(1);
    expect(store.listSnippets("nothing").snippets).toHaveLength(0);
  });

  it("hides another project's snippets but always shows unscoped ones", () => {
    const { store } = makeStore();
    store.addSnippet({ title: "Shared", body: "x" });
    store.addSnippet({ title: "Mine", body: "y", projectId: "prj1" });
    store.addSnippet({ title: "Theirs", body: "z", projectId: "prj2" });
    expect(
      store
        .listSnippets("", { projectId: "prj1" })
        .snippets.map((s) => s.title)
        .sort(),
    ).toEqual(["Mine", "Shared"]);
    expect(store.listSnippets("").snippets).toHaveLength(3);
  });

  it("reports the true total when the page is capped", () => {
    const { store } = makeStore();
    for (let i = 0; i < 5; i++) store.addSnippet({ title: `S${i}`, body: "x" });
    const page = store.listSnippets("", { limit: 2 });
    expect(page.snippets).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it("returns a group in writing order, for queueing as a checklist", () => {
    const nowRef = { value: 0 };
    const { store } = makeStore(nowRef);
    nowRef.value = 3;
    store.addSnippet({ title: "Third", body: "c", groupName: "Ship" });
    nowRef.value = 1;
    store.addSnippet({ title: "First", body: "a", groupName: "Ship" });
    nowRef.value = 2;
    store.addSnippet({ title: "Second", body: "b", groupName: "Ship" });
    expect(store.listGroupSnippets("Ship").map((s) => s.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("prunes empty groups after delete and regroup", () => {
    const { db, store } = makeStore();
    const snippet = store.addSnippet({ title: "A", body: "x", groupName: "Solo" });
    store.updateSnippet({ id: snippet.id, groupName: "Other" });
    const groups = db
      .prepare(`SELECT name FROM snippet_groups`)
      .all() as { name: string }[];
    expect(groups.map((g) => g.name)).toEqual(["Other"]);
    store.deleteSnippet(snippet.id);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM snippet_groups`).get()).toEqual({ n: 0 });
  });

  it("bumps use counters", () => {
    const { store } = makeStore();
    const snippet = store.addSnippet({ title: "A", body: "x" });
    store.touchSnippet(snippet.id);
    store.touchSnippet(snippet.id);
    expect(store.getSnippet(snippet.id)?.useCount).toBe(2);
  });
});

describe("remembered fill-in values", () => {
  it("stores the last value per token, case-insensitively", () => {
    const { store } = makeStore();
    store.rememberFillValues({ Branch: "main", env: "  staging  ", blank: "  " });
    expect(store.fillValuesFor(["branch", "env", "blank", "unknown"])).toEqual({
      branch: "main",
      env: "staging",
    });
    store.rememberFillValues({ branch: "release" });
    expect(store.fillValuesFor(["BRANCH"])).toEqual({ BRANCH: "release" });
  });
});
