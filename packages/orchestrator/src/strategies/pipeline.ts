import type { RouterConfig } from "../config.js";
import { createRunRecord, writeRunRecord, type RunRecord } from "../telemetry/run-registry.js";
import { runFanout } from "./fanout.js";
import { runSingle, type RoutedRun } from "./single.js";
import { assertSafeBoundary, acquireWriteLock, releaseWriteLock, createWorktree, prepareInPlaceWrite, prepareBranchWrite, verifyWriteBoundary } from "../worktrees/manager.js";
import { stateDirectoryFor } from "../state.js";
import type { WorktreeHandle, WriteMode, WriteVerification } from "../worktrees/types.js";
import type { PipelineDefinition, PipelineStage, Provider, ProviderId, TaskProfile, WorkerLifecycle, WriteBoundary } from "../types.js";

export type PipelineOptions = {
  files?: string[] | string | undefined;
  write?: boolean | undefined;
  writeMode?: WriteMode | undefined;
  branch?: string | undefined;
  scope?: string[] | undefined;
  allowNoop?: boolean | undefined;
  implementationProvider?: ProviderId | undefined;
  reviewProvider?: ProviderId | undefined;
  runId?: string | undefined;
  signal?: AbortSignal | undefined;
  lifecycle?: WorkerLifecycle | undefined;
};
export type PipelineStageResult = { id: string; model: string; output: string; verification?: WriteVerification };
export type PipelineRun = { record: RunRecord; stages: PipelineStageResult[] };

export async function runPipeline(
  config: RouterConfig,
  providers: Record<string, Provider>,
  templateId: string,
  prompt: string,
  cwd: string,
  profile: TaskProfile,
  options: PipelineOptions = {},
): Promise<PipelineRun> {
  const definition = pipeline(config, templateId);
  if (profile.allowedProviders?.length) throw new Error("Pipeline-wide provider pins are unsupported. Use implementationProvider or reviewProvider instead.");
  if (options.implementationProvider && !definition.stages.some((stage) => stage.role === "implementer")) throw new Error(`Pipeline '${definition.id}' has no implementation stage to pin to '${options.implementationProvider}'.`);
  if (options.reviewProvider && !definition.stages.some((stage) => stage.role === "reviewer")) throw new Error(`Pipeline '${definition.id}' has no review stage to pin to '${options.reviewProvider}'.`);
  const stateRoot = stateDirectoryFor(cwd);
  const record = await createRunRecord(stateRoot, "pipeline", definition.id, options.runId);
  record.state = "running"; await writeRunRecord(stateRoot, record);
  const results = new Map<string, PipelineStageResult>();
  try {
    for (const stage of definition.stages) {
      if (stage.dependsOn?.some((id) => !results.has(id))) throw new Error(`Pipeline stage '${stage.id}' has unsatisfied dependency`);
      record.stages.push({ id: stage.id, state: "running" }); await writeRunRecord(stateRoot, record);
      const outcome = await runStage(config, providers, stage, record.id, prompt, cwd, profile, results, options, stateRoot, record);
      results.set(stage.id, outcome);
      const state = record.stages.find((item) => item.id === stage.id)!;
      state.state = "succeeded"; state.model = outcome.model;
      if (outcome.verification) { state.changedPaths = outcome.verification.changedPaths; state.checks = outcome.verification.checks; }
      await writeRunRecord(stateRoot, record);
    }
    record.state = "succeeded"; record.endedAt = new Date().toISOString(); await writeRunRecord(stateRoot, record);
    return { record, stages: [...results.values()] };
  } catch (error) {
    record.state = "failed"; record.error = error instanceof Error ? error.message : String(error); record.endedAt = new Date().toISOString();
    const active = record.stages.find((stage) => stage.state === "running"); if (active) { active.state = "failed"; active.error = record.error; }
    await writeRunRecord(stateRoot, record); throw error;
  }
}

function pipeline(config: RouterConfig, id: string): PipelineDefinition {
  const found = config.pipelines.find((template) => template.id === id);
  if (!found) throw new Error(`Unknown pipeline template: ${id}`);
  return found;
}

