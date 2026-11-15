// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { QuickReplies } from "./quick-replies";

// Every phrase here is invented demo text.
const THREAD = "thr_demo";

type Outcome = "completed" | "failed" | "interrupted";

function events(outcome: Outcome) {
  return [
    { type: "turn/completed", data: { status: outcome } },
    { type: "turn/started", data: {} },
  ];
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
  threadListed?: boolean;
}) {
  const retryCalls: unknown[] = [];
  const slot = renderSlot(
    { component: QuickReplies },
    {},
    {
      settings: {
        quickReplies: true,
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
        }),
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

const chipTexts = (slot: ReturnType<typeof renderSlot>) =>
  slot
    .getAllByRole("button")
    .map((button) => button.textContent);

afterEach(cleanup);

describe("QuickReplies", () => {
  it("offers learned follow-ups and the any-time chips after a finished turn", async () => {
    const { slot } = render({});
    await waitFor(() =>
      expect(chipTexts(slot)).toEqual(["Write the docs", "Ship the build", "Progress"]),
    );
  });

  it("leads with Continue after an interrupt and sends it on tap", async () => {
    const { slot } = render({ outcome: "interrupted" });
    const chip = await slot.findByRole("button", { name: "Send: keep going" });
    expect(chipTexts(slot)).toEqual(["Keep going", "Progress"]);
    fireEvent.click(chip);
    await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  });

  it("retries a failed turn instead of sending text", async () => {
    const { slot, retryCalls } = render({ outcome: "failed", status: "error" });
    const chip = await slot.findByRole("button", {
      name: "Keep going: retry the failed turn",
    });
    fireEvent.click(chip);
    await waitFor(() => expect(retryCalls).toEqual([{ threadId: THREAD, reason: "Quick reply" }]));
    expect(slot.inspection.composer.submits).toHaveLength(0);
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
      await slot.findByRole("button", { name: "Keep going: retry the failed turn" }),
    );
    await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
    expect(retryCalls).toHaveLength(1);
  });

  it("retries a failed turn even when the sidebar does not list the thread", async () => {
    const { slot, retryCalls } = render({ outcome: "failed", threadListed: false });
    fireEvent.click(
      await slot.findByRole("button", { name: "Keep going: retry the failed turn" }),
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
    expect(chip.getAttribute("title")).toBe("keep going");
    fireEvent.click(chip);
    await waitFor(() => expect(slot.inspection.composer.text).toBe("keep going"));
    expect(retryCalls).toHaveLength(0);
  });

  it("adds to an existing draft instead of sending it", async () => {
    const { slot } = render({ text: "half a thought" });
    fireEvent.click(await slot.findByRole("button", { name: "Add to draft: write the docs" }));
    await waitFor(() =>
      expect(slot.inspection.composer.text).toContain("write the docs"),
    );
    expect(slot.inspection.composer.text).toContain("half a thought");
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("fills the composer when set to fill", async () => {
    const { slot } = render({ settings: { quickReplyTap: "fill" } });
    fireEvent.click(await slot.findByRole("button", { name: "Add to draft: write the docs" }));
    await waitFor(() => expect(slot.inspection.composer.text).toBe("write the docs"));
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("shows only any-time chips while the agent works", async () => {
    const { slot } = render({ isRunning: true });
    await waitFor(() => expect(chipTexts(slot)).toEqual(["Progress"]));
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

  it("uses the user's own follow-up list over learned ones", async () => {
    const { slot } = render({ settings: { quickRepliesAfterDone: "Deploy | deploy it" } });
    await waitFor(() => expect(chipTexts(slot)).toEqual(["Deploy", "Progress"]));
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });
});
