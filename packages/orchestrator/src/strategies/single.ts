import type { RouterConfig } from "../config.js";
import { compactTaskPrompt } from "../contracts.js";
import { configuredModel } from "../routing/runtime.js";
import { preflightModel } from "../readiness.js";
import { selectEffort } from "../routing/effort.js";
import { selectModel, selectionRejections, summarizeRejections } from "../routing/selector.js";
import { requiredFamilies } from "../routing/diversity.js";
import { writeRunLog } from "../telemetry/run-log.js";
import { stateDirectoryFor } from "../state.js";
import { openCircuitProviders, recordProviderFailure, recordProviderSuccess } from "../circuit-breaker.js";
import { planContext } from "../context.js";
import type { Provider, RoutingMetadata, TaskProfile, WorkerLifecycle, WorkerRequest, WorkerResult, WriteBoundary } from "../types.js";

export type RoutedRun = { result: WorkerResult; runLog: string; routing: RoutingMetadata };

export async function runSingle(
  configDir: string,
  config: RouterConfig,
  providers: Record<string, Provider>,
  prompt: string,
  cwd: string,
  profile: TaskProfile,
  options: { files?: string[] | string | undefined; attachments?: string[] | undefined; writeBoundary?: WriteBoundary; writeMode?: import("../worktrees/types.js").WriteMode; allowWorktreeScopedWrite?: boolean; excludedFamilies?: Set<string>; modelId?: string; effort?: import("../types.js").Effort; signal?: AbortSignal; stateRoot?: string; lifecycle?: WorkerLifecycle; workerId?: string } = {},
): Promise<RoutedRun> {
  if (requiredFamilies(config, profile.diversity) > 1) {
    throw new Error("This task requires independent model families; use dtr fanout rather than dtr route");
  }
  const circuitOpenProviders = await openCircuitProviders(cwd);
  const selectionOptions = {
    requireWrite: Boolean(options.writeBoundary),
    ...(options.writeMode ? { writeMode: options.writeMode } : {}),
    ...(options.allowWorktreeScopedWrite ? { allowWorktreeScopedWrite: true } : {}),
    ...(options.modelId ? { modelId: options.modelId } : {}),
    circuitOpenProviders,
    providers,
  };
  const preferred = selectModel(config, profile, {}, options.excludedFamilies, selectionOptions);
  const failedPreflights = new Set<string>();
  let selection = selectModel(config, profile, {}, options.excludedFamilies, selectionOptions);
  let model: ReturnType<typeof configuredModel> | undefined;
  let preflightReason: string | undefined;
  while (selection) {
    const candidate = configuredModel(config, selection.model);
    const preflight = await preflightModel(candidate, providers, cwd);
    if (preflight.ready) { model = candidate; break; }
    preflightReason = preflight.reason;
    // Explicit model selection is an intentional pin, never a silent fallback.
    if (options.modelId) break;
    failedPreflights.add(candidate.id);
    selection = selectModel(config, profile, {}, options.excludedFamilies, { ...selectionOptions, excludedModels: failedPreflights });
  }
  if (!selection || !model) {
    const rejected = selectionRejections(config, profile, {}, { ...selectionOptions, ...(failedPreflights.size ? { excludedModels: failedPreflights } : {}) }, options.excludedFamilies);
    throw new Error(`No eligible live model: ${preflightReason ?? summarizeRejections(rejected, profile)}`);
  }
  if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const baselineEffort = selectEffort(config, model, profile);
  const effort = options.effort ? { requested: options.effort, effective: model.efforts.includes(options.effort) ? options.effort : baselineEffort.effective } : baselineEffort;
  const provider = providers[model.provider];
  if (!provider) throw new Error(`Provider '${model.provider}' is not implemented`);
  const caps = typeof provider.capabilities === "function"
    ? provider.capabilities()
    : { workspaceRead: true, workspaceSearch: true, shellAccess: true, nativeTextAttachments: false, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: false };
  let effectivePrompt = prompt;
  let effectiveAttachments: string[] | undefined = options.attachments ? [...options.attachments] : undefined;
  if (options.files) {
    const contextPlan = await planContext(options.files, cwd, caps);
    if (contextPlan.attachments.length) {
      effectiveAttachments = [...(effectiveAttachments ?? []), ...contextPlan.attachments];
    }
    if (contextPlan.excerptSection) {
      effectivePrompt = `${effectivePrompt}\n\n${contextPlan.excerptSection}`;
    }
  }
  const request: WorkerRequest = {
    prompt: compactTaskPrompt(effectivePrompt, config.policy.prompt, { provider: model.provider, model: model.model, contextTokens: model.limits.contextTokens }),
    cwd,
    role: profile.role,
    model: model.model,
    effort: effort.effective,
    readOnly: !options.writeBoundary,
    ...(options.writeBoundary ? { writeBoundary: options.writeBoundary } : {}),
    ...(effectiveAttachments?.length ? { attachments: effectiveAttachments } : {}),
    timeoutMs: config.policy.defaults.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  options.lifecycle?.onRouteSelected?.({ modelId: model.id, provider: model.provider, model: model.model, effort: effort.effective });
  const workerId = options.workerId ?? model.id;
  options.lifecycle?.onWorkerStarted?.({ workerId, provider: model.provider, model: model.model, role: profile.role, effort: effort.effective });
  const startedAt = Date.now();
  const heartbeat = setInterval(() => options.lifecycle?.onWorkerHeartbeat?.({ workerId, provider: model.provider, model: model.model, role: profile.role, effort: effort.effective, elapsedMs: Date.now() - startedAt }), 30_000);
  let result: WorkerResult;
  try { result = await provider.run(request); }
  finally { clearInterval(heartbeat); }
  if (result.success) { await recordProviderSuccess(model.provider, cwd); options.lifecycle?.onWorkerCompleted?.({ workerId, result }); }
  else { await recordProviderFailure(model.provider, cwd); options.lifecycle?.onWorkerFailed?.({ workerId, error: result.error ?? "Worker failed" }); }
  const routing: RoutingMetadata = {
    profile,
    selectedModel: model.id,
    selection: {
      ...selection.explanation,
      rejected: failedPreflights.size
        ? { ...selection.explanation.rejected, ...Object.fromEntries([...failedPreflights].map((id) => [id, ["selected-model preflight failed"]])) }
        : selection.explanation.rejected,
    },
    requestedEffort: effort.requested,
    effectiveEffort: effort.effective,
    ...(preferred && preferred.model !== model.id ? { fallbackFrom: preferred.model } : {}),
  };
  const runLog = await writeRunLog(options.stateRoot ?? stateDirectoryFor(cwd), request, result, routing);
  return { result, runLog, routing };
}
