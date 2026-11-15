import { describe, expect, it } from "vitest";
import {
  chipsFor,
  editDistance,
  FALLBACK_FOLLOW_UPS,
  labelFor,
  learnQuickReplies,
  parseReplyLines,
  QUICK_REPLY_FOLLOW_UPS,
  quickReplyState,
  replyKey,
  shortLabel,
  turnOutcomeFromEvents,
  type QuickReplyConfig,
} from "./quick-replies";

// Every phrase here is invented demo text.
function typed(text: string, times: number): { text: string }[] {
  return Array.from({ length: times }, () => ({ text }));
}

const CONFIG: QuickReplyConfig = {
  afterStop: parseReplyLines("Keep going | keep going\nTry again"),
  afterDone: [],
  anyTime: parseReplyLines("Progress | progress?"),
};

describe("parseReplyLines", () => {
  it("reads 'Label | text' and bare lines, skipping blanks and comments", () => {
    expect(
      parseReplyLines("Keep going | keep going\n\n# a note\nwrite the docs\n  "),
    ).toEqual([
      { label: "Keep going", text: "keep going" },
      { label: "Write the docs", text: "write the docs" },
    ]);
  });

  it("keeps a slash command as its own label and drops lines without text", () => {
    expect(parseReplyLines("/review\nLabel only |")).toEqual([
      { label: "/review", text: "/review" },
    ]);
  });

  it("drops duplicate texts and tolerates junk input", () => {
    expect(parseReplyLines("go on\nGo On\nA | go on")).toHaveLength(1);
    expect(parseReplyLines(undefined)).toEqual([]);
    expect(parseReplyLines(null)).toEqual([]);
  });

  it("caps the number of chips", () => {
    const many = Array.from({ length: 40 }, (_, i) => `phrase ${i}`).join("\n");
    expect(parseReplyLines(many)).toHaveLength(20);
  });
});

describe("labelFor and shortLabel", () => {
  it("sentence-cases and collapses spaces", () => {
    expect(labelFor("  ship   the build ")).toBe("Ship the build");
  });

  it("cuts long labels with an ellipsis", () => {
    const label = shortLabel("Please write a longer follow up than fits");
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(28);
    expect(shortLabel("Short")).toBe("Short");
  });
});

describe("editDistance", () => {
  it("counts a swap of neighbours as one slip", () => {
    expect(editDistance("keep gonig", "keep going", 1)).toBe(1);
    expect(editDistance("kep going", "keep going", 1)).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
  });

  it("stops early past the cap", () => {
    expect(editDistance("short", "something else", 2)).toBe(3);
  });
});

describe("learnQuickReplies", () => {
  it("ranks the short prompts typed most", () => {
    const learned = learnQuickReplies([
      ...typed("keep going", 40),
      ...typed("write the docs", 9),
      ...typed("ship the build", 5),
      ...typed("seldom", 2),
    ]);
    expect(learned.map((reply) => reply.text)).toEqual([
      "keep going",
      "write the docs",
      "ship the build",
    ]);
    expect(learned[0]).toEqual({ label: "Keep going", text: "keep going", count: 40 });
  });

  it("folds typos into the spelling typed most", () => {
    const learned = learnQuickReplies([
      ...typed("keep going", 30),
      ...typed("keep gonig", 4),
      ...typed("kep going", 3),
    ]);
    expect(learned).toHaveLength(1);
    expect(learned[0]!.count).toBe(37);
    expect(learned[0]!.text).toBe("keep going");
  });

  it("keeps two real phrases one letter apart when neither is rare", () => {
    const learned = learnQuickReplies([...typed("fix it", 10), ...typed("fix all", 8)]);
    expect(learned.map((reply) => reply.text).sort()).toEqual(["fix all", "fix it"]);
  });

  it("merges case and trailing punctuation, sending the common form", () => {
    const learned = learnQuickReplies([
      ...typed("Write the docs", 2),
      ...typed("write the docs.", 1),
      ...typed("write the docs", 4),
    ]);
    expect(learned).toEqual([
      { label: "Write the docs", text: "write the docs", count: 7 },
    ]);
  });

  it("leaves out long prompts, commands, links, numbers and machine text", () => {
    const learned = learnQuickReplies([
      ...typed("a very long prompt that is clearly a request and not a reflex", 9),
      ...typed("/review", 9),
      ...typed("see https://example.com", 9),
      ...typed("1", 9),
      ...typed("ok", 9),
      ...typed("reply with exactly: yes", 9),
      ...typed("line one\nline two", 9),
    ]);
    expect(learned).toEqual([]);
  });

  it("respects the limit", () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      typed(`phrase number ${String.fromCharCode(97 + i)}`, 3 + i),
    ).flat();
    expect(learnQuickReplies(history, 4)).toHaveLength(4);
  });
});

