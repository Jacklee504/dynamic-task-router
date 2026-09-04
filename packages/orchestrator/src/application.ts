import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, userConfigPath, type ModelConfig, type RouterConfig } from "./config.js";
import { NodeProcessRunner } from "./process.js";
import { createProviders } from "./providers/index.js";
import { classifyTask } from "./routing/classifier.js";
import { selectEffort } from "./routing/effort.js";
import { modelAvailability } from "./routing/runtime.js";
import { selectModel } from "./routing/selector.js";
import { stateDirectoryFor } from "./state.js";
import { summarizeRuns } from "./stats.js";
import { summarizeUsage, type UsageReport } from "./telemetry/usage.js";
import { runFanout } from "./strategies/fanout.js";
import { runPipeline } from "./strategies/pipeline.js";
import { runSingle } from "./strategies/single.js";
import { buildCompactTaskPacket, compactTaskPrompt, normalizeRelevantFiles } from "./contracts.js";
import { diagnoseProviders, type DoctorReport } from "./doctor.js";
import { attachRunOutcome, createRunRecord, readRunRecord, writeRunRecord, type RunRecord } from "./telemetry/run-registry.js";
import type { Effort, Provider, ProviderId, TaskProfile, WorkerLifecycle, WorkerResult, WorkerRole } from "./types.js";
export type { Effort, ProviderId, TaskProfile, WorkerResult, WorkerRole } from "./types.js";
export type { RunRecord } from "./telemetry/run-registry.js";

export type DtrEvent =
  | { type: "run-created"; runId: string; task: string; timestamp: string }
  | { type: "route-selected"; runId: string; model: string; provider: ProviderId; effort: Effort; timestamp: string }
  | { type: "worker-started"; runId: string; workerId: string; provider: ProviderId; model: string; role: WorkerRole; effort: Effort; timestamp: string }
  | { type: "worker-completed"; runId: string; workerId: string; result: WorkerResult; timestamp: string }
  | { type: "worker-failed"; runId: string; workerId: string; error: string; timestamp: string }
  | { type: "run-aborting"; runId: string; timestamp: string }
  | { type: "run-completed"; runId: string; outcome: string; timestamp: string }
  | { type: "run-failed"; runId: string; error: string; timestamp: string };

export type SelectionRequest = {
  prompt: string;
  role: WorkerRole;
  profile?: Partial<Omit<TaskProfile, "role">> | undefined;
  provider?: ProviderId | undefined;
  modelId?: string | undefined;
  effort?: Effort | undefined;
};
export type RunRequest = SelectionRequest & { cwd: string; files?: string[] | undefined };
export type RunResult = { runId: string; routing: Awaited<ReturnType<typeof runSingle>>["routing"]; result: WorkerResult };
export type ProviderView = { id: ProviderId; healthy: boolean; enabled: boolean; models: string[] };
export type ModelView = ModelConfig & { available: boolean };
export type AbortResult = { runId: string; accepted: boolean; state: "aborting" | "unavailable" };
export type OllamaRuntime = { available: boolean; models: Array<{ name: string; sizeBytes?: number; runtimeSizeBytes?: number; contextLength?: number; expiresAt?: string }>; unavailableReason?: string };
export type { UsageReport } from "./telemetry/usage.js";

export class DtrApplication {
  private readonly events = new EventEmitter();
  private readonly active = new Map<string, AbortController>();
  private readonly providers: Record<ProviderId, Provider>;

  constructor(private readonly configDir: string, private readonly defaultCwd = process.cwd(), providers?: Record<ProviderId, Provider>, private readonly personalConfig: string | null = userConfigPath()) {
    this.providers = providers ?? createProviders(new NodeProcessRunner());
  }

