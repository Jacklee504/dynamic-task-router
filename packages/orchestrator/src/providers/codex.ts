import type { Command, ProcessRunner, Provider, ProviderCapabilities, WorkerRequest, WorkerResult } from "../types.js";
import { ensureReadOnly, missingHelpFlags, resolveCodexCommand, resultFromProcess } from "./shared.js";

export function createCodexCommand(request: WorkerRequest, executable = "codex"): Command {
  if (request.readOnly) ensureReadOnly(request);
  if (!request.readOnly && !request.writeBoundary) throw new Error("read-only safety: write-capable requests require an isolated write boundary");
  return {
    command: executable,
    args: [
      "exec",
      "--cd",
      request.cwd,
      "--skip-git-repo-check",
      "--model",
      request.model,
      "--sandbox",
      request.readOnly ? "read-only" : "workspace-write",
      "--ephemeral",
      "--json",
      "-c",
      `model_reasoning_effort=${request.effort}`,
      request.prompt,
    ],
  };
}

export class CodexProvider implements Provider {
  readonly id = "codex" as const;

  constructor(private readonly runner: ProcessRunner) {}

  async health(): Promise<boolean> {
    return Boolean(await resolveCodexCommand(this.runner, process.cwd(), undefined, true));
  }

  capabilities(): ProviderCapabilities {
    return {
      workspaceRead: true,
      workspaceSearch: true,
      shellAccess: true,
      nativeTextAttachments: true,
      nativeImageAttachments: false,
      verifiedReadOnlyExecution: true,
      worktreeScopedWrite: true,
    };
  }

  async run(request: WorkerRequest): Promise<WorkerResult> {
    if (request.readOnly) ensureReadOnly(request);
    const executable = await resolveCodexCommand(this.runner, request.cwd, undefined, true);
    if (!executable) return unsupportedResult(request, "Codex CLI is unavailable or not authenticated; no fallback provider was selected.");
    const help = await this.runner.run({ command: executable, args: ["exec", "--help"] }, { cwd: request.cwd, timeoutMs: 5_000 });
    const requiredFlags = ["--cd", "--skip-git-repo-check", "--model", "--sandbox", "--ephemeral", "--json"];
    if (help.exitCode !== 0 || missingHelpFlags(help, requiredFlags).length > 0) {
      return unsupportedResult(request, `Codex CLI lacks a required ${request.readOnly ? "read-only" : "workspace-write"} isolation option; refusing to run.`);
    }
    const startedAt = Date.now();
    const result = await this.runner.run(createCodexCommand(request, executable), {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    return resultFromProcess(this.id, request, startedAt, result);
  }
}

function unsupportedResult(request: WorkerRequest, error: string): WorkerResult {
  return {
    provider: "codex",
    model: request.model,
    requestedEffort: request.effort,
    output: "",
    success: false,
    durationMs: 0,
    error,
  };
}
