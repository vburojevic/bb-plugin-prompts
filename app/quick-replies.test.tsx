// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { QuickReplies } from "./quick-replies";

// Every phrase here is invented demo text.
const THREAD = "thr_demo";
const PROJECT = "proj_demo";

type Outcome = "completed" | "failed" | "interrupted";

function events(outcome: Outcome) {
  return [
    { type: "turn/completed", data: { status: outcome } },
    { type: "turn/started", data: {} },
  ];
}

const AI_REPLIES = [
  {
    kind: "answer",
    label: "Fix the parser first",
    text: "fix the date parser first, then rerun the import tests",
    why: "Answers the agent's question",
    best: true,
  },
  {
    kind: "ai",
    label: "Show the failing case",
    text: "paste the failing input for the date parser",
    why: "The agent has not shown it",
    best: false,
  },
  { kind: "habit", label: "Ship the build", text: "ship the build", why: "You send this often", best: false },
];

interface AiAnswer {
  status: "off" | "empty" | "pending" | "ready" | "error";
  replies?: typeof AI_REPLIES;
  error?: string | null;
}

function render(options: {
  outcome?: Outcome;
  status?: string;
  pending?: boolean;
  isRunning?: boolean;
  text?: string;
  settings?: Record<string, string | boolean>;
  retry?: () => Promise<unknown>;
  learned?: { label: string; text: string }[];
  snippets?: { id: string; label: string; text: string }[];
  ai?: AiAnswer;
  /** Delay the model's answer, to act on the row before it lands. */
  aiDelayMs?: number;
  threadListed?: boolean;
}) {
  const retryCalls: unknown[] = [];
  const ai = options.ai ?? { status: "off" };
  const slot = renderSlot(
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
        ...options.settings,
      },
      composer: {
        scope: { kind: "thread", threadId: THREAD },
        text: options.text ?? "",
        isRunning: options.isRunning ?? false,
      },
      sidebarThreads: {
        status: "ready",
        threads: [
          {
            id: options.threadListed === false ? "thr_other" : THREAD,
            projectId: PROJECT,
            status: options.status ?? "idle",
            hasPendingInteraction: options.pending ?? false,
          } as never,
        ],
      },
      rpc: {
        quickReplies: () => ({
          learned: options.learned ?? [
            { label: "Write the docs", text: "write the docs" },
            { label: "Ship the build", text: "ship the build" },
          ],
          snippets: options.snippets ?? [],
        }),
        aiQuickReplies: async () => {
          if (options.aiDelayMs) await new Promise((resolve) => setTimeout(resolve, options.aiDelayMs));
          return {
            status: ai.status,
            turnKey: ai.status === "ready" || ai.status === "pending" ? "msg_1" : null,
            replies: ai.replies ?? [],
            error: ai.error ?? null,
            model: "demo-small",
          };
        },
        quickReplyFeedback: () => ({ saved: true }),
        addPrompt: () => ({ prompt: null, error: null }),
      } as never,
      sdk: {
        subscribe: () => () => {},
        threads: {
          events: { list: async () => events(options.outcome ?? "completed") },
          retry: async (args: unknown) => {
            retryCalls.push(args);
            if (options.retry) return options.retry();
            return {};
          },
        },
      } as never,
    },
  );
  return { slot, retryCalls };
}

type Slot = ReturnType<typeof renderSlot>;

const chips = (slot: Slot) => within(slot.getByRole("toolbar")).getAllByRole("button");
/** A pointer entering an element, as a browser reports it: the pointer event, then the mouse one (a tap sends both too). */
const hover = (element: Element, pointerType = "mouse") => {
  fireEvent.pointerEnter(element, { pointerType });
  fireEvent.mouseEnter(element);
};
const BEST = "Send: fix the date parser first, then rerun the import tests";
/** The open chip details, if any. */
const details = () => document.querySelector<HTMLElement>("[data-quick-reply-details]");
const findDetails = () => waitFor(() => expect(details()).not.toBeNull()).then(() => within(details()!));
const chipTexts = (slot: Slot) => chips(slot).map((button) => button.textContent);
const calls = (slot: Slot, method: string) =>
  (slot.inspection.rpcCalls as { method: string; input: unknown }[]).filter(
    (call) => call.method === method,
  );

afterEach(cleanup);

