import type { Command, ProcessRunner, Provider, ProviderCapabilities, WorkerRequest, WorkerResult } from "../types.js";
import { commandAvailable, missingHelpFlags, resultFromProcess } from "./shared.js";

/**
 * OpenCode owns its configured providers and credentials. DTR deliberately
 * discovers only the non-secret provider/model names exposed by its CLI; it
 * never reads OpenCode configuration, auth files, or environment files.
 */
export function openCodeCommandCandidates(): string[] {
  const configured = process.env.DTR_OPENCODE_COMMAND?.trim();
  return [...new Set([configured, "opencode"].filter((value): value is string => Boolean(value)))];
}

export function createOpenCodeCommand(request: WorkerRequest, executable = "opencode"): Command {
  const advisory = request.readOnly
    ? "Read-only advisory task: inspect only. Do not edit, create, delete, stage, commit, install packages, or run destructive commands. Do not use auto-approval. Return the compact handoff."
    : "Work only inside the declared boundary and return the compact handoff.";
  return {
    command: executable,
    // Do not use --auto, --file, --continue, or a shared session. The model is
    // the exact provider/model name reported by `opencode models`; --variant is
    // the provider-specific reasoning-effort selector.
    args: ["run", "--model", request.model, "--variant", request.effort, "--format", "json", "--dir", request.cwd, `${advisory}\n\n${request.prompt}`],
  };
}

export class OpenCodeProvider implements Provider {
  readonly id = "opencode" as const;

  constructor(private readonly runner: ProcessRunner) {}

  async health(): Promise<boolean> {
    return (await this.availableModels(process.cwd())) !== undefined;
  }

  /** Returns only catalog identifiers such as `featherless/Qwen/Qwen3-32B`. */
  async availableModels(cwd: string): Promise<Set<string> | undefined> {
    const executable = await resolveOpenCodeCommand(this.runner, cwd);
    if (!executable) return undefined;
    const result = await this.runner.run({ command: executable, args: ["models"] }, { cwd, timeoutMs: 10_000 });
    if (result.exitCode !== 0) return undefined;
    const models = parseOpenCodeModels(result.stdout);
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
      worktreeScopedWrite: false,
    };
  }

  async run(request: WorkerRequest): Promise<WorkerResult> {
    const executable = await resolveOpenCodeCommand(this.runner, request.cwd);
    if (!executable) return unsupported(request, "OpenCode CLI is unavailable. Install and configure OpenCode, then ensure `opencode` is on PATH or set DTR_OPENCODE_COMMAND.");
    const help = await this.runner.run({ command: executable, args: ["run", "--help"] }, { cwd: request.cwd, timeoutMs: 5_000 });
    const requiredFlags = ["--model", "--variant", "--format", "--dir"];
    if (help.exitCode !== 0 || missingHelpFlags(help, requiredFlags).length > 0) {
      return unsupported(request, "OpenCode CLI lacks a required headless option; refusing to run.");
    }
    const startedAt = Date.now();
    const result = await this.runner.run(createOpenCodeCommand(request, executable), { cwd: request.cwd, timeoutMs: request.timeoutMs, signal: request.signal });
    return resultFromProcess(this.id, request, startedAt, result);
  }
}

export function parseOpenCodeModels(output: string): Set<string> {
  const clean = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  const models = new Set<string>();
  for (const line of clean.split("\n")) {
    // The documented CLI format is provider/model. Model IDs themselves may
    // contain additional slashes (for example Hugging Face namespaces).
    const match = line.trim().match(/^([^\s/]+\/[^\s]+)(?:\s|$)/);
    if (match?.[1]) models.add(match[1]);
  }
  return models;
}

async function resolveOpenCodeCommand(runner: ProcessRunner, cwd: string): Promise<string | undefined> {
  for (const command of openCodeCommandCandidates()) if (await commandAvailable(runner, command, cwd)) return command;
  return undefined;
}

function unsupported(request: WorkerRequest, error: string): WorkerResult {
  return { provider: "opencode", model: request.model, requestedEffort: request.effort, output: "", success: false, durationMs: 0, error };
}