async function runStage(
  config: RouterConfig,
  providers: Record<string, Provider>,
  stage: PipelineStage,
  runId: string,
  objective: string,
  cwd: string,
  profile: TaskProfile,
  previous: Map<string, PipelineStageResult>,
  options: PipelineOptions,
  stateRoot: string,
  record: RunRecord,
): Promise<PipelineStageResult> {
  const evidence = (stage.dependsOn ?? []).map((id) => previous.get(id)!).map((item) => `${item.id}: ${item.output.slice(0, 480)}`).join("\n");
  const stagePrompt = [`Objective: ${objective}`, `Stage: ${stage.id} (${stage.role}).`, evidence ? `Required prior-stage evidence:\n${evidence}` : "", "Return only the compact task-result contract."].filter(Boolean).join("\n\n");
  const excludedFamilies = new Set<string>();
  if (stage.diversity === "medium" || stage.diversity === "high") {
    const prior = stage.dependsOn?.[0] ? previous.get(stage.dependsOn[0]) : undefined;
    const model = prior && config.models.find((candidate) => candidate.id === prior.model);
    if (model) excludedFamilies.add(model.family);
  }
  const pinnedProvider = stage.role === "implementer" ? options.implementationProvider : stage.role === "reviewer" ? options.reviewProvider : undefined;
  if (stage.role === "reviewer" && pinnedProvider && excludedFamilies.size) {
    const hasIndependentFamily = config.models.some((model) => model.enabled && model.provider === pinnedProvider && !excludedFamilies.has(model.family));
    if (!hasIndependentFamily) throw new Error(`Review provider '${pinnedProvider}' has no model family independent from the implementation worker. Choose a different --review-provider or omit it.`);
  }
  const stageProfile: TaskProfile = { ...profile, role: stage.role, diversity: "none", ...(pinnedProvider ? { allowedProviders: [pinnedProvider] } : {}) };
  const wantsWrite = !stage.readOnly && options.write === true;
  if (!stage.readOnly && !options.write) stageProfile.complexity = profile.complexity;
  const signal = options.signal;
  const lifecycle = options.lifecycle;
  if (wantsWrite) {
    const boundary: WriteBoundary = { allowedPaths: options.scope?.length ? options.scope : ["."] };
    assertSafeBoundary(boundary);
    const allowWorktreeScopedWrite = boundary.allowedPaths.every((path) => path !== ".");
    const effectiveMode: WriteMode = options.writeMode ?? (options.branch ? "branch" : "in-place");
    let lockPath: string | undefined;
    let worktree: WorktreeHandle | undefined;
    try {
      if (effectiveMode === "in-place") {
        lockPath = await acquireWriteLock(cwd, runId);
        worktree = await prepareInPlaceWrite(cwd, runId, stage.id);
      } else if (effectiveMode === "branch") {
        if (!options.branch) throw new Error("--branch requires a branch name");
        worktree = await prepareBranchWrite(cwd, runId, stage.id, options.branch);
      } else {
        worktree = await createWorktree(cwd, runId, stage.id);
      }

      const stageRecord = record.stages.find((item) => item.id === stage.id);
      if (stageRecord) {
        stageRecord.writeMode = worktree.mode;
        stageRecord.branch = worktree.branch;
        stageRecord.cwd = worktree.worktree;
        stageRecord.baseHead = worktree.initialHead;
        stageRecord.scope = boundary.allowedPaths;
      }
      record.writeMode = worktree.mode;
      record.branch = worktree.branch;
      record.cwd = worktree.worktree;
      record.baseHead = worktree.initialHead;
      record.scope = boundary.allowedPaths;
      await writeRunRecord(stateRoot, record);

      console.error(`dtr: run=${runId}`);
      console.error(`dtr: write mode=${worktree.mode}`);
      console.error(`dtr: branch=${worktree.branch}`);
      console.error(`dtr: base-head=${worktree.initialHead.slice(0, 12)}`);
      console.error(`dtr: cwd=${worktree.worktree}`);
      console.error(`dtr: scope=${boundary.allowedPaths.join(", ")}`);

      const run = await runSingle(".", config, providers, stagePrompt, worktree.worktree, stageProfile, {
        files: options.files,
        writeBoundary: boundary,
        writeMode: effectiveMode,
        ...(allowWorktreeScopedWrite ? { allowWorktreeScopedWrite: true } : {}),
        excludedFamilies,
        stateRoot,
        ...(signal ? { signal } : {}),
        ...(lifecycle ? { lifecycle, workerId: stage.id } : {}),
      });
      if (!run.result.success) throw new Error(run.result.error ?? `Write stage '${stage.id}' failed`);
      const verification = await verifyWriteBoundary(worktree.worktree, boundary, worktree.initialHead);

      if (stage.role === "implementer" && verification.changedPaths.length === 0 && !options.allowNoop) {
        throw new Error(`Write stage '${stage.id}' produced no file changes (use --allow-noop if no-op is expected)`);
      }

      console.error(`dtr: changed paths=[${verification.changedPaths.join(", ")}]`);
      console.error(`dtr: checks=[${verification.checks.map((c) => `${c.command}=${c.success ? "pass" : "fail"}`).join(", ")}]`);

      return { id: stage.id, model: run.routing.selectedModel, output: compact(run), verification };
    } finally {
      if (lockPath) await releaseWriteLock(cwd, runId);
    }
  }
  if (stage.strategy === "fanout") {
    const runs = await runFanout(".", config, providers, stagePrompt, cwd, { ...stageProfile, diversity: "medium" }, 2, signal, stateRoot, lifecycle, options.files);
    return { id: stage.id, model: runs.map((run) => run.model).join(","), output: runs.map((run) => run.result.output.slice(0, 240)).join("\n") };
  }
  const run = await runSingle(".", config, providers, stagePrompt, cwd, stageProfile, { files: options.files, excludedFamilies, stateRoot, ...(signal ? { signal } : {}), ...(lifecycle ? { lifecycle, workerId: stage.id } : {}) });
  if (!run.result.success) throw new Error(run.result.error ?? `Stage '${stage.id}' failed`);
  return { id: stage.id, model: run.routing.selectedModel, output: compact(run) };
}

function compact(run: RoutedRun): string { return run.result.output.slice(0, 480); }
