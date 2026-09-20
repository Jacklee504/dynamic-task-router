import type { Command, ProcessRunner, Provider, ProviderCapabilities, WorkerRequest, WorkerResult } from "../types.js";
import { commandAvailable, ensureReadOnly, helpCommand, missingHelpFlags, resultFromProcess } from "./shared.js";

export function createClaudeCommand(request: WorkerRequest): Command {
  if (request.readOnly) ensureReadOnly(request);
  if (!request.readOnly && !request.writeBoundary) throw new Error("read-only safety: write-capable requests require an isolated write boundary");
  return {
    command: "claude",
    args: [
      "--print",
      request.prompt,
      "--model",
      request.model,
      "--effort",
      request.effort,
      // Bound turns so a looping worker cannot burn the whole wall-clock timeout.
      "--max-turns",
      "80",
      "--output-format",
      "json",
      "--permission-mode",
      request.readOnly ? "plan" : "acceptEdits",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--setting-sources",
      "user",
    ],
  };
}

export class ClaudeProvider implements Provider {
  readonly id = "claude" as const;

  constructor(private readonly runner: ProcessRunner) {}

  async health(): Promise<boolean> {
    if (!(await commandAvailable(this.runner, "claude"))) return false;
    const [auth, help] = await Promise.all([
      this.runner.run({ command: "claude", args: ["auth", "status"] }, { cwd: process.cwd(), timeoutMs: 5_000 }),
      this.runner.run(helpCommand("claude"), { cwd: process.cwd(), timeoutMs: 5_000 }),
    ]);
    return auth.exitCode === 0 && help.exitCode === 0 && missingHelpFlags(help, ["--permission-mode", "--max-turns"]).length === 0;
  }

  capabilities(): ProviderCapabilities {
    return {
      workspaceRead: true,
      workspaceSearch: true,
      shellAccess: true,
      nativeTextAttachments: false,
      nativeImageAttachments: false,
      verifiedReadOnlyExecution: true,
      worktreeScopedWrite: false,
    };
  }

  async run(request: WorkerRequest): Promise<WorkerResult> {
    if (request.readOnly) ensureReadOnly(request);
    const help = await this.runner.run(helpCommand("claude"), { cwd: request.cwd, timeoutMs: 5_000 });
    if (help.exitCode !== 0 || missingHelpFlags(help, ["--permission-mode", "--max-turns"]).length > 0) {
      return unsupportedResult(request, `Claude CLI lacks --permission-mode ${request.readOnly ? "plan" : "acceptEdits"}; refusing to run without required read-only enforcement or write isolation.`);
    }
    const startedAt = Date.now();
    const result = await this.runner.run(createClaudeCommand(request), {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    return resultFromProcess(this.id, request, startedAt, result);
  }
}

function unsupportedResult(request: WorkerRequest, error: string): WorkerResult {
  return {
    provider: "claude",
    model: request.model,
    requestedEffort: request.effort,
    output: "",
    success: false,
    durationMs: 0,
    error,
  };
}
