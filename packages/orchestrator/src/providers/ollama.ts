import type { Command, ProcessRunner, Provider, ProviderCapabilities, WorkerRequest, WorkerResult } from "../types.js";
import { ensureReadOnly, missingHelpFlags, resolveCodexCommand, resultFromProcess } from "./shared.js";

export function createOllamaCommand(request: WorkerRequest, executable = "codex"): Command {
  ensureReadOnly(request);
  return {
    command: executable,
    args: [
      "exec",
      "--oss",
      "--local-provider",
      "ollama",
      "--model",
      request.model,
      "--cd",
      request.cwd,
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--json",
      "-c",
      `model_reasoning_effort=${request.effort}`,
      request.prompt,
    ],
  };
}

export class OllamaProvider implements Provider {
  readonly id = "ollama" as const;

  constructor(private readonly runner: ProcessRunner) {}

  async health(): Promise<boolean> {
    const result = await this.runner.run({ command: "ollama", args: ["list"] }, { cwd: process.cwd(), timeoutMs: 5_000 });
    return result.exitCode === 0;
  }

  async isModelAvailable(model: string, cwd = process.cwd()): Promise<boolean> {
    const result = await this.runner.run({ command: "ollama", args: ["list"] }, { cwd, timeoutMs: 5_000 });
    if (result.exitCode !== 0) return false;
    return result.stdout.split("\n").some((line) => line.trim().split(/\s+/)[0] === model);
  }

  capabilities(): ProviderCapabilities {
    return {
      workspaceRead: true,
      workspaceSearch: true,
      shellAccess: true,
      nativeTextAttachments: true,
      nativeImageAttachments: false,
      verifiedReadOnlyExecution: true,
      worktreeScopedWrite: false,
    };
  }

  async run(request: WorkerRequest): Promise<WorkerResult> {
    if (!request.readOnly) return unavailableResult(request, "Ollama write workers are unsupported; use a configured write-capable provider.");
    ensureReadOnly(request);
    if (!(await this.isModelAvailable(request.model, request.cwd))) {
      return unavailableResult(request, `Ollama model '${request.model}' is not installed or the server is unavailable. No model was pulled.`);
    }
    const executable = await resolveCodexCommand(this.runner, request.cwd);
    if (!executable) {
      return unavailableResult(request, "Codex CLI is unavailable; Ollama runs require Codex OSS mode in Phase 1.");
    }
    const help = await this.runner.run({ command: executable, args: ["exec", "--help"] }, { cwd: request.cwd, timeoutMs: 5_000 });
    const requiredFlags = ["--oss", "--local-provider", "--sandbox", "--ephemeral", "--json"];
    if (help.exitCode !== 0 || missingHelpFlags(help, requiredFlags).length > 0) {
      return unavailableResult(request, "Codex CLI lacks a required OSS/read-only option; refusing to run.");
    }
    const startedAt = Date.now();
    const result = await this.runner.run(createOllamaCommand(request, executable), {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    return resultFromProcess(this.id, request, startedAt, result);
  }
}

function unavailableResult(request: WorkerRequest, error: string): WorkerResult {
  return {
    provider: "ollama",
    model: request.model,
    requestedEffort: request.effort,
    output: "",
    success: false,
    durationMs: 0,
    error,
  };
}
