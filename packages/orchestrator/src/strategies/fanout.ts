import type { RouterConfig } from "../config.js";
import { compactTaskPrompt } from "../contracts.js";
import { openCircuitProviders, recordProviderFailure, recordProviderSuccess } from "../circuit-breaker.js";
import { requiredFamilies } from "../routing/diversity.js";
import { selectEffort } from "../routing/effort.js";
import { configuredModel, modelAvailability } from "../routing/runtime.js";
import { eligibleSelections } from "../routing/selector.js";
import { writeRunLog } from "../telemetry/run-log.js";
import { stateDirectoryFor } from "../state.js";
import { planContext } from "../context.js";
import type { Provider, RoutingMetadata, TaskProfile, WorkerLifecycle, WorkerRequest, WorkerResult } from "../types.js";

export type FanoutRun = { model: string; result: WorkerResult; runLog: string; routing: RoutingMetadata };

export async function runFanout(
  configDir: string,
  config: RouterConfig,
  providers: Record<string, Provider>,
  prompt: string,
  cwd: string,
  profile: TaskProfile,
  requestedFamilies?: number,
  signal?: AbortSignal,
  stateRoot?: string,
  lifecycle?: WorkerLifecycle,
  files?: string[] | string,
): Promise<FanoutRun[]> {
  const minimumFamilies = requestedFamilies ?? requiredFamilies(config, profile.diversity);
  if (minimumFamilies < 2) throw new Error("dtr fanout requires at least two independent families");
  const availability = await modelAvailability(config, providers);
  const circuitOpenProviders = await openCircuitProviders(cwd);
  const selectionOptions = { circuitOpenProviders };
  const preferred = eligibleSelections(config, profile);
  const selections = eligibleSelections(config, profile, availability, selectionOptions).slice(0, minimumFamilies);
  if (selections.length < minimumFamilies) {
    throw new Error(`Degraded routing: requires ${minimumFamilies} independent model families; only ${selections.length} eligible`);
  }
  return Promise.all(selections.map(async (selection) => {
    const model = configuredModel(config, selection.model);
    const effort = selectEffort(config, model, profile);
    const provider = providers[model.provider];
    if (!provider) throw new Error(`Provider '${model.provider}' is not implemented`);
    const caps = typeof provider.capabilities === "function"
      ? provider.capabilities()
      : { workspaceRead: true, workspaceSearch: true, shellAccess: true, nativeTextAttachments: false, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: false };
    let effectivePrompt = prompt;
    let effectiveAttachments: string[] | undefined;
    if (files) {
      const plan = await planContext(files, cwd, caps);
      if (plan.attachments.length) effectiveAttachments = [...plan.attachments];
      if (plan.excerptSection) effectivePrompt = `${effectivePrompt}\n\n${plan.excerptSection}`;
    }
    const request: WorkerRequest = {
      prompt: compactTaskPrompt(effectivePrompt, config.policy.prompt, { provider: model.provider, model: model.model, contextTokens: model.limits.contextTokens }),
      cwd,
      role: profile.role,
      model: model.model,
      effort: effort.effective,
      readOnly: true,
      ...(effectiveAttachments?.length ? { attachments: effectiveAttachments } : {}),
      timeoutMs: config.policy.defaults.timeoutMs,
      ...(signal ? { signal } : {}),
    };
    lifecycle?.onWorkerStarted?.({ workerId: model.id, provider: model.provider, model: model.model, role: profile.role, effort: effort.effective });
    const result = await provider.run(request);
    if (result.success) { await recordProviderSuccess(model.provider, cwd); lifecycle?.onWorkerCompleted?.({ workerId: model.id, result }); }
    else { await recordProviderFailure(model.provider, cwd); lifecycle?.onWorkerFailed?.({ workerId: model.id, error: result.error ?? "Worker failed" }); }
    const routing: RoutingMetadata = {
      profile,
      selectedModel: model.id,
      selection: selection.explanation,
      requestedEffort: effort.requested,
      effectiveEffort: effort.effective,
      ...(preferred[0] && preferred[0].model !== model.id ? { fallbackFrom: preferred[0].model } : {}),
    };
    const runLog = await writeRunLog(stateRoot ?? stateDirectoryFor(cwd), request, result, routing);
    return { model: model.id, result, runLog, routing };
  }));
}
