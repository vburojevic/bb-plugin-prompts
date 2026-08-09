import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createStore, MIGRATIONS, type Db } from "./store";
import { extractTokens, fillTokens } from "./template";

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
  it("adds thread and global prompts with increasing positions", () => {
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
    const other = store.addPrompt({
      text: "c",
      scope: "global",
      threadId: null,
      autoSend: true, // must be dropped for global scope
    });
    expect(second.position).toBeGreaterThan(first.position);
    expect(other.autoSend).toBe(false);
    expect(store.listQueued("thread", "t1").map((p) => p.text)).toEqual([
      "a",
      "b",
    ]);
    expect(store.listQueued("global", null)).toHaveLength(1);
  });

  it("rejects thread scope without a threadId and scheduling global prompts", () => {
    const { store } = makeStore();
    expect(() =>
      store.addPrompt({ text: "x", scope: "thread", threadId: null, autoSend: false }),
    ).toThrow();
    expect(() =>
      store.addPrompt({
        text: "x",
        scope: "global",
        threadId: null,
        autoSend: false,
        sendAt: 123,
      }),
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
    expect(store.listQueued("thread", "t1").map((p) => p.text)).toEqual([
      "second",
      "first",
    ]);
    // A clean claim clears the error.
    const reclaimed = store.claimPrompt(first.id, "inject");
    expect(reclaimed?.lastError).toBeNull();
  });

  it("reorders only with a complete id permutation", () => {
    const { store } = makeStore();
    const a = store.addPrompt({ text: "a", scope: "global", threadId: null, autoSend: false });
    const b = store.addPrompt({ text: "b", scope: "global", threadId: null, autoSend: false });
    const c = store.addPrompt({ text: "c", scope: "global", threadId: null, autoSend: false });
    expect(store.reorderPrompts("global", null, [c.id, a.id, b.id])).toBe(true);
    expect(store.listQueued("global", null).map((p) => p.text)).toEqual([
      "c",
      "a",
      "b",
    ]);
    // Partial or foreign lists are refused.
    expect(store.reorderPrompts("global", null, [a.id, b.id])).toBe(false);
    expect(store.reorderPrompts("global", null, [a.id, b.id, "pq_nope"])).toBe(false);
  });

  it("drains armed prompts in position order", () => {
    const { store } = makeStore();
    const a = store.addPrompt({ text: "a", scope: "thread", threadId: "t1", autoSend: true });
    const b = store.addPrompt({ text: "b", scope: "thread", threadId: "t1", autoSend: true });
    store.reorderPrompts("thread", "t1", [b.id, a.id]);
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
        threadId: null,
        autoSend: false,
      });
      store.claimPrompt(prompt.id, "inject");
    }
    store.pruneUsed(2);
    expect(store.listRecentlyUsed(null, 10)).toHaveLength(2);
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
    expect(store.listSnippets("deploy")).toHaveLength(1);
    expect(store.listSnippets("quality")).toHaveLength(1);
    expect(store.listSnippets("infra")).toHaveLength(1);
    expect(store.listSnippets("code")).toHaveLength(1);
    expect(store.listSnippets("nothing")).toHaveLength(0);
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

describe("templates", () => {
  it("extracts unique tokens in order", () => {
    expect(
      extractTokens("Deploy {{service}} to {{env}} — again {{service}}"),
    ).toEqual(["service", "env"]);
    expect(extractTokens("no tokens")).toEqual([]);
    expect(extractTokens("{{ spaced token }}")).toEqual(["spaced token"]);
  });

  it("fills provided tokens and keeps missing ones literal", () => {
    expect(
      fillTokens("Deploy {{service}} to {{env}}", { service: "api" }),
    ).toBe("Deploy api to {{env}}");
    expect(
      fillTokens("{{a}}/{{a}}", { a: "x" }),
    ).toBe("x/x");
  });
});
