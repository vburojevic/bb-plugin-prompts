import { describe, expect, it } from "vitest";
import {
  buildSuggestPrompt,
  clip,
  extractRepliesJson,
  lightestReasoning,
  parseModelOverrides,
  parseSuggestReply,
  rankHabits,
  smallModelFor,
  SMALL_MODELS,
  transcriptFromEvents,
} from "./ai-replies";

// Every phrase here is invented demo text.

const agent = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "item/completed",
  data: { item: { type: "agentMessage", id, text, ...extra } },
});
const user = (text: string) => ({
  type: "item/completed",
  data: { item: { type: "userMessage", id: `u-${text}`, content: [{ type: "text", text }] } },
});

describe("smallModelFor", () => {
  it("pins Haiku 5.5 for Claude Code and gpt-6-luna for Codex", () => {
    // The owner's call (2026-11-17): quick replies are the one place the
    // plugin uses the provider's fastest model instead of its flagship.
    expect(SMALL_MODELS).toEqual({ "claude-code": "claude-haiku-5-5", codex: "gpt-6-luna" });
    expect(
      smallModelFor("claude-code", [
        { model: "claude-opus-5-5" },
        { model: "claude-sonnet-5-5" },
        { model: "claude-haiku-5-5" },
      ]),
    ).toBe("claude-haiku-5-5");
    expect(
      smallModelFor("codex", [
        { model: "gpt-6-luna", description: "Fast and affordable model for easier tasks." },
        { model: "gpt-5.6-terra", description: "Older balanced model for straightforward work." },
      ]),
    ).toBe("gpt-6-luna");
  });

  it("uses the pinned model when the catalog cannot be read", () => {
    expect(smallModelFor("claude-code", null)).toBe("claude-haiku-5-5");
  });

  it("finds the smallest, fastest model of a provider it does not know", () => {
    expect(
      smallModelFor("acme", [
        { model: "acme-large", description: "Our most capable model." },
        { model: "acme-mini", description: "Fast and cheap." },
        { model: "acme-mini-old", description: "Older fast model." },
      ]),
    ).toBe("acme-mini");
  });

  it("falls back to the provider default when nothing reads small", () => {
    expect(smallModelFor("acme", [{ model: "acme-one" }, { model: "acme-two" }])).toBeNull();
  });

  it("honors an override for that provider only", () => {
    const overrides = parseModelOverrides("claude-code = claude-sonnet-5-5\n# a comment\nbad line");
    expect(smallModelFor("claude-code", null, overrides)).toBe("claude-sonnet-5-5");
    expect(smallModelFor("codex", null, overrides)).toBe("gpt-6-luna");
  });

  it("refuses override values a shell could misread", () => {
    expect(parseModelOverrides("codex = gpt; rm -rf ~").size).toBe(0);
  });

  it("picks the lightest reasoning level a model takes", () => {
    expect(lightestReasoning({ model: "m", reasoningLevels: ["low", "medium", "high"] })).toBe("low");
    expect(lightestReasoning({ model: "m", reasoningLevels: ["minimal", "low"] })).toBe("minimal");
    expect(lightestReasoning({ model: "m" })).toBeNull();
  });
});

describe("transcriptFromEvents", () => {
  it("keeps the latest messages oldest first and keys the turn by the newest reply", () => {
    const transcript = transcriptFromEvents([
      agent("a2", "Done. Should I open the PR now?"),
      user("fix the import"),
      agent("a1", "Looking at the import."),
      user("the import breaks on dates"),
    ]);
    expect(transcript.turnKey).toBe("a2");
    expect(transcript.messages).toEqual([
      { role: "user", text: "the import breaks on dates" },
      { role: "agent", text: "Looking at the import." },
      { role: "user", text: "fix the import" },
      { role: "agent", text: "Done. Should I open the PR now?" },
    ]);
  });

  it("leaves out a sub-agent's messages", () => {
    const transcript = transcriptFromEvents([
      agent("a3", "Summary for you.", {}),
      agent("sub", "internal notes", { parentToolCallId: "tool_1" }),
    ]);
    expect(transcript.messages).toEqual([{ role: "agent", text: "Summary for you." }]);
  });

  it("has nothing to follow up on while a new turn starts", () => {
    expect(transcriptFromEvents([user("next please"), agent("a1", "Done.")]).turnKey).toBeNull();
    expect(transcriptFromEvents([]).turnKey).toBeNull();
  });

  it("keeps the start and the end of a long reply, where the question is", () => {
    const long = `start ${"x".repeat(5_000)} end: ship it?`;
    const clipped = clip(long, 400);
    expect(clipped.length).toBeLessThanOrEqual(400);
    expect(clipped.startsWith("start")).toBe(true);
    expect(clipped.endsWith("ship it?")).toBe(true);
  });
});