  onEvent(listener: (event: DtrEvent) => void): () => void { this.events.on("event", listener); return () => this.events.off("event", listener); }
  private emit(event: DtrEvent): void { this.events.emit("event", event); }
  private async config(): Promise<RouterConfig> { return loadConfig(this.configDir, this.personalConfig ?? undefined); }
  private profile(input: SelectionRequest): TaskProfile {
    return classifyTask(input.prompt, input.role, {
      ...(input.profile ?? {}),
      ...(input.provider ? { allowedProviders: [input.provider] } : {}),
    });
  }

  async health(): Promise<ProviderView[]> {
    const config = await this.config();
    return Promise.all(Object.entries(this.providers).map(async ([id, provider]) => ({ id: id as ProviderId, healthy: await provider.health(), enabled: config.models.some((model) => model.provider === id && model.enabled), models: config.models.filter((model) => model.provider === id && model.enabled).map((model) => model.id) })));
  }

  async listModels(): Promise<ModelView[]> {
    const config = await this.config(); const availability = await modelAvailability(config, this.providers);
    return config.models.map((model) => ({ ...model, available: Boolean(availability[model.id]) }));
  }
  async listProviders(): Promise<ProviderView[]> { return this.health(); }
  async doctor(): Promise<DoctorReport> { const config = await this.config(); return diagnoseProviders(new NodeProcessRunner(), config.models, this.defaultCwd); }
  async ollamaRuntime(): Promise<OllamaRuntime> { return readOllamaRuntime(); }
  async select(input: SelectionRequest) {
    const config = await this.config(); const profile = this.profile(input); const availability = await modelAvailability(config, this.providers);
    const selection = selectModel(config, profile, availability, new Set(), input.modelId ? { modelId: input.modelId } : {});
    if (!selection) throw new Error("No eligible model: constraints cannot be safely satisfied");
    const model = config.models.find((candidate) => candidate.id === selection.model)!;
    const baseline = selectEffort(config, model, profile);
    const effort = input.effort ? { requested: input.effort, effective: model.efforts.includes(input.effort) ? input.effort : baseline.effective } : baseline;
    return { profile, selection, model, effort };
  }

  /** Validate the normal packet and preview its selected route without inference. */
  async prepare(input: RunRequest) {
    const files = normalizeRelevantFiles(input.files);
    const packet = buildCompactTaskPacket(input.prompt, files);
    const [config, selected] = await Promise.all([this.config(), this.select(input)]);
    const composed = compactTaskPrompt(packet, config.policy.prompt, {
      provider: selected.model.provider, model: selected.model.model, contextTokens: selected.model.limits.contextTokens,
    });
    const hostReserve = config.policy.prompt.hostContextReserveTokens[selected.model.provider] ?? 0;
    const inputTokenBudget = Math.min(config.policy.prompt.maxInputTokens, selected.model.limits.contextTokens - config.policy.prompt.responseReserveTokens - hostReserve);
    return { packet, files, routing: selected, estimatedInputTokens: Math.ceil(composed.length / config.policy.prompt.charsPerToken), inputTokenBudget };
  }