describe("turnOutcomeFromEvents", () => {
  it("reads the latest turn's status", () => {
    expect(
      turnOutcomeFromEvents([
        { type: "turn/completed", data: { status: "failed" } },
        { type: "turn/started" },
        { type: "turn/completed", data: { status: "completed" } },
      ]),
    ).toBe("failed");
  });

  it("lets an interrupt beat a completed status in the same turn", () => {
    expect(
      turnOutcomeFromEvents([
        { type: "turn/completed", data: { status: "completed" } },
        { type: "system/thread/interrupted" },
        { type: "turn/started" },
      ]),
    ).toBe("interrupted");
  });

  it("ignores an interrupt from an older turn", () => {
    expect(
      turnOutcomeFromEvents([
        { type: "turn/completed", data: { status: "completed" } },
        { type: "turn/started" },
        { type: "system/thread/interrupted" },
      ]),
    ).toBe("completed");
  });

  it("says none when no turn has ended", () => {
    expect(turnOutcomeFromEvents([])).toBe("none");
    expect(turnOutcomeFromEvents([{ type: "turn/started" }])).toBe("none");
  });
});

describe("quickReplyState", () => {
  const base = {
    status: "idle",
    isRunning: false,
    hasPendingInteraction: false,
    outcome: "completed" as const,
  };

  it("maps each thread state", () => {
    expect(quickReplyState(base)).toBe("finished");
    expect(quickReplyState({ ...base, outcome: "interrupted" })).toBe("interrupted");
    expect(quickReplyState({ ...base, outcome: "failed" })).toBe("failed");
    expect(quickReplyState({ ...base, status: "error", outcome: "none" })).toBe("failed");
    expect(quickReplyState({ ...base, outcome: "none" })).toBe("unknown");
    expect(quickReplyState({ ...base, status: null, outcome: "none" })).toBe("unknown");
  });

  it("puts a question on screen and a running agent ahead of the last outcome", () => {
    expect(quickReplyState({ ...base, hasPendingInteraction: true })).toBe("waiting");
    expect(quickReplyState({ ...base, isRunning: true, outcome: "failed" })).toBe("running");
    expect(quickReplyState({ ...base, status: "active" })).toBe("running");
  });
});

describe("chipsFor", () => {
  const learned = learnQuickReplies([
    ...typed("write the docs", 9),
    ...typed("ship the build", 6),
  ]);

  it("leads with the first after-stop chip after a failure, as a retry", () => {
    const chips = chipsFor("failed", CONFIG, learned);
    expect(chips.map((chip) => chip.text)).toEqual(["keep going", "Try again", "progress?"]);
    expect(chips[0]).toMatchObject({ primary: true, retry: true });
    expect(chips[1]).toMatchObject({ primary: false, retry: false });
  });

  it("sends text, never a retry, after an interrupt", () => {
    const chips = chipsFor("interrupted", CONFIG, learned);
    expect(chips[0]).toMatchObject({ text: "keep going", primary: true, retry: false });
  });

  it("offers learned follow-ups after a finished turn", () => {
    expect(chipsFor("finished", CONFIG, learned).map((chip) => chip.text)).toEqual([
      "write the docs",
      "ship the build",
      "progress?",
    ]);
  });

  it("prefers the user's own follow-up list over learned ones", () => {
    const config = { ...CONFIG, afterDone: parseReplyLines("Deploy | deploy it") };
    expect(chipsFor("finished", config, learned).map((chip) => chip.text)).toEqual([
      "deploy it",
      "progress?",
    ]);
  });

  it("falls back to generic follow-ups when nothing was learned", () => {
    const chips = chipsFor("finished", CONFIG, []);
    expect(chips.slice(0, FALLBACK_FOLLOW_UPS.length).map((chip) => chip.text)).toEqual(
      FALLBACK_FOLLOW_UPS.map((reply) => reply.text),
    );
  });

  it("caps follow-ups and drops duplicates of any-time chips", () => {
    const many = learnQuickReplies(
      ["alpha one", "bravo two", "charlie three", "delta four", "echo five", "foxtrot six", "progress?"]
        .flatMap((text, i) => typed(text, 20 - i)),
    );
    const chips = chipsFor("finished", CONFIG, many);
    expect(chips.filter((chip) => replyKey(chip.text) === "progress")).toHaveLength(1);
    expect(chips.length).toBeLessThanOrEqual(QUICK_REPLY_FOLLOW_UPS + 1);
  });

  it("shows only any-time chips while running or before any turn", () => {
    expect(chipsFor("running", CONFIG, learned).map((chip) => chip.text)).toEqual(["progress?"]);
    expect(chipsFor("unknown", CONFIG, learned).map((chip) => chip.text)).toEqual(["progress?"]);
  });

  it("shows nothing while the agent waits on an answer", () => {
    expect(chipsFor("waiting", CONFIG, learned)).toEqual([]);
  });
});
