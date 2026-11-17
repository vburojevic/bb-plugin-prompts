import { describe, expect, it } from "vitest";
import {
  rowFor,
  similarReplies,
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
  it("learns from a long history of distinct prompts quickly", () => {
    const words = "fix run add check update test build deploy push merge review open close write read show list make move rename delete parser docs readme tests api login cache server client config ui page modal button color theme".split(" ");
    let seed = 7;
    const pick = () => words[(seed = (seed * 16807) % 2147483647) % words.length]!;
    const history = Array.from({ length: 3000 }, () => ({
      text: Array.from({ length: 2 + (seed % 4) }, pick).join(" "),
    }));
    const started = performance.now();
    learnQuickReplies(history);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

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

describe("rowFor without AI", () => {
  const learned = learnQuickReplies([
    ...typed("write the docs", 9),
    ...typed("ship the build", 6),
  ]);
  const chipsFor = (state: Parameters<typeof rowFor>[0]["state"], config = CONFIG, from = learned) =>
    rowFor({
      state,
      config,
      learned: from,
      snippets: [],
      ai: { status: "off", replies: [] },
      draft: "",
      dismissed: new Set(),
    }).items;

  it("leads with the first after-stop chip after a failure, as a retry", () => {
    const chips = chipsFor("failed");
    expect(chips.map((chip) => chip.text)).toEqual(["keep going", "Try again", "progress?"]);
    expect(chips[0]).toMatchObject({ primary: true, action: "retry" });
    expect(chips[1]).toMatchObject({ primary: false, action: "send" });
  });

  it("sends text, never a retry, after an interrupt", () => {
    expect(chipsFor("interrupted")[0]).toMatchObject({ text: "keep going", primary: true, action: "send" });
  });

  it("offers learned follow-ups after a finished turn", () => {
    expect(chipsFor("finished").map((chip) => chip.text)).toEqual([
      "write the docs",
      "ship the build",
      "progress?",
    ]);
  });

  it("prefers the user's own follow-up list over learned ones", () => {
    const config = { ...CONFIG, afterDone: parseReplyLines("Deploy | deploy it") };
    expect(chipsFor("finished", config).map((chip) => chip.text)).toEqual(["deploy it", "progress?"]);
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

  it("shows only any-time chips before any turn", () => {
    expect(chipsFor("unknown").map((chip) => chip.text)).toEqual(["progress?"]);
  });

  it("shows nothing while the agent waits on an answer", () => {
    expect(chipsFor("waiting")).toEqual([]);
  });
});

describe("rowFor", () => {
  // Every phrase here is invented demo text.
  const config = {
    afterStop: [{ label: "Continue", text: "continue" }],
    afterDone: [],
    anyTime: [{ label: "Status", text: "status" }],
  };
  const learned = [
    { label: "Commit and push", text: "commit and push" },
    { label: "Run the tests", text: "run the tests" },
  ];
  const replies = [
    { label: "Open the PR", text: "open the PR now", kind: "answer" as const, why: "Answers it", best: true },
    { label: "Show the diff", text: "show me the diff", kind: "ai" as const, why: "Not shown", best: false },
  ];
  const base = {
    config,
    learned,
    snippets: [],
    ai: { status: "idle" as const, replies: [] },
    draft: "",
    dismissed: new Set<string>(),
  };

  it("shows the usual chips while the model reads", () => {
    const row = rowFor({ ...base, state: "finished", ai: { status: "pending", replies: [] } });
    expect(row.mode).toBe("loading");
    expect(row.items.map((item) => item.label)).toEqual(["Commit and push", "Run the tests", "Status"]);
  });

  it("leads with the model's best pick once it lands", () => {
    const row = rowFor({ ...base, state: "finished", ai: { status: "ready", replies } });
    expect(row.mode).toBe("ai");
    expect(row.items.map((item) => [item.label, item.best])).toEqual([
      ["Open the PR", true],
      ["Show the diff", false],
      ["Status", false],
    ]);
    expect(row.items[0]?.best).toBe(true);
  });

  it("keeps Continue first after an interrupt and still offers the model's picks", () => {
    const row = rowFor({ ...base, state: "interrupted", ai: { status: "ready", replies } });
    expect(row.items[0]).toMatchObject({ label: "Continue", primary: true, best: false });
    expect(row.items[1]?.best).toBe(true);
  });

  it("passes best to the next pick when the best one is dismissed", () => {
    const row = rowFor({
      ...base,
      state: "finished",
      ai: { status: "ready", replies },
      dismissed: new Set(["open the pr now"]),
    });
    expect(row.items[0]).toMatchObject({ label: "Show the diff", best: true });
  });

  it("queues habits while the agent works and never asks the model there", () => {
    const row = rowFor({ ...base, state: "running", ai: { status: "ready", replies } });
    expect(row.mode).toBe("queue");
    expect(row.items.map((item) => [item.label, item.action])).toEqual([
      ["Commit and push", "queue"],
      ["Run the tests", "queue"],
      ["Status", "send"],
    ]);
  });

  it("leads a failed turn with a retry", () => {
    const row = rowFor({ ...base, state: "failed" });
    expect(row.items[0]).toMatchObject({ label: "Continue", action: "retry", primary: true });
  });

  it("narrows to chips that complete the draft, never one that only repeats it", () => {
    const row = rowFor({
      ...base,
      state: "finished",
      ai: { status: "ready", replies },
      learned: [...learned, { label: "Run", text: "run" }],
      draft: "run",
    });
    expect(row.mode).toBe("filter");
    expect(row.items.map((item) => [item.label, item.action, item.best])).toEqual([
      ["Run the tests", "complete", true],
    ]);
  });

  it("hides while the agent waits on an answer", () => {
    expect(rowFor({ ...base, state: "waiting" }).mode).toBe("hidden");
  });
});

describe("similarReplies", () => {
  it("treats two phrasings of one request as the same", () => {
    expect(similarReplies("use ask mode", "Use ask mode in bb")).toBe(true);
    expect(similarReplies("run the tests", "run all the tests")).toBe(true);
    expect(similarReplies("open the PR now", "open the PR")).toBe(true);
  });

  it("keeps different requests apart, and one word is never enough", () => {
    expect(similarReplies("fix it", "fix all")).toBe(false);
    expect(similarReplies("commit", "commit and push")).toBe(false);
    expect(similarReplies("throw an error", "return a result")).toBe(false);
    expect(similarReplies("all done?", "use ask mode")).toBe(false);
  });

  it("keeps a second step, a no and a different option apart", () => {
    expect(similarReplies("review the pr", "review the pr and merge it")).toBe(false);
    expect(similarReplies("commit and push", "commit and push and open a pr")).toBe(false);
    expect(similarReplies("run the tests", "run the tests and commit")).toBe(false);
    expect(similarReplies("merge the pr", "merge the pr and release")).toBe(false);
    expect(similarReplies("push to main", "don't push to main")).toBe(false);
    expect(similarReplies("go with option A", "go with option B")).toBe(false);
    expect(similarReplies("use approach A", "use approach B")).toBe(false);
  });

  it("keeps every answer to the agent's question, even ones that read alike", () => {
    const row = rowFor({
      state: "finished",
      config: { afterStop: [], afterDone: [], anyTime: [] },
      learned: [],
      snippets: [],
      ai: {
        status: "ready",
        replies: [
          { kind: "answer", label: "Go with option A", text: "go with option A", why: "", best: true },
          { kind: "answer", label: "Go with option B", text: "go with option B", why: "", best: false },
          { kind: "answer", label: "Push to main", text: "push to main", why: "", best: false },
          { kind: "answer", label: "Don't push to main", text: "don't push to main yet", why: "", best: false },
        ],
      },
      draft: "",
      dismissed: new Set(),
    });
    expect(row.items.map((item) => item.label)).toEqual([
      "Go with option A",
      "Go with option B",
      "Push to main",
      "Don't push to main",
    ]);
  });

  it("keeps habits typed often enough even when they extend a shorter one", () => {
    const learned = learnQuickReplies([
      ...typed("review the pr", 6),
      ...typed("review the pr and merge it", 4),
      ...typed("commit and push", 5),
      ...typed("commit and push and open a pr", 3),
    ]);
    expect(learned.map((reply) => reply.text).sort()).toEqual(
      ["commit and push", "commit and push and open a pr", "review the pr", "review the pr and merge it"].sort(),
    );
  });

  it("folds learned phrasings of one request into the one typed most", () => {
    const learned = learnQuickReplies([
      ...typed("use ask mode in bb", 9),
      ...typed("use ask mode", 4),
      ...typed("all done?", 5),
    ]);
    expect(learned.map((reply) => [reply.text, reply.count])).toEqual([
      ["use ask mode in bb", 13],
      ["all done?", 5],
    ]);
  });

  it("keeps another phrasing of a dismissed reply away", () => {
    const row = rowFor({
      state: "running",
      config: { afterStop: [], afterDone: [], anyTime: [] },
      learned: [
        { label: "Use ask mode in bb", text: "use ask mode in bb" },
        { label: "Run the tests", text: "run the tests" },
        { label: "Use ask mode", text: "use ask mode" },
      ],
      snippets: [],
      ai: { status: "idle", replies: [] },
      draft: "",
      dismissed: new Set(["use ask mode in bb"]),
    });
    expect(row.items.map((item) => item.label)).toEqual(["Run the tests"]);
  });

  it("keeps two requests whose short labels read alike", () => {
    const row = rowFor({
      state: "finished",
      config: { afterStop: [], afterDone: [], anyTime: [] },
      learned: [],
      snippets: [],
      ai: {
        status: "ready",
        replies: [
          { kind: "ai", label: "Open a PR", text: "open a pr for this branch and request review", why: "", best: true },
          { kind: "ai", label: "Open a draft PR", text: "open a draft pr so CI runs before review", why: "", best: false },
        ],
      },
      draft: "",
      dismissed: new Set(),
    });
    expect(row.items.map((item) => item.label)).toEqual(["Open a PR", "Open a draft PR"]);
  });

  it("shows one chip per idea in the row", () => {
    const row = rowFor({
      state: "running",
      config: { afterStop: [], afterDone: [], anyTime: [{ label: "Status", text: "status" }] },
      learned: [
        { label: "Continue", text: "continue" },
        { label: "Use ask mode in bb", text: "use ask mode in bb" },
        { label: "All done?", text: "all done?" },
        { label: "Use ask mode", text: "use ask mode" },
        { label: "Commit and push", text: "commit and push" },
      ],
      snippets: [],
      ai: { status: "idle", replies: [] },
      draft: "",
      dismissed: new Set(),
    });
    // The repeat drops before the row counts its four, so the next habit fills in.
    expect(row.items.map((item) => item.label)).toEqual([
      "Continue",
      "Use ask mode in bb",
      "All done?",
      "Commit and push",
      "Status",
    ]);
  });
});