  async run(input: RunRequest): Promise<RunResult> {
    const prompt = buildCompactTaskPacket(input.prompt, input.files); const stateRoot = stateDirectoryFor(input.cwd || this.defaultCwd); const config = await this.config(); const profile = this.profile(input); const record = await createRunRecord(stateRoot, "single");
    const controller = new AbortController(); this.active.set(record.id, controller);
    this.emit({ type: "run-created", runId: record.id, task: safeTask(input.prompt), timestamp: record.startedAt });
    try {
      record.state = "running"; record.stages = [{ id: "route", state: "running", model: "pending" }]; await writeRunRecord(stateRoot, record);
      const lifecycle: WorkerLifecycle = {
        onRouteSelected: (selected) => { record.stages[0]!.model = selected.modelId; this.emit({ type: "route-selected", runId: record.id, model: selected.modelId, provider: selected.provider, effort: selected.effort, timestamp: now() }); },
        onWorkerStarted: (info) => this.emit({ type: "worker-started", runId: record.id, workerId: "route", provider: info.provider, model: info.model, role: info.role, effort: info.effort, timestamp: now() }),
        onWorkerCompleted: (info) => this.emit({ type: "worker-completed", runId: record.id, workerId: "route", result: info.result, timestamp: now() }),
        onWorkerFailed: (info) => this.emit({ type: "worker-failed", runId: record.id, workerId: "route", error: info.error, timestamp: now() }),
      };
      const run = await runSingle(this.configDir, config, this.providers, prompt, input.cwd, profile, { ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.effort ? { effort: input.effort } : {}), signal: controller.signal, stateRoot, lifecycle, workerId: "route" });
      const aborted = controller.signal.aborted;
      record.stages[0]!.state = aborted ? "aborted" : run.result.success ? "succeeded" : "failed"; record.state = aborted ? "aborted" : run.result.success ? "succeeded" : "failed"; record.endedAt = now(); if (!run.result.success && !aborted) record.error = safeError(run.result.error ?? "Worker failed"); await writeRunRecord(stateRoot, record);
      if (aborted) this.emit({ type: "run-completed", runId: record.id, outcome: "aborted", timestamp: now() });
      else if (run.result.success) this.emit({ type: "run-completed", runId: record.id, outcome: "succeeded", timestamp: now() });
      else this.emit({ type: "run-failed", runId: record.id, error: record.error ?? "Worker failed", timestamp: now() });
      return { runId: record.id, routing: run.routing, result: run.result };
    } catch (error) {
      record.state = controller.signal.aborted ? "aborted" : "failed"; record.error = safeError(error); record.endedAt = now(); await writeRunRecord(stateRoot, record); if (controller.signal.aborted) this.emit({ type: "run-completed", runId: record.id, outcome: "aborted", timestamp: now() }); else this.emit({ type: "run-failed", runId: record.id, error: record.error, timestamp: now() }); throw error;
    } finally { this.active.delete(record.id); }
  }

  async fanout(input: RunRequest & { families?: number | undefined }): Promise<Array<{ runId: string; model: string; result: WorkerResult }>> {
    const prompt = buildCompactTaskPacket(input.prompt, input.files); const stateRoot = stateDirectoryFor(input.cwd || this.defaultCwd); const config = await this.config(); const profile = { ...this.profile(input), diversity: "medium" as const }; const record = await createRunRecord(stateRoot, "fanout"); const controller = new AbortController(); this.active.set(record.id, controller); this.emit({ type: "run-created", runId: record.id, task: safeTask(input.prompt), timestamp: record.startedAt });
    const lifecycle = this.forwardLifecycle(record.id);
    try {
      record.state = "running"; await writeRunRecord(stateRoot, record); const runs = await runFanout(this.configDir, config, this.providers, prompt, input.cwd, profile, input.families, controller.signal, stateRoot, lifecycle);
      record.state = runs.every((run) => run.result.success) ? "succeeded" : "failed"; record.endedAt = now(); record.stages = runs.map((run) => ({ id: run.model, model: run.model, state: run.result.success ? "succeeded" : "failed" })); await writeRunRecord(stateRoot, record); this.emit({ type: "run-completed", runId: record.id, outcome: record.state, timestamp: now() }); return runs.map((run) => ({ runId: record.id, model: run.model, result: run.result }));
    } finally { this.active.delete(record.id); }
  }

  async pipeline(input: RunRequest & { template: string; write?: boolean; scope?: string[] }) {
    const stateRoot = stateDirectoryFor(input.cwd || this.defaultCwd); const config = await this.config(); const record = await createRunRecord(stateRoot, "pipeline", input.template);
    const controller = new AbortController(); this.active.set(record.id, controller); this.emit({ type: "run-created", runId: record.id, task: safeTask(input.prompt), timestamp: record.startedAt });
    const lifecycle = this.forwardLifecycle(record.id);
    try {
      const result = await runPipeline(config, this.providers, input.template, buildCompactTaskPacket(input.prompt, input.files), input.cwd, this.profile(input), { write: input.write, scope: input.scope, runId: record.id, signal: controller.signal, lifecycle });
      this.emit({ type: "run-completed", runId: record.id, outcome: result.record.state, timestamp: now() });
      return result;
    } catch (error) {
      this.emit({ type: "run-failed", runId: record.id, error: safeError(error), timestamp: now() });
      throw error;
    } finally { this.active.delete(record.id); }
  }

  private forwardLifecycle(runId: string): WorkerLifecycle {
    return {
      onWorkerStarted: (info) => this.emit({ type: "worker-started", runId, workerId: info.workerId, provider: info.provider, model: info.model, role: info.role, effort: info.effort, timestamp: now() }),
      onWorkerCompleted: (info) => this.emit({ type: "worker-completed", runId, workerId: info.workerId, result: info.result, timestamp: now() }),
      onWorkerFailed: (info) => this.emit({ type: "worker-failed", runId, workerId: info.workerId, error: info.error, timestamp: now() }),
    };
  }
  async abort(runId: string): Promise<AbortResult> { const controller = this.active.get(runId); if (!controller) return { runId, accepted: false, state: "unavailable" }; this.emit({ type: "run-aborting", runId, timestamp: now() }); controller.abort(); return { runId, accepted: true, state: "aborting" }; }
  async getRun(runId: string): Promise<RunRecord | null> { try { return await readRunRecord(stateDirectoryFor(this.defaultCwd), runId); } catch { return null; } }
  async outcome(runId: string, outcome: NonNullable<RunRecord["outcome"]>): Promise<RunRecord> { return attachRunOutcome(stateDirectoryFor(this.defaultCwd), runId, outcome); }
  async listRuns(limit = 30): Promise<RunRecord[]> { const stateRoot = stateDirectoryFor(this.defaultCwd); try { const entries = (await readdir(resolve(stateRoot, "runs"))).filter((entry) => entry.endsWith(".status.json")).sort().reverse().slice(0, limit); return Promise.all(entries.map((entry) => readRunRecord(stateRoot, entry.replace(".status.json", "")))); } catch { return []; } }
  async stats() { return summarizeRuns(stateDirectoryFor(this.defaultCwd)); }
  async usage(): Promise<UsageReport> { return summarizeUsage(stateDirectoryFor(this.defaultCwd)); }
}