describe("buildSuggestPrompt", () => {
  it("gives the model the conversation, the user's habits, snippets and voice", () => {
    const prompt = buildSuggestPrompt({
      title: "Import breaks on dates",
      outcome: "finished",
      messages: [
        { role: "user", text: "fix the import" },
        { role: "agent", text: "Fixed. Should I open the PR now?" },
      ],
      habits: [{ text: "commit and push", count: 40 }],
      snippets: [{ id: "s1", title: "Review pass", body: "Review the diff strictly." }],
      voice: ["fix the import"],
      avoid: ["write a changelog"],
    });
    expect(prompt).toContain("<agent>\nFixed. Should I open the PR now?\n</agent>");
    expect(prompt).toContain('"commit and push" (sent 40 times)');
    expect(prompt).toContain('s1: "Review pass"');
    expect(prompt).toContain('"write a changelog"');
    expect(prompt).toContain("Do not use tools");
    expect(prompt).toContain('{"replies":[');
  });

  it("says when the user stopped the turn", () => {
    const prompt = buildSuggestPrompt({
      title: null,
      outcome: "interrupted",
      messages: [],
      habits: [],
      snippets: [],
      voice: [],
      avoid: [],
    });
    expect(prompt).toContain("The user stopped the agent's last turn");
  });
});

describe("parseSuggestReply", () => {
  const context = {
    habits: [{ text: "Commit and push" }],
    snippets: [{ id: "s1", title: "Review pass", body: "Review the diff strictly." }],
  };

  it("reads replies wrapped in prose, a fence and another plugin's marker", () => {
    const raw = [
      "Here you go:",
      "```json",
      JSON.stringify({
        replies: [
          { kind: "ai", label: "show the diff", text: "show me the diff", why: "Not shown yet." },
          { kind: "answer", label: "Open the PR", text: "open the PR now", why: "Answers the question", best: true },
        ],
      }),
      "```",
      '::flair{text="dry line"}',
    ].join("\n");
    const replies = parseSuggestReply(raw, context);
    expect(replies.map((reply) => reply.label)).toEqual(["Open the PR", "Show the diff"]);
    expect(replies[0]).toMatchObject({ best: true, kind: "answer", why: "Answers the question" });
    expect(replies[1]).toMatchObject({ best: false, why: "Not shown yet" });
  });

  it("sends a habit in the user's own spelling and a snippet's saved body", () => {
    const replies = parseSuggestReply(
      JSON.stringify({
        replies: [
          { kind: "habit", label: "Commit", text: "commit and push!" },
          { kind: "snippet", label: "", text: "", snippet: "s1" },
        ],
      }),
      context,
    );
    expect(replies[0]).toMatchObject({ kind: "habit", text: "Commit and push", best: true });
    expect(replies[1]).toMatchObject({ kind: "snippet", label: "Review pass", text: "Review the diff strictly." });
  });

  it("treats an unknown habit or snippet as a plain suggestion", () => {
    const replies = parseSuggestReply(
      JSON.stringify({
        replies: [
          { kind: "habit", label: "Deploy", text: "deploy to staging" },
          { kind: "snippet", label: "Ghost", text: "ghost text", snippet: "nope" },
        ],
      }),
      context,
    );
    expect(replies.map((reply) => reply.kind)).toEqual(["ai", "ai"]);
  });

  it("drops duplicates and empties and keeps at most five", () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ label: `Step ${index}`, text: `step ${index}` }));
    const replies = parseSuggestReply(
      JSON.stringify({ replies: [{ label: "x", text: "" }, ...items, { label: "again", text: "Step 0." }] }),
      context,
    );
    expect(replies).toHaveLength(5);
    expect(replies.filter((reply) => reply.best)).toHaveLength(1);
  });

  it("returns nothing for an answer without replies", () => {
    expect(parseSuggestReply("I could not decide.", context)).toEqual([]);
    expect(extractRepliesJson('{"other": 1}')).toBeNull();
  });
});

describe("rankHabits", () => {
  it("ranks taps up, dismissals down, and drops what was dismissed twice", () => {
    const habits = [
      { text: "commit and push", count: 50 },
      { text: "run the tests", count: 40 },
      { text: "status", count: 30 },
    ];
    const ranked = rankHabits(
      habits,
      new Map([
        ["run the tests", { taps: 4, dismissals: 0 }],
        ["commit and push", { taps: 0, dismissals: 1 }],
        ["status", { taps: 0, dismissals: 2 }],
      ]),
    );
    expect(ranked.map((habit) => habit.text)).toEqual(["run the tests", "commit and push"]);
  });
});
