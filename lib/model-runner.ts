// AI quick replies: how one prompt reaches a model.
//
// The fast path is the provider's own CLI, run headless with no tools and no
// saved session: `claude -p` for Claude Code, `codex exec` for Codex. It only
// works where that CLI is logged in. bb's Account Pooler, for one, routes bb
// threads and not a CLI the plugin starts, so a CLI that fails falls back to
// a hidden bb thread on the same provider, which gets bb's own auth. A CLI
// that failed stays skipped for a while instead of failing every turn.

import type { ModelRequest } from "./ai-service";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface ExecOptions {
  input: string;
  cwd: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export interface RunnerDeps {
  /** Run a command line through a login shell, so the CLI is on PATH. */
  exec(commandLine: string, options: ExecOptions): Promise<ExecResult>;
  /** Ask through a hidden bb thread on the request's provider. */
  hidden(request: ModelRequest, signal: AbortSignal): Promise<string>;
  readFile(path: string): Promise<string>;
  removeFile(path: string): Promise<void>;
  tmpdir: string;
  env: Record<string, string | undefined>;
  log: { info(message: string): void; warn(message: string): void };
  now?: () => number;
}

/** A CLI that failed is skipped this long before it is tried again. */
export const CLI_RETRY_MS = 30 * 60_000;

const SAFE_ARG = /^[\w.:/@-]+$/;

/**
 * The environment for a CLI the plugin starts: the user's own, minus the
 * variables an agent session sets to point a child `claude` at the session's
 * proxy, where it reports "Not logged in".
 */
export function cliEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|_CLAUDE_CODE_|CLAUDECODE$|CLAUDE_AGENT_SDK)/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** The headless CLI command line for a provider, or null when it has none. */
export function cliCommand(
  providerId: string,
  model: string | null,
  reasoningLevel: string | null,
  outputFile: string,
): string | null {
  if (model !== null && !SAFE_ARG.test(model)) return null;
  if (providerId === "claude-code")
    return [
      "claude -p",
      model ? `--model ${model}` : "",
      "--no-session-persistence --tools '' --strict-mcp-config --setting-sources ''",
      "--disable-slash-commands --output-format text",
    ]
      .filter(Boolean)
      .join(" ");
  if (providerId === "codex") {
    if (!SAFE_ARG.test(outputFile)) return null;
    const effort =
      reasoningLevel && SAFE_ARG.test(reasoningLevel)
        ? ` -c 'model_reasoning_effort="${reasoningLevel}"'`
        : "";
    return (
      `codex exec --ephemeral --skip-git-repo-check -s read-only --color never` +
      (model ? ` -m ${model}` : "") +
      effort +
      ` -o ${outputFile} -`
    );
  }
  return null;
}

export function createModelRunner(deps: RunnerDeps) {
  const now = deps.now ?? Date.now;
  const skipUntil = new Map<string, number>();
  let counter = 0;

  async function viaCli(request: ModelRequest, signal: AbortSignal): Promise<string | null> {
    if ((skipUntil.get(request.providerId) ?? 0) > now()) return null;
    counter += 1;
    const outputFile = `${deps.tmpdir}/bb-quick-replies-${process.pid}-${counter}.txt`;
    const command = cliCommand(request.providerId, request.model, request.reasoningLevel, outputFile);
    if (command === null) return null;
    try {
      const result = await deps.exec(command, {
        input: request.prompt,
        cwd: deps.tmpdir,
        env: cliEnv(deps.env),
        signal,
      });
      if (signal.aborted) throw new Error("aborted");
      const text =
        request.providerId === "codex"
          ? await deps.readFile(outputFile).catch(() => "")
          : result.stdout;
      if (result.code === 0 && text.trim()) return text;
      const detail = `${result.stderr} ${result.stdout}`.replace(/\s+/g, " ").trim().slice(0, 200);
      throw new Error(detail || `exited with ${result.code}`);
    } catch (error) {
      if (signal.aborted) throw error;
      skipUntil.set(request.providerId, now() + CLI_RETRY_MS);
      deps.log.warn(
        `quick replies: the ${request.providerId} CLI did not answer, using a hidden bb thread ` +
          `for the next ${CLI_RETRY_MS / 60_000} minutes (${error instanceof Error ? error.message : String(error)})`,
      );
      return null;
    } finally {
      if (request.providerId === "codex") void deps.removeFile(outputFile).catch(() => {});
    }
  }

  return async function run(request: ModelRequest, signal: AbortSignal): Promise<string> {
    const fromCli = await viaCli(request, signal);
    if (fromCli !== null) return fromCli;
    return deps.hidden(request, signal);
  };
}
