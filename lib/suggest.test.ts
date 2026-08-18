import { describe, expect, it } from "vitest";
import {
  clusterPrompts,
  isMachinePrompt,
  keywordsFor,
  normalize,
  similarity,
  stripFiller,
  suggestSnippets,
  suggestionKey,
  templateFromVariants,
  titleFor,
  type HistoryPrompt,
} from "./suggest";

function history(...entries: (string | [string, number])[]): HistoryPrompt[] {
  return entries.map((entry, index) =>
    typeof entry === "string"
      ? { text: entry, createdAt: 1_000 + index }
      : { text: entry[0], createdAt: entry[1] },
  );
}

describe("isMachinePrompt", () => {
  it("rejects role-framed prompts other plugins inject", () => {
    expect(isMachinePrompt("You are Agent B in a structured debate")).toBe(true);
    expect(isMachinePrompt("You rewrite rough draft prompts into clear ones")).toBe(
      true,
    );
    expect(isMachinePrompt("You are a quick delegated worker for a live session")).toBe(
      true,
    );
  });

  it("rejects prompts carrying bb-generated ids or directives", () => {
    expect(isMachinePrompt("[BB workflow release-ship · run wfr_0f1e2d3c]")).toBe(true);
    expect(isMachinePrompt("Continue from @thread:thr_a1b2c3d4e5 and redesign")).toBe(
      true,
    );
    expect(isMachinePrompt("close the turn with ::flair{text=hi}")).toBe(true);
    expect(isMachinePrompt("Round 2 of 2. The other agents' positions follow.")).toBe(
      true,
    );
  });

  it("keeps prompts a human typed", () => {
    expect(isMachinePrompt("commit, push, open pr, tag pr with manual-review")).toBe(
      false,
    );
    expect(isMachinePrompt("You should see the sidebar lag when scrolling")).toBe(true);
    expect(isMachinePrompt("the sidebar lags when scrolling, speed it up")).toBe(false);
  });
});

describe("normalize / stripFiller", () => {
  it("folds punctuation and case", () => {
    expect(normalize("Commit, push — open a PR!")).toBe("commit push open a pr");
  });

  it("drops fenced code, which is never the reusable part", () => {
    expect(normalize("fix this:\n```js\nconst a = 1\n```\nplease")).toBe(
      "fix this please",
    );
  });

  it("sheds leading filler so 'also X' clusters with 'X'", () => {
    expect(stripFiller("also commit and push")).toBe("commit and push");
    expect(stripFiller("ok can we commit and push")).toBe("commit and push");
    expect(stripFiller("commit and push")).toBe("commit and push");
  });

  it("never strips a prompt down to nothing", () => {
    expect(stripFiller("please")).toBe("please");
  });
});

describe("similarity", () => {
  it("matches typo'd retypings of the same prompt", () => {
    expect(similarity(normalize("continue"), normalize("conitnue"))).toBeGreaterThan(
      0.62,
    );
    expect(
      similarity(normalize("fix all issues and do all followups"), normalize("fic all issues and do all followupd")),
    ).toBeGreaterThan(0.62);
  });

  it("keeps genuinely different prompts apart", () => {
    expect(
      similarity(normalize("commit and push"), normalize("give me 20 design variants")),
    ).toBeLessThan(0.62);
  });
});

describe("templateFromVariants", () => {
  it("turns the one slot that varies into a named fill-in", () => {
    const { body, tokens } = templateFromVariants([
      "Audit the existing Handoff plugin and polish it comprehensively",
      "Audit the existing Flair plugin and polish it comprehensively",
      "Audit the existing Enhance Prompt plugin and polish it comprehensively",
    ]);
    expect(body).toBe(
      "Audit the existing {{plugin}} plugin and polish it comprehensively",
    );
    expect(tokens).toEqual(["plugin"]);
  });

  it("names the token from surrounding words, not the slot contents", () => {
    const { body } = templateFromVariants([
      "give me 10 design variants",
      "give me 20 design variants",
    ]);
    expect(body).toBe("give me {{design}} design variants");
  });

  it("leaves the body alone when the wording does not line up", () => {
    const variants = [
      "commit and push when done",
      "commit push and archive this thread when everything is verified",
    ];
    expect(templateFromVariants(variants).tokens).toEqual([]);
  });

  it("refuses to template a slot that runs on for half the prompt", () => {
    const { body, tokens } = templateFromVariants([
      "fix all issues and do all followups for this and improve this plugin",
      "fix all issues and do all followups for this and improve this plugin, then demo it for me here in this chat nicely",
    ]);
    expect(tokens).toEqual([]);
    expect(body).not.toContain("{{");
  });

  it("leaves the body alone when a variant has an empty slot", () => {
    const { tokens } = templateFromVariants([
      "polish the plugin",
      "polish the flair plugin",
    ]);
    expect(tokens).toEqual([]);
  });

  it("returns a single variant untouched", () => {
    const { body, tokens } = templateFromVariants(["commit and push"]);
    expect(body).toBe("commit and push");
    expect(tokens).toEqual([]);
  });
});

