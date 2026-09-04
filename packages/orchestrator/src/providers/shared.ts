import type { Command, ProcessRunner, TokenUsage, WorkerRequest, WorkerResult } from "../types.js";
import { truncateTaskResult } from "../contracts.js";

export async function commandAvailable(runner: ProcessRunner, command: string, cwd = process.cwd()): Promise<boolean> {
  const result = await runner.run({ command, args: ["--version"] }, { cwd, timeoutMs: 5_000 });
  return result.exitCode === 0;
}

const macosCodexBinaries = ["/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex"];

export function codexCommandCandidates(): string[] {
  const configured = process.env.DTR_CODEX_COMMAND?.trim();
  return [...new Set([configured, "codex", ...(process.platform === "darwin" ? macosCodexBinaries : [])].filter((value): value is string => Boolean(value)))];
}

export async function resolveCodexCommand(runner: ProcessRunner, cwd: string, candidates = codexCommandCandidates(), requireLogin = false): Promise<string | undefined> {
  for (const command of candidates) {
    if (!(await commandAvailable(runner, command, cwd))) continue;
    if (!requireLogin) return command;
    const login = await runner.run({ command, args: ["login", "status"] }, { cwd, timeoutMs: 5_000 });
    if (login.exitCode === 0) return command;
  }
  return undefined;
}

export function resultFromProcess(
  provider: WorkerResult["provider"],
  request: WorkerRequest,
  startedAt: number,
  process: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; error?: string },
): WorkerResult {
  const error = process.timedOut
    ? "Worker timed out"
    : process.error ?? (process.exitCode === 0 ? undefined : process.stderr.trim() || `Process exited with ${process.exitCode}`);
  const parsed = parseProviderOutput(provider, process.stdout);
  return {
    provider,
    model: request.model,
    requestedEffort: request.effort,
    effectiveEffort: request.effort,
    output: truncateTaskResult(parsed.output),
    success: !error,
    durationMs: Date.now() - startedAt,
    ...(error ? { error } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
  };
}

function parseProviderOutput(provider: WorkerResult["provider"], stdout: string): { output: string; usage?: TokenUsage } {
  if (provider === "claude") return parseClaudeOutput(stdout);
  if (provider === "codex" || provider === "ollama") return parseCodexEvents(stdout);
  if (provider === "antigravity") return parseAntigravityOutput(stdout);
  return { output: stdout };
}

function parseAntigravityOutput(stdout: string): { output: string; usage?: TokenUsage } {
  const value = parseJson(stdout);
  if (!isRecord(value)) return { output: stdout };
  const message = isRecord(value.message) ? value.message : undefined;
  const output = typeof value.result === "string" ? value.result
    : typeof value.text === "string" ? value.text
      : typeof value.response === "string" ? value.response
        : typeof message?.content === "string" ? message.content
          : stdout;
  const usage = usageFrom(value.usage);
  return { output, ...(usage ? { usage } : {}) };
}

function parseClaudeOutput(stdout: string): { output: string; usage?: TokenUsage } {
  const value = parseJson(stdout);
  if (!isRecord(value)) return { output: stdout };
  const output = typeof value.result === "string" ? value.result : stdout;
  const usage = usageFrom(value.usage, numberAt(value, "total_cost_usd"));
  return { output, ...(usage ? { usage } : {}) };
}

function parseCodexEvents(stdout: string): { output: string; usage?: TokenUsage } {
  const events = stdout.split("\n").map(parseJson).filter(isRecord);
  if (!events.length) return { output: stdout };
  const messages = events.flatMap((event) => {
    const item = isRecord(event.item) ? event.item : undefined;
    return item?.type === "agent_message" && typeof item.text === "string" ? [item.text] : [];
  });
  const final = [...events].reverse().map((event) => usageFrom(event.usage)).find((usage): usage is TokenUsage => Boolean(usage));
  return { output: messages.at(-1) ?? stdout, ...(final ? { usage: final } : {}) };
}

function usageFrom(value: unknown, costUsd?: number): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberAt(value, "input_tokens", "inputTokens");
  const cachedInputTokens = numberAt(value, "cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens");
  const outputTokens = numberAt(value, "output_tokens", "outputTokens");
  const reasoningTokens = numberAt(value, "reasoning_tokens", "reasoningTokens");
  const totalTokens = numberAt(value, "total_tokens", "totalTokens") ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens, costUsd].every((item) => item === undefined)) return undefined;
  return { source: "provider-reported", ...(inputTokens !== undefined ? { inputTokens } : {}), ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(reasoningTokens !== undefined ? { reasoningTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}

function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return undefined; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function numberAt(value: Record<string, unknown>, ...keys: string[]): number | undefined { for (const key of keys) if (typeof value[key] === "number") return value[key]; return undefined; }

export function ensureReadOnly(request: WorkerRequest): void {
  if (!request.readOnly) {
    throw new Error("Phase 1 supports read-only workers only");
  }
}

export function helpCommand(command: string): Command {
  return { command, args: ["--help"] };
}
