import { describe, expect, it } from "vitest";
import { extractTokens, fillTokens, hasTokens, parseTokens } from "./template";

describe("templates", () => {
  it("extracts unique tokens in order", () => {
    expect(
      extractTokens("Deploy {{service}} to {{env}} — again {{service}}"),
    ).toEqual(["service", "env"]);
    expect(extractTokens("no tokens")).toEqual([]);
    expect(extractTokens("{{ spaced token }}")).toEqual(["spaced token"]);
    expect(hasTokens("no tokens")).toBe(false);
    expect(hasTokens("one {{token}}")).toBe(true);
  });

  it("reads an inline default off the token", () => {
    expect(parseTokens("Deploy to {{env=staging}}")).toEqual([
      { name: "env", defaultValue: "staging" },
    ]);
    // The first occurrence wins, but a later one may supply a default the
    // first lacked.
    expect(parseTokens("{{env}} then {{env=prod}}")).toEqual([
      { name: "env", defaultValue: "prod" },
    ]);
  });

  it("fills provided tokens and keeps missing ones literal", () => {
    expect(fillTokens("Deploy {{service}} to {{env}}", { service: "api" })).toBe(
      "Deploy api to {{env}}",
    );
    expect(fillTokens("{{a}}/{{a}}", { a: "x" })).toBe("x/x");
  });

  it("falls back to the inline default rather than leaving braces behind", () => {
    expect(fillTokens("Deploy to {{env=staging}}", {})).toBe("Deploy to staging");
    expect(fillTokens("Deploy to {{env=staging}}", { env: "prod" })).toBe(
      "Deploy to prod",
    );
    // An explicitly blank answer still means "use the default".
    expect(fillTokens("Deploy to {{env=staging}}", { env: "" })).toBe(
      "Deploy to staging",
    );
    // With no default, a blank answer removes the placeholder.
    expect(fillTokens("Deploy to {{env}}", { env: "" })).toBe("Deploy to ");
  });
});