describe("titleFor", () => {
  it("capitalises, and keeps comma-joined steps whole", () => {
    expect(titleFor("commit and push, then archive this thread")).toBe(
      "Commit and push, then archive this thread",
    );
  });

  it("cuts at the first sentence when there is one", () => {
    expect(titleFor("Commit and push. Then archive this thread.")).toBe(
      "Commit and push.",
    );
  });

  it("drops filler and fill-in braces", () => {
    expect(titleFor("also audit the existing {{plugin}} plugin")).toBe(
      "Audit the existing plugin plugin",
    );
  });

  it("truncates long prompts on a word boundary", () => {
    const title = titleFor(
      "fix all issues and do all follow-ups for this and then enhance and polish and improve this plugin",
    );
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });
});

describe("keywordsFor", () => {
  it("picks distinctive words and skips stopwords", () => {
    const keywords = keywordsFor([
      "commit and push and open a pr",
      "commit and push the branch",
    ]).split(" ");
    expect(keywords).toContain("commit");
    expect(keywords).toContain("push");
    expect(keywords).not.toContain("and");
  });
});

describe("clusterPrompts", () => {
  it("folds typo'd retypings into one cluster", async () => {
    const clusters = await clusterPrompts(
      history("continue", "conitnue", "give me 20 design variants"),
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0].members).toHaveLength(2);
  });
});

describe("suggestSnippets", () => {
  const shipping = "commit, push, open pr, tag pr with manual-review label, /pr-monitor";

  it("proposes a prompt that was retyped, with its count", async () => {
    const { suggestions } = await suggestSnippets({
      history: history(shipping, shipping, "one off thing that never comes back again"),
    });
    const suggestion = suggestions[0]!;
    expect(suggestion.count).toBe(2);
    expect(suggestion.body).toBe(shipping);
    expect(suggestion.title).toBe("Commit, push, open pr, tag pr with manual-review label…");
  });

  it("ignores reflex prompts that are faster to retype than to pick", async () => {
    const { suggestions } = await suggestSnippets({
      history: history(...Array<string>(97).fill("continue")),
    });
    expect(suggestions).toEqual([]);
  });

  it("ignores one-offs and machine-written prompts", async () => {
    const { suggestions } = await suggestSnippets({
      history: history(
        "a unique prompt that is long enough to qualify but typed once",
        "You are Agent A in a structured debate between 2 AI agents",
        "You are Agent A in a structured debate between 2 AI agents",
      ),
    });
    expect(suggestions).toEqual([]);
  });

  it("suppresses proposals an existing snippet already covers", async () => {
    const { suggestions } = await suggestSnippets({
      history: history(shipping, shipping),
      existingBodies: ["Commit, open a PR, tag the PR with the manual-review label"],
    });
    expect(suggestions).toEqual([]);
  });

  it("suppresses dismissed proposals by stable key", async () => {
    const first = await suggestSnippets({ history: history(shipping, shipping) });
    const after = await suggestSnippets({
      history: history(shipping, shipping),
      dismissedKeys: [first.suggestions[0]!.key],
    });
    expect(after.suggestions).toEqual([]);
  });

  it("keys are stable across recomputes and insensitive to case and punctuation", () => {
    expect(suggestionKey("Commit and push!")).toBe(suggestionKey("commit  and push"));
  });

  it("templates a varying slot and ranks templated clusters above flat ones", async () => {
    const { suggestions } = await suggestSnippets({
      history: history(
        "Audit the existing Handoff plugin and polish it comprehensively",
        "Audit the existing Flair plugin and polish it comprehensively",
        shipping,
        shipping,
      ),
    });
    expect(suggestions[0].tokens).toEqual(["plugin"]);
    expect(suggestions[0].body).toContain("{{plugin}}");
    expect(suggestions[0].variants).toHaveLength(2);
    expect(suggestions[1].body).toBe(shipping);
  });

  it("ranks by how often a prompt was retyped", async () => {
    const { suggestions } = await suggestSnippets({
      history: history(
        shipping,
        shipping,
        shipping,
        "give me 20 design variants, different approaches, use shadcn skills",
        "give me 20 design variants, different approaches, use shadcn skills",
      ),
    });
    expect(suggestions.map((suggestion) => suggestion.count)).toEqual([3, 2]);
  });

  it("folds near-identical phrasings into one proposal, not many", async () => {
    const entries = Array.from({ length: 6 }, (_, index) => [
      `a recurring workflow prompt number ${index} to run`,
      `a recurring workflow prompt number ${index} to run`,
    ]).flat();
    const { suggestions } = await suggestSnippets({ history: history(...entries) });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].count).toBe(12);
  });

  it("honours the limit", async () => {
    const entries = [
      "commit and push, then archive this bb thread when done",
      "give me 20 design variants, different approaches, use shadcn skills",
      "fix all issues and do all the follow-ups, then demo it here in chat",
      "suggest more ideas, in a numbered list, to make this plugin better",
    ].flatMap((text) => [text, text]);
    const { suggestions } = await suggestSnippets({
      history: history(...entries),
      limit: 3,
    });
    expect(suggestions).toHaveLength(3);
  });
});

