import { describe, expect, it } from "vitest";
import { isReplyTopic, REPLY_TOPICS, topicOf } from "./reply-topics";

describe("topicOf", () => {
  it.each([
    ["continue", "continue"],
    ["keep going", "continue"],
    ["use ask mode in bb", "ask"],
    ["all done?", "done"],
    ["status", "status"],
    ["progress?", "status"],
    ["where are we", "status"],
    ["run the tests", "test"],
    ["fix the date parser", "fix"],
    ["fix the error in the parser", "fix"],
    ["throw a descriptive error", "error"],
    ["commit and push", "commit"],
    ["open a pr for this branch", "pr"],
    ["ship the build", "release"],
    ["write the docs", "docs"],
    ["explain why it failed", "explain"],
    ["show me a screenshot", "visual"],
    ["revert the last change", "undo"],
    ["don't push to main", "no"],
    ["yes, ship it", "release"],
    ["sounds good", "yes"],
  ])("reads %j as %s", (text, topic) => {
    expect(topicOf(text)).toBe(topic);
  });

  it("names no topic when no rule fits", () => {
    expect(topicOf("return a result object with the reason")).toBeNull();
    expect(topicOf("")).toBeNull();
  });

  it("matches whole words only", () => {
    expect(topicOf("now what")).toBeNull();
    expect(topicOf("latest")).toBeNull();
  });
});

describe("isReplyTopic", () => {
  it("accepts only the listed topics", () => {
    for (const topic of REPLY_TOPICS) expect(isReplyTopic(topic)).toBe(true);
    expect(isReplyTopic("rocket")).toBe(false);
    expect(isReplyTopic(null)).toBe(false);
  });
});
