import type { Command, ProcessRunner, Provider, ProviderCapabilities, WorkerRequest, WorkerResult } from "../types.js";
import { commandAvailable, missingHelpFlags, resultFromProcess } from "./shared.js";

/**
 * Google Antigravity is an account-backed local CLI, not a Gemini API adapter.
 * The selected slug already includes its native thinking level (for example,
 * gemini-3.8-flash-medium), so DTR intentionally does not pass --effort.
 */
export function antigravityCommandCandidates(): string[] {
  const configured = process.env.DTR_ANTIGRAVITY_COMMAND?.trim();
  return [...new Set([configured, "agy"].filter((value): value is string => Boolean(value)))];
}

export function createAntigravityCommand(request: WorkerRequest, executable = "agy"): Command {
  const advisory = request.readOnly
    ? "Read-only advisory task: inspect only. Do not edit, create, delete, stage, commit, or run destructive commands. Return the compact handoff."
    : "Work only inside the declared boundary and return the compact handoff.";
  const timeoutMinutes = Math.max(1, Math.ceil((request.timeoutMs ?? 600_000) / 60_000));
  return {
    command: executable,
    args: ["-p", `${advisory}\n\n${request.prompt}`, "--model", request.model, "--output-format", "json", "--print-timeout", `${timeoutMinutes}m`, "--sandbox"],
  };
}

export class AntigravityProvider implements Provider {
  readonly id = "antigravity" as const;

  constructor(private readonly runner: ProcessRunner) {}

  async health(): Promise<boolean> {
    return (await this.availableModels(process.cwd())) !== undefined;
  }

  /** Agy exposes the account-specific catalogue locally; never hard-code access. */
  async availableModels(cwd: string): Promise<Set<string> | undefined> {
    const executable = await resolveAntigravityCommand(this.runner, cwd);
    if (!executable) return undefined;
    const result = await this.runner.run({ command: executable, args: ["models"] }, { cwd, timeoutMs: 10_000 });
    if (result.exitCode !== 0) return undefined;
    const models = new Set(result.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((value): value is string => typeof value === "string" && value.length > 0 && !value.startsWith("#")));
    return models.size ? models : undefined;
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
    const executable = await resolveAntigravityCommand(this.runner, request.cwd);
    if (!executable) return unsupported(request, "Antigravity CLI is unavailable. Start `agy` once to sign in, then ensure `agy` is on PATH or set DTR_ANTIGRAVITY_COMMAND.");
    const help = await this.runner.run({ command: executable, args: ["--help"] }, { cwd: request.cwd, timeoutMs: 5_000 });
    const requiredFlags = ["--model", "--output-format", "--print-timeout", "--sandbox"];
    if (help.exitCode !== 0 || missingHelpFlags(help, requiredFlags).length > 0) {
      return unsupported(request, "Antigravity CLI lacks a required isolated headless option; refusing to run.");
    }
    const startedAt = Date.now();
    const result = await this.runner.run(createAntigravityCommand(request, executable), { cwd: request.cwd, timeoutMs: request.timeoutMs, signal: request.signal });
    return resultFromProcess(this.id, request, startedAt, result);
  }
}

async function resolveAntigravityCommand(runner: ProcessRunner, cwd: string): Promise<string | undefined> {
  for (const command of antigravityCommandCandidates()) if (await commandAvailable(runner, command, cwd)) return command;
  return undefined;
}

function unsupported(request: WorkerRequest, error: string): WorkerResult {
  return { provider: "antigravity", model: request.model, requestedEffort: request.effort, output: "", success: false, durationMs: 0, error };
}