describe("scale", () => {
  /**
   * The length-window index is a speedup, not a different answer: anything it
   * skips scores 0 anyway. Prove it on a corpus with a wide length spread.
   */
  it("clusters the same way the exhaustive scan would", async () => {
    const texts: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const filler = "x".repeat((i % 12) * 7);
      texts.push(`recurring workflow number ${i} ${filler}`.trim());
      texts.push(`recurring workflow number ${i} ${filler}`.trim());
    }
    texts.push("commit, push, open pr, tag it with the review label");
    texts.push("commit push open pr and tag it with the review label");

    const clusters = await clusterPrompts(history(...texts), undefined, {
      yieldEvery: 7,
    });
    const exhaustive = await clusterPrompts(history(...texts), undefined, {
      yieldEvery: 0,
    });
    expect(clusters.map((cluster) => cluster.members.length)).toEqual(
      exhaustive.map((cluster) => cluster.members.length),
    );
    // The two phrasings of the shipping prompt folded together.
    expect(clusters.some((cluster) => cluster.members.length === 2)).toBe(true);
  });

  it("clusters only the newest candidates and reports what it skipped", async () => {
    const entries: [string, number][] = [];
    for (let i = 0; i < 30; i += 1) {
      const text = `audit the old subsystem number ${i} and write up findings`;
      entries.push([text, 1_000 + i], [text, 1_500 + i]);
    }
    for (let j = 0; j < 5; j += 1) {
      const text = `ship the release checklist variant ${j} and tag the build`;
      entries.push([text, 9_000 + j], [text, 9_500 + j]);
    }
    const result = await suggestSnippets({
      history: history(...entries),
      maxCandidates: 10,
    });
    expect(result.analyzed).toBe(70);
    expect(result.considered).toBe(10);
    expect(result.dropped).toBe(60);
    // Newest-first: only the recent prompts reach the clusterer.
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(
      result.suggestions.every((suggestion) =>
        suggestion.body.includes("release checklist"),
      ),
    ).toBe(true);
  });

  it("stays responsive: a big corpus yields to the event loop", async () => {
    const texts = Array.from(
      { length: 900 },
      (_, index) => `distinct workflow prompt ${index} with enough words to qualify`,
    );
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 1);
    await clusterPrompts(history(...texts), undefined, { yieldEvery: 50 });
    clearInterval(interval);
    expect(ticks).toBeGreaterThan(0);
  });
});
