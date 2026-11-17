// @vitest-environment jsdom
// Across turns: the row must never offer one turn's picks for the next.
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";

// The thread's run state, driven from the test.
const run = { running: false, status: "idle" };
const listeners = new Set<() => void>();
let snapshot = { ...run };
const subscribe = (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener));
const read = () =>
  snapshot.running === run.running && snapshot.status === run.status ? snapshot : (snapshot = { ...run });
function setRun(next: Partial<typeof run>) {
  Object.assign(run, next);
  for (const listener of listeners) listener();
}

vi.mock("@get-bb/plugin-sdk/app", async (original) => {
  const actual = (await original()) as Record<string, (...args: never[]) => Record<string, unknown>>;
  return {
    ...actual,
    useComposer: () => ({ ...actual.useComposer!(), isRunning: useSyncExternalStore(subscribe, read).running }),
    experimental_useSidebarThreads: () => {
      const real = actual.experimental_useSidebarThreads!() as { threads: Record<string, unknown>[] };
      const state = useSyncExternalStore(subscribe, read);
      return { ...real, threads: real.threads.map((thread) => ({ ...thread, status: state.status })) };
    },
  };
});

import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { QuickReplies } from "./quick-replies";

afterEach(() => {
  cleanup();
  setRun({ running: false, status: "idle" });
});

// Every phrase here is invented demo text.
const OLD = [{ kind: "answer", label: "Old turn pick", text: "old turn pick text", why: "old", best: true }];
const NEW = [{ kind: "ai", label: "New turn pick", text: "new turn pick text", why: "new", best: true }];

function render(answer: () => Promise<unknown>) {
  return renderSlot(
    { component: QuickReplies },
    {},
    {
      settings: {
        quickReplies: true,
        quickRepliesAi: "on",
        quickReplyTap: "send",
        quickRepliesAfterStop: "Keep going | keep going",
        quickRepliesAfterDone: "",
        quickRepliesAnyTime: "Progress | progress?",
      },
      composer: { scope: { kind: "thread", threadId: "thr_demo" }, text: "", isRunning: false },
      sidebarThreads: {
        status: "ready",
        threads: [{ id: "thr_demo", projectId: "proj_demo", status: "idle", hasPendingInteraction: false } as never],
      },
      rpc: {
        quickReplies: () => ({ learned: [{ label: "Write the docs", text: "write the docs" }], snippets: [] }),
        aiQuickReplies: answer,
        quickReplyFeedback: () => ({ saved: true }),
        addPrompt: () => ({ prompt: null, error: null }),
      } as never,
      sdk: {
        subscribe: () => () => {},
        threads: {
          events: {
            list: async () => [
              { type: "turn/completed", data: { status: "completed" } },
              { type: "turn/started", data: {} },
            ],
          },
          retry: async () => ({}),
        },
      } as never,
    },
  );
}

const chipTexts = (slot: ReturnType<typeof renderSlot>) => {
  const toolbar = slot.queryByRole("toolbar");
  return toolbar ? within(toolbar).getAllByRole("button").map((button) => button.textContent) : [];
};

it("shows the next turn's picks, not the last turn's, while the pointer moves over the row", async () => {
  let answer: unknown = { status: "ready", turnKey: "msg_1", replies: OLD, error: null, model: "m" };
  const slot = render(async () => answer);
  await slot.findByText("Old turn pick");
  fireEvent.mouseMove(slot.container.querySelector("[data-quick-replies]")!);
  await act(async () => setRun({ running: true, status: "active" }));
  answer = { status: "ready", turnKey: "msg_2", replies: NEW, error: null, model: "m" };
  await act(async () => setRun({ running: false, status: "idle" }));
  expect(chipTexts(slot).join()).not.toContain("Old turn pick");
  expect(await slot.findByText("New turn pick", {}, { timeout: 2_000 })).toBeTruthy();
});

it("never shows the last turn's picks while the next turn's read is on its way", async () => {
  let answer: unknown = { status: "ready", turnKey: "msg_1", replies: OLD, error: null, model: "m" };
  let delay = 0;
  const slot = render(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return answer;
  });
  await slot.findByText("Old turn pick");
  await act(async () => setRun({ running: true, status: "active" }));
  // Out of the way while the agent works.
  expect(slot.container.querySelector("[data-quick-replies]")).toBeNull();
  delay = 300;
  answer = { status: "ready", turnKey: "msg_2", replies: NEW, error: null, model: "m" };
  await act(async () => setRun({ running: false, status: "idle" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(chipTexts(slot).join()).not.toContain("Old turn pick");
  // The row holds its place with nothing older in it; the loading line waits
  // for the server to say the model is at work, so a saved answer never
  // flashes it.
  expect(slot.container.querySelector("[data-quick-replies]")?.getAttribute("data-quick-replies")).toBe("loading");
  expect(slot.queryByRole("status")).toBeNull();
  expect(chipTexts(slot)).toEqual([]);
  expect(await slot.findByText("New turn pick")).toBeTruthy();
});
