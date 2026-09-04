import type { RouterConfig } from "../config.js";
import { compactTaskPrompt } from "../contracts.js";
import { configuredModel, modelAvailability } from "../routing/runtime.js";
import { selectEffort } from "../routing/effort.js";
import { selectModel } from "../routing/selector.js";
import { requiredFamilies } from "../routing/diversity.js";
import { writeRunLog } from "../telemetry/run-log.js";
import { stateDirectoryFor } from "../state.js";
import type { Provider, RoutingMetadata, TaskProfile, WorkerRequest, WorkerResult, WriteBoundary } from "../types.js";

export type RoutedRun = { result: WorkerResult; runLog: string; routing: RoutingMetadata };

export async function runSingle(
  configDir: string,
  config: RouterConfig,
  providers: Record<string, Provider>,
  prompt: string,
  cwd: string,
  profile: TaskProfile,
  options: { writeBoundary?: WriteBoundary; excludedFamilies?: Set<string>; modelId?: string; effort?: import("../types.js").Effort; signal?: AbortSignal; stateRoot?: string } = {},
): Promise<RoutedRun> {
  if (requiredFamilies(config, profile.diversity) > 1) {
    throw new Error("This task requires independent model families; use dtr fanout rather than dtr route");
  }
  const availability = await modelAvailability(config, providers);
  const selectionOptions = { requireWrite: Boolean(options.writeBoundary), ...(options.modelId ? { modelId: options.modelId } : {}) };
  const preferred = selectModel(config, profile, {}, options.excludedFamilies, selectionOptions);
  const selection = selectModel(config, profile, availability, options.excludedFamilies, selectionOptions);
  if (!selection) throw new Error("No eligible model: constraints cannot be safely satisfied");
  const model = configuredModel(config, selection.model);
  const baselineEffort = selectEffort(config, model, profile);
  const effort = options.effort ? { requested: options.effort, effective: model.efforts.includes(options.effort) ? options.effort : baselineEffort.effective } : baselineEffort;
  const request: WorkerRequest = {
    prompt: compactTaskPrompt(prompt, config.policy.prompt, { provider: model.provider, model: model.model, contextTokens: model.limits.contextTokens }),
    cwd,
    role: profile.role,
    model: model.model,
    effort: effort.effective,
    readOnly: !options.writeBoundary,
    ...(options.writeBoundary ? { writeBoundary: options.writeBoundary } : {}),
    timeoutMs: config.policy.defaults.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const provider = providers[model.provider];
  if (!provider) throw new Error(`Provider '${model.provider}' is not implemented`);
  const result = await provider.run(request);
  const routing: RoutingMetadata = {
    profile,
    selectedModel: model.id,
    selection: selection.explanation,
    requestedEffort: effort.requested,
    effectiveEffort: effort.effective,
    ...(preferred && preferred.model !== model.id ? { fallbackFrom: preferred.model } : {}),
  };
  const runLog = await writeRunLog(options.stateRoot ?? stateDirectoryFor(cwd), request, result, routing);
  return { result, runLog, routing };
}
