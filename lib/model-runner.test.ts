import { describe, expect, it } from "vitest";
import type { ModelRequest } from "./ai-service";
import { cliCommand, cliEnv, createModelRunner, CLI_RETRY_MS, type ExecResult } from "./model-runner";

const request = (providerId: string, model: string | null = "small-1"): ModelRequest => ({
  providerId,
  model,
  reasoningLevel: "low",
  prompt: "suggest replies",
  thread: { id: "thr_demo", providerId, projectId: "proj_demo", environmentId: "env_demo", title: null },
});

function setup(exec: (line: string) => ExecResult) {
  let clock = 0;
  const lines: string[] = [];
  const hidden: ModelRequest[] = [];
  const files = new Map<string, string>();
  const run = createModelRunner({
    exec: async (line, options) => {
      lines.push(line);
      expect(options.input).toBe("suggest replies");
      const result = exec(line);
      const out = / -o (\S+) -$/.exec(line)?.[1];
      if (out) files.set(out, result.stdout);
      return result;
    },
    hidden: async (req) => {
      hidden.push(req);
      return "from a hidden thread";
    },
    readFile: async (path) => files.get(path) ?? "",
    removeFile: async (path) => {
      files.delete(path);
    },
    tmpdir: "/tmp/demo",
    env: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "http://proxy", CLAUDE_CODE_SESSION_ID: "x", HOME: "/home/demo" },
    log: { info: () => {}, warn: () => {} },
    now: () => clock,
  });
  return { run, lines, hidden, advance: (ms: number) => (clock += ms) };
}

const signal = () => new AbortController().signal;

describe("cliCommand", () => {
  it("runs Claude Code headless with no tools and no saved session", () => {
    expect(cliCommand("claude-code", "claude-haiku-5-5", null, "/tmp/out")).toBe(
      "claude -p --model claude-haiku-5-5 --no-session-persistence --tools '' --strict-mcp-config --setting-sources '' --disable-slash-commands --output-format text",
    );
  });

  it("runs Codex ephemeral and read-only at the lightest effort", () => {
    expect(cliCommand("codex", "gpt-6-luna", "low", "/tmp/out.txt")).toBe(
      "codex exec --ephemeral --skip-git-repo-check -s read-only --color never -m gpt-6-luna -c 'model_reasoning_effort=\"low\"' -o /tmp/out.txt -",
    );
  });

  it("has no CLI for other providers or unsafe model ids", () => {
    expect(cliCommand("acme", "m", null, "/tmp/out")).toBeNull();
    expect(cliCommand("claude-code", "x; rm -rf ~", null, "/tmp/out")).toBeNull();
  });

  it("strips an agent session's Claude variables from the CLI's environment", () => {
    expect(cliEnv({ PATH: "/usr/bin", ANTHROPIC_BASE_URL: "x", CLAUDE_CODE_SESSION_ID: "y", CLAUDECODE: "1" })).toEqual({
      PATH: "/usr/bin",
    });
  });
});

describe("createModelRunner", () => {
  it("answers from the Claude CLI when it is logged in", async () => {
    const { run, hidden } = setup(() => ({ stdout: '{"replies":[]}', stderr: "", code: 0 }));
    expect(await run(request("claude-code"), signal())).toBe('{"replies":[]}');
    expect(hidden).toHaveLength(0);
  });

  it("reads Codex's answer from its output file", async () => {
    const { run, lines } = setup(() => ({ stdout: "codex says hi", stderr: "", code: 0 }));
    expect(await run(request("codex"), signal())).toBe("codex says hi");
    expect(lines[0]).toContain("codex exec");
  });

  it("falls back to a hidden thread when the CLI is not logged in, and skips the CLI for a while", async () => {
    const { run, hidden, lines, advance } = setup(() => ({
      stdout: "",
      stderr: "Failed to authenticate. Run claude auth login",
      code: 1,
    }));
    expect(await run(request("claude-code"), signal())).toBe("from a hidden thread");
    expect(await run(request("claude-code"), signal())).toBe("from a hidden thread");
    expect(lines).toHaveLength(1);
    advance(CLI_RETRY_MS + 1);
    await run(request("claude-code"), signal());
    expect(lines).toHaveLength(2);
    expect(hidden).toHaveLength(3);
  });

  it("goes straight to a hidden thread for a provider without a CLI", async () => {
    const { run, hidden, lines } = setup(() => ({ stdout: "", stderr: "", code: 0 }));
    expect(await run(request("acme"), signal())).toBe("from a hidden thread");
    expect(lines).toHaveLength(0);
    expect(hidden).toHaveLength(1);
  });
});