function now(): string { return new Date().toISOString(); }
function safeTask(value: string): string { return value.replace(/\s+/g, " ").trim().slice(0, 160); }
export function safeError(error: unknown): string { return String(error instanceof Error ? error.message : error).replace(/(?:ANTHROPIC|OPENAI|OPENROUTER)_API_KEY\s*=\s*\S+/gi, "[redacted]").replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: [redacted]").slice(0, 400); }
export async function readOllamaRuntime(fetcher: typeof fetch = fetch): Promise<OllamaRuntime> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetcher("http://127.0.0.1:11434/api/ps", { signal: controller.signal });
    if (!response.ok) return { available: false, models: [], unavailableReason: `Ollama runtime returned ${response.status}` };
    const body = await response.json() as { models?: Array<{ name?: string; size?: number; size_vram?: number; context_length?: number; expires_at?: string }> };
    return { available: true, models: (body.models ?? []).filter((model): model is Required<Pick<typeof model, "name">> & typeof model => Boolean(model.name)).map((model) => ({ name: model.name, ...(model.size !== undefined ? { sizeBytes: model.size } : {}), ...(model.size_vram !== undefined ? { runtimeSizeBytes: model.size_vram } : {}), ...(model.context_length !== undefined ? { contextLength: model.context_length } : {}), ...(model.expires_at ? { expiresAt: model.expires_at } : {}) })) };
  } catch { return { available: false, models: [], unavailableReason: "Ollama runtime unavailable" }; }
  finally { clearTimeout(timer); }
}