describe("QuickReplies, without AI", () => {
  it("offers learned follow-ups and the any-time chips after a finished turn", async () => {
    const { slot } = render({ settings: { quickRepliesAi: "off" } });
    await waitFor(() =>
      expect(chipTexts(slot)).toEqual(["Write the docs", "Ship the build", "Progress"]),
    );
    expect(calls(slot, "aiQuickReplies")).toHaveLength(0);
  });

  it("uses the user's own follow-up list over learned ones", async () => {
    const { slot } = render({
      settings: { quickRepliesAi: "off", quickRepliesAfterDone: "Deploy | deploy it" },
    });
    await waitFor(() => expect(chipTexts(slot)).toEqual(["Deploy", "Progress"]));
  });

  it("leads with Continue after an interrupt and sends it on tap", async () => {
    const { slot } = render({ outcome: "interrupted", settings: { quickRepliesAi: "off" } });
    const chip = await slot.findByRole("button", { name: "Send: keep going" });
    expect(chipTexts(slot)).toEqual(["Keep going", "Progress"]);
    fireEvent.click(chip);
    await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  });

  it("retries a failed turn instead of sending text", async () => {
    const { slot, retryCalls } = render({ outcome: "failed", status: "error" });
    fireEvent.click(
      await slot.findByRole("button", { name: "Retry the failed turn: keep going" }),
    );
    await waitFor(() => expect(retryCalls).toEqual([{ threadId: THREAD, reason: "Quick reply" }]));
    expect(slot.inspection.composer.submits).toHaveLength(0);
    // A failed provider is not asked for suggestions.
    expect(calls(slot, "aiQuickReplies")).toHaveLength(0);
  });

  it("sends the text when a retry is already queued", async () => {
    const { slot, retryCalls } = render({
      outcome: "failed",
      status: "error",
      retry: async () => {
        throw new Error("A retry is already queued");
      },
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Retry the failed turn: keep going" }),
    );
    await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
    expect(retryCalls).toHaveLength(1);
  });

  it("retries a failed turn even when the sidebar does not list the thread", async () => {
    const { slot, retryCalls } = render({ outcome: "failed", threadListed: false });
    fireEvent.click(
      await slot.findByRole("button", { name: "Retry the failed turn: keep going" }),
    );
    await waitFor(() => expect(retryCalls).toHaveLength(1));
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("does not claim to retry when the tap only fills the composer", async () => {
    const { slot, retryCalls } = render({
      outcome: "failed",
      status: "error",
      settings: { quickReplyTap: "fill" },
    });
    const chip = await slot.findByRole("button", { name: "Add to draft: keep going" });
    fireEvent.click(chip);
    await waitFor(() => expect(slot.inspection.composer.text).toBe("keep going"));
    expect(retryCalls).toHaveLength(0);
  });

  it("fills the composer when set to fill", async () => {
    const { slot } = render({ settings: { quickRepliesAi: "off", quickReplyTap: "fill" } });
    fireEvent.click(await slot.findByRole("button", { name: "Add to draft: write the docs" }));
    await waitFor(() => expect(slot.inspection.composer.text).toBe("write the docs"));
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("hides while the agent waits on an answer", async () => {
    const { slot } = render({ pending: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.queryByRole("toolbar")).toBeNull();
  });

  it("renders nothing when switched off", async () => {
    const { slot } = render({ settings: { quickReplies: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.queryByRole("toolbar")).toBeNull();
  });
});

describe("QuickReplies, with AI", () => {
  it("shows the usual chips while the model reads the thread", async () => {
    const { slot } = render({ ai: { status: "pending" } });
    await waitFor(() =>
      expect(chipTexts(slot)).toEqual(["Write the docs", "Ship the build", "Progress"]),
    );
    expect((await slot.findByRole("status")).textContent).toContain("Reading the thread");
    expect(slot.queryByText("Best next step")).toBeNull();
    expect(calls(slot, "aiQuickReplies")[0]?.input).toEqual({
      threadId: THREAD,
      outcome: "finished",
      refresh: false,
    });
  });

  it("leads with the best next step and shows nothing more until asked", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    await waitFor(() =>
      expect(chipTexts(slot).map((text) => text?.replace(/⌥\d|Alt\+\d/, ""))).toEqual([
        "Fix the parser first",
        "Show the failing case",
        "Ship the build",
        "Progress",
      ]),
    );
    expect(chipTexts(slot)[0]).toMatch(/⌥1|Alt\+1/);
    expect(screen.queryByText("Best next step")).toBeNull();
    expect(details()).toBeNull();
  });

  it("opens a chip's details after a short hover: what it sends, and why", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    hover(await slot.findByRole("button", { name: "Send: fix the date parser first, then rerun the import tests" }));
    const card = await findDetails();
    expect(card.getByText("Best next step")).toBeTruthy();
    expect(card.getByText("fix the date parser first, then rerun the import tests")).toBeTruthy();
    expect(card.getByText("Answers the agent's question")).toBeTruthy();
  });

  it("sends the full prompt, not the label, and learns from the tap", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Send: fix the date parser first, then rerun the import tests",
      }),
    );
    await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
    await waitFor(() =>
      expect(calls(slot, "quickReplyFeedback")[0]?.input).toEqual({
        projectId: PROJECT,
        text: "fix the date parser first, then rerun the import tests",
        action: "tap",
      }),
    );
  });

  it("shows the details of the chip under the pointer", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    hover(
      await slot.findByRole("button", { name: "Send: paste the failing input for the date parser" }),
    );
    const card = await findDetails();
    expect(card.getByText("The agent has not shown it")).toBeTruthy();
    expect(card.getByText("Suggested")).toBeTruthy();
  });

  it("puts a reply in the composer to edit instead of sending it", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    hover(await slot.findByRole("button", { name: "Send: fix the date parser first, then rerun the import tests" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() =>
      expect(slot.inspection.composer.text).toBe(
        "fix the date parser first, then rerun the import tests",
      ),
    );
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("drops a dismissed reply, passes best on and remembers the dismissal", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    hover(await slot.findByRole("button", { name: "Send: fix the date parser first, then rerun the import tests" }));
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss: Fix the parser first" }));
    await waitFor(() =>
      expect(chipTexts(slot)[0]?.replace(/⌥\d|Alt\+\d/, "")).toBe("Show the failing case"),
    );
    expect(chipTexts(slot)[0]).toMatch(/⌥1|Alt\+1/);
    await waitFor(() => expect(calls(slot, "quickReplyFeedback")[0]?.input).toMatchObject({ action: "dismiss" }));
  });

  it("asks the model again on regenerate", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    fireEvent.click(await slot.findByRole("button", { name: "Suggest again" }));
    await waitFor(() =>
      expect(calls(slot, "aiQuickReplies").some((call) => (call.input as { refresh: boolean }).refresh)).toBe(true),
    );
  });

  it("narrows the row to chips that complete the draft", async () => {
    const { slot } = render({
      text: "fix",
      ai: { status: "ready", replies: AI_REPLIES },
      learned: [{ label: "Fix all failing tests", text: "fix all failing tests" }],
    });
    await waitFor(() =>
      expect(chipTexts(slot).map((text) => text?.replace(/⌥\d|Alt\+\d/, ""))).toEqual([
        "Fix the parser first",
        "Fix all failing tests",
      ]),
    );
    hover(slot.getByRole("button", { name: "Add to draft: fix the date parser first, then rerun the import tests" }));
    expect(await screen.findByText("Completes your draft")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Add to draft: fix all failing tests" }));
    await waitFor(() => expect(slot.inspection.composer.text).toBe("fix all failing tests"));
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("joins a draft that matches nothing", async () => {
    const { slot } = render({ text: "half a thought", ai: { status: "ready", replies: AI_REPLIES } });
    await slot.findByRole("button", { name: "Add to draft: fix the date parser first, then rerun the import tests" });
    fireEvent.click(slot.getByRole("button", { name: "Add to draft: ship the build" }));
    await waitFor(() => expect(slot.inspection.composer.text).toContain("ship the build"));
    expect(slot.inspection.composer.text).toContain("half a thought");
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("opens a snippet with fill-ins in the composer instead of sending it", async () => {
    const { slot } = render({
      text: "deb",
      snippets: [{ id: "s1", label: "Debug flaky test", text: "Debug the flaky test {{test}}" }],
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Add to draft: Debug the flaky test {{test}}" }),
    );
    await waitFor(() => expect(slot.inspection.composer.text).toBe("Debug the flaky test {{test}}"));
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("queues habits for the end of the turn while the agent works", async () => {
    const { slot } = render({ isRunning: true, ai: { status: "ready", replies: AI_REPLIES } });
    fireEvent.click(await slot.findByRole("button", { name: "Queue: write the docs" }));
    await waitFor(() =>
      expect(calls(slot, "addPrompt")[0]?.input).toEqual({
        scope: "thread",
        threadId: THREAD,
        projectId: PROJECT,
        text: "write the docs",
        autoSend: true,
      }),
    );
    expect(slot.inspection.composer.submits).toHaveLength(0);
    // The any-time chips still send at once.
    expect(slot.getByRole("button", { name: "Send: progress?" })).toBeTruthy();
    expect(calls(slot, "aiQuickReplies")).toHaveLength(0);
  });

  it("holds the model's picks while the user is moving over the row, not after", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES }, aiDelayMs: 80 });
    // The usual chips render before the model's answer is read.
    const usual = await slot.findByRole("button", { name: "Send: write the docs" });
    fireEvent.mouseMove(usual.closest("[data-quick-replies]")!);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(slot.queryByRole("button", { name: "Send: fix the date parser first, then rerun the import tests" })).toBeNull();
    // A resting pointer does not keep them away for long.
    expect(await slot.findByRole("button", { name: "Send: fix the date parser first, then rerun the import tests" }, { timeout: 2_000 })).toBeTruthy();
  });

  it("says Add to draft in the details when a tap would only join the draft", async () => {
    const { slot } = render({ text: "half a thought", ai: { status: "ready", replies: AI_REPLIES } });
    hover(
      await slot.findByRole("button", { name: "Add to draft: fix the date parser first, then rerun the import tests" }),
    );
    expect(await screen.findByRole("button", { name: "Add to draft" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("keeps a press from opening the details the hover started", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    const best = await slot.findByRole("button", { name: BEST });
    hover(best);
    fireEvent.pointerDown(best, { pointerType: "mouse" });
    fireEvent.click(best);
    await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(details()).toBeNull();
  });

  it("opens no details when a touch enters a chip", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    hover(await slot.findByRole("button", { name: BEST }), "touch");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(details()).toBeNull();
  });

  it("closes the details on the first Escape and goes to the composer on the next", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    const best = await slot.findByRole("button", { name: BEST });
    best.focus();
    await findDetails();
    fireEvent.keyDown(best, { key: "Escape" });
    await waitFor(() => expect(details()).toBeNull());
    expect(document.activeElement).toBe(best);
    expect(slot.inspection.composer.focusCount).toBe(0);
    // The next Escape goes back to the composer.
    fireEvent.keyDown(best, { key: "Escape" });
    expect(slot.inspection.composer.focusCount).toBe(1);
  });

  it("tells assistive tech why a chip is there", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    const best = await slot.findByRole("button", { name: BEST });
    const why = document.getElementById(best.getAttribute("aria-describedby") ?? "");
    expect(why?.textContent).toBe("Answers the agent's question");
  });

  it("offers Dismiss on the user's own chips too", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    await slot.findByRole("button", { name: BEST });
    hover(slot.getByRole("button", { name: "Send: progress?" }));
    expect(await screen.findByRole("button", { name: "Dismiss: Progress" })).toBeTruthy();
  });

  it("keeps keyboard focus in the row after a keyboard dismissal", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    const best = await slot.findByRole("button", { name: "Send: fix the date parser first, then rerun the import tests" });
    best.focus();
    // Delete on a focused chip dismisses it.
    fireEvent.keyDown(best, { key: "Delete" });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Send: paste the failing input for the date parser",
      ),
    );
  });

  it("keeps keyboard focus in the row when the model's picks land", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES }, aiDelayMs: 1_400 });
    const usual = await slot.findByRole("button", { name: "Send: write the docs" });
    usual.focus();
    expect(await slot.findByRole("button", { name: "Send: fix the date parser first, then rerun the import tests" }, { timeout: 4_000 })).toBeTruthy();
    expect(document.activeElement?.closest('[role="toolbar"]')).not.toBeNull();
  });

  it("leaves focus alone once the user clicked away from the row and started typing", async () => {
    const { slot } = render({ settings: { quickRepliesAi: "off" } });
    await slot.findByText("Write the docs");
    // Stands in for bb's composer editor, outside the plugin's row.
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    try {
      await act(async () => chips(slot)[0]!.focus());
      // A click on the conversation's text: blur with no new focus.
      await act(async () => (document.activeElement as HTMLElement).blur());
      await act(async () => editor.focus());
      // Typing turns the row into the filter row; the caret must stay put.
      await slot.setComposerText("wri");
      await waitFor(() =>
        expect(slot.container.querySelector("[data-quick-replies]")?.getAttribute("data-quick-replies")).toBe("filter"),
      );
      expect(document.activeElement).toBe(editor);
    } finally {
      editor.remove();
    }
  });

  it("keeps regenerate focusable while it asks again", async () => {
    const { slot } = render({ ai: { status: "ready", replies: AI_REPLIES } });
    const again = await slot.findByRole("button", { name: "Suggest again" });
    again.focus();
    fireEvent.click(again);
    expect(again.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(again);
  });

  it("keeps the usual chips and offers a retry when the model fails", async () => {
    const { slot } = render({ ai: { status: "error", error: "The model took too long to answer" } });
    const again = await slot.findByRole("button", { name: "Try suggesting again" });
    expect(again.getAttribute("title")).toContain("The model took too long to answer");
    expect(chipTexts(slot)).toEqual(["Write the docs", "Ship the build", "Progress"]);
  });
});
