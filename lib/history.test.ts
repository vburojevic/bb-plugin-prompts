import { describe, expect, it } from "vitest";
import { toHistoryPrompt } from "./history";
import { queuedMessageText, stashMessages } from "./queued-messages";

describe("toHistoryPrompt", () => {
  it("keeps a plain typed prompt", () => {
    expect(
      toHistoryPrompt({
        createdAt: 5,
        input: [{ type: "text", text: "  commit and push  " }],
      }),
    ).toEqual([{ text: "commit and push", createdAt: 5 }]);
  });

  it("joins multiple text parts", () => {
    expect(
      toHistoryPrompt({
        createdAt: 5,
        input: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      })[0]!.text,
    ).toBe("first\nsecond");
  });

  it("drops assembled entries: agent-only context is not user writing", () => {
    expect(
      toHistoryPrompt({
        createdAt: 5,
        input: [
          { type: "text", text: "typed" },
          { type: "text", text: "injected", visibility: "agent-only" },
        ],
      }),
    ).toEqual([]);
  });

  it("drops prompts carrying a mention that would arrive broken", () => {
    expect(
      toHistoryPrompt({
        createdAt: 5,
        input: [
          {
            type: "text",
            text: "look at this",
            mentions: [{ resource: { kind: "file" } }],
          },
        ],
      }),
    ).toEqual([]);
    // A /command resolves the same way in any thread, so it stays portable.
    expect(
      toHistoryPrompt({
        createdAt: 5,
        input: [
          {
            type: "text",
            text: "/review the branch",
            mentions: [{ resource: { kind: "command" } }],
          },
        ],
      }),
    ).toHaveLength(1);
  });

  it("drops entries with no text at all", () => {
    expect(toHistoryPrompt({ createdAt: 5, input: [{ type: "image" }] })).toEqual([]);
    expect(
      toHistoryPrompt({ createdAt: 5, input: [{ type: "text", text: "   " }] }),
    ).toEqual([]);
  });
});

describe("stashing bb's own queue", () => {
  const message = (id: string, text?: string) => ({
    id,
    content: text === undefined ? [{ type: "image" }] : [{ type: "text", text }],
    updatedAt: 1,
  });

  it("reads the text of a queued message", () => {
    expect(queuedMessageText(message("a", " hello "))).toBe("hello");
    expect(queuedMessageText(message("b"))).toBe("");
  });

  it("copies first, then deletes", async () => {
    const order: string[] = [];
    const result = await stashMessages("t1", [message("a", "one")], {
      deleteMessage: async () => {
        order.push("delete");
      },
      stash: (text) => {
        order.push(`stash:${text}`);
        return { id: "pq_1" };
      },
      unstash: () => order.push("unstash"),
    });
    expect(order).toEqual(["stash:one", "delete"]);
    expect(result).toEqual({ stashed: 1, skipped: 0, error: null });
  });

  it("undoes the copy when bb will not release the message", async () => {
    const order: string[] = [];
    const result = await stashMessages("t1", [message("a", "one")], {
      deleteMessage: async () => {
        throw new Error("nope");
      },
      stash: () => {
        order.push("stash");
        return { id: "pq_1" };
      },
      unstash: (id) => order.push(`unstash:${id}`),
    });
    // An undeletable message must never leave a duplicate in the stash.
    expect(order).toEqual(["stash", "unstash:pq_1"]);
    expect(result).toEqual({ stashed: 0, skipped: 1, error: null });
  });

  it("skips non-text messages instead of stashing empties", async () => {
    const result = await stashMessages("t1", [message("a")], {
      deleteMessage: async () => {},
      stash: () => ({ id: "pq_1" }),
      unstash: () => {},
    });
    expect(result).toEqual({ stashed: 0, skipped: 1, error: null });
  });
});
