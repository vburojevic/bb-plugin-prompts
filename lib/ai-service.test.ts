import { describe, expect, it, vi } from "vitest";
import { createAiReplies, type AiServiceDeps, type ModelRequest } from "./ai-service";
import type { Transcript } from "./ai-replies";

// Every phrase here is invented demo text.

const ANSWER = JSON.stringify({
  replies: [
    { kind: "answer", label: "Open the PR", text: "open the PR now", why: "Answers the question", best: true },
    { kind: "ai", label: "Show the diff", text: "show me the diff", why: "Not shown yet" },
  ],
});

function transcript(turnKey: string | null): Transcript {
  return {
    turnKey,
    messages: [
      { role: "user", text: "fix the import" },
      { role: "agent", text: "Fixed. Should I open the PR now?" },
    ],
  };
}

function setup(overrides: Partial<AiServiceDeps> = {}) {
  let turn: string | null = "msg_1";
  const kv = new Map<string, unknown>();
  const published: string[] = [];
  const requests: ModelRequest[] = [];
  let answer: () => Promise<string> = async () => ANSWER;
  const deps: AiServiceDeps = {
    enabled: () => true,
    transcript: async () => transcript(turn),
    thread: async (id) => ({
      id,
      providerId: "claude-code",
      projectId: "proj_demo",
      environmentId: "env_demo",
      title: "Import breaks on dates",
    }),
    habits: async () => [{ text: "commit and push", count: 12 }],
    snippets: () => [],
    feedback: () => new Map(),
    avoid: () => [],
    catalog: async () => [{ model: "claude-opus-5-5" }, { model: "claude-haiku-5-5" }],
    overrides: () => new Map(),
    run: async (request) => {
      requests.push(request);
      return answer();
    },
    kvGet: async (key) => kv.get(key),
    kvSet: async (key, value) => {
      kv.set(key, value);
    },
    publish: (threadId) => published.push(threadId),
    log: { info: () => {}, warn: () => {} },
    isDisposed: () => false,
    ...overrides,
  };
  const service = createAiReplies(deps);
  return {
    service,
    kv,
    published,
    requests,
    setTurn: (key: string | null) => {
      turn = key;
    },
    setAnswer: (next: () => Promise<string>) => {
      answer = next;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createAiReplies", () => {
  it("answers pending at once, then announces the replies", async () => {
    const { service, published, requests } = setup();
    const first = await service.read("thr_demo", { outcome: "finished", refresh: false });
    expect(first).toMatchObject({ status: "pending", turnKey: "msg_1" });
    await flush();
    expect(published).toEqual(["thr_demo"]);
    const second = await service.read("thr_demo", { outcome: "finished", refresh: false });
    expect(second.status).toBe("ready");
    expect(second.replies.map((reply) => reply.label)).toEqual(["Open the PR", "Show the diff"]);
    expect(second.model).toBe("claude-haiku-5-5");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ providerId: "claude-code", model: "claude-haiku-5-5" });
  });

  it("asks once per turn, again on a new turn, and again on regenerate", async () => {
    const { service, requests, setTurn } = setup();
    await service.read("thr_demo", { outcome: "finished", refresh: false });
    await flush();
    await service.read("thr_demo", { outcome: "finished", refresh: false });
    await service.read("thr_demo", { outcome: "finished", refresh: false });
    expect(requests).toHaveLength(1);
    setTurn("msg_2");
    await service.read("thr_demo", { outcome: "finished", refresh: false });
    await flush();
    expect(requests).toHaveLength(2);
    await service.read("thr_demo", { outcome: "finished", refresh: true });
    await flush();
    expect(requests).toHaveLength(3);
  });

  it("starts one generation when two reads of a new turn overlap", async () => {
    const { service, requests } = setup();
    const [a, b] = await Promise.all([
      service.read("thr_demo", { outcome: "finished", refresh: false }),
      service.read("thr_demo", { outcome: "finished", refresh: false }),
    ]);
    await flush();
    expect([a.status, b.status]).toEqual(["pending", "pending"]);
    expect(requests).toHaveLength(1);
  });

  it("does not start a second generation while one runs", async () => {
    const { service, requests, setAnswer } = setup();
    let release: (value: string) => void = () => {};
    setAnswer(() => new Promise((resolve) => (release = resolve)));
    await service.read("thr_demo", { outcome: "finished", refresh: false });
    await service.read("thr_demo", { outcome: "finished", refresh: true });
    await flush();
    expect(requests).toHaveLength(1);
    release(ANSWER);
  });

  it("survives a reload through the kv cache", async () => {
    const first = setup();
    await first.service.read("thr_demo", { outcome: "finished", refresh: false });
    await flush();
    const second = setup({ kvGet: async (key) => first.kv.get(key) });
    const read = await second.service.read("thr_demo", { outcome: "finished", refresh: false });
    expect(read.status).toBe("ready");
    expect(second.requests).toHaveLength(0);
  });

  it("reports a failure and keeps it until asked again", async () => {
    const { service, requests, setAnswer, published } = setup();
    setAnswer(async () => "no json here");
    await service.read("thr_demo", { outcome: "finished", refresh: false });
    await flush();
    expect(published).toEqual(["thr_demo"]);
    const failed = await service.read("thr_demo", { outcome: "finished", refresh: false });
    expect(failed).toMatchObject({ status: "error", error: "The model answered without usable replies" });
    expect(requests).toHaveLength(1);
  });

  it("gives up on a model that does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      const { service, setAnswer } = setup({ timeoutMs: 1_000 });
      setAnswer(() => new Promise(() => {}));
      await service.read("thr_demo", { outcome: "finished", refresh: false });
      await vi.advanceTimersByTimeAsync(1_100);
      const read = await service.read("thr_demo", { outcome: "finished", refresh: false });
      expect(read).toMatchObject({ status: "error", error: "The model took too long to answer" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks nothing when switched off or when there is no reply to follow up", async () => {
    const off = setup({ enabled: () => false });
    expect((await off.service.read("thr_demo", { outcome: "finished", refresh: false })).status).toBe("off");
    const empty = setup();
    empty.setTurn(null);
    expect((await empty.service.read("thr_demo", { outcome: "finished", refresh: false })).status).toBe("empty");
    expect(off.requests).toHaveLength(0);
    expect(empty.requests).toHaveLength(0);
  });

  it("drops a stale generation's answer when a newer turn replaced it", async () => {
    const { service, setAnswer, setTurn } = setup();
    let releaseOld: (value: string) => void = () => {};
    setAnswer(() => new Promise((resolve) => (releaseOld = resolve)));
    await service.read("thr_demo", { outcome: "finished", refresh: false });
    setAnswer(async () => ANSWER);
    setTurn("msg_2");
    await service.read("thr_demo", { outcome: "finished", refresh: false });
    await flush();
    releaseOld(JSON.stringify({ replies: [{ label: "Old", text: "old reply", best: true }] }));
    await flush();
    const read = await service.read("thr_demo", { outcome: "finished", refresh: false });
    expect(read.turnKey).toBe("msg_2");
    expect(read.replies[0]?.label).toBe("Open the PR");
  });
});
