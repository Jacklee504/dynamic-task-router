import type { RouterConfig } from "../config.js";
import { createRunRecord, writeRunRecord, type RunRecord } from "../telemetry/run-registry.js";
import { runFanout } from "./fanout.js";
import { runSingle, type RoutedRun } from "./single.js";
import { assertSafeBoundary, createWorktree, verifyWriteBoundary } from "../worktrees/manager.js";
import { stateDirectoryFor } from "../state.js";
import type { WriteVerification } from "../worktrees/types.js";
import type { PipelineDefinition, PipelineStage, Provider, TaskProfile, WriteBoundary } from "../types.js";

export type PipelineOptions = { write?: boolean | undefined; scope?: string[] | undefined };
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
  const stateRoot = stateDirectoryFor(cwd);
  const record = await createRunRecord(stateRoot, "pipeline", definition.id);
  record.state = "running"; await writeRunRecord(stateRoot, record);
  const results = new Map<string, PipelineStageResult>();
  try {
    for (const stage of definition.stages) {
      if (stage.dependsOn?.some((id) => !results.has(id))) throw new Error(`Pipeline stage '${stage.id}' has unsatisfied dependency`);
      record.stages.push({ id: stage.id, state: "running" }); await writeRunRecord(stateRoot, record);
      const outcome = await runStage(config, providers, stage, record.id, prompt, cwd, profile, results, options, stateRoot);
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
): Promise<PipelineStageResult> {
  const evidence = (stage.dependsOn ?? []).map((id) => previous.get(id)!).map((item) => `${item.id}: ${item.output.slice(0, 480)}`).join("\n");
  const stagePrompt = [`Objective: ${objective}`, `Stage: ${stage.id} (${stage.role}).`, evidence ? `Required prior-stage evidence:\n${evidence}` : "", "Return only the compact task-result contract."].filter(Boolean).join("\n\n");
  const excludedFamilies = new Set<string>();
  if (stage.diversity === "medium" || stage.diversity === "high") {
    const prior = stage.dependsOn?.[0] ? previous.get(stage.dependsOn[0]) : undefined;
    const model = prior && config.models.find((candidate) => candidate.id === prior.model);
    if (model) excludedFamilies.add(model.family);
  }
  const stageProfile: TaskProfile = { ...profile, role: stage.role, diversity: "none" };
  const wantsWrite = !stage.readOnly && options.write === true;
  if (!stage.readOnly && !options.write) stageProfile.complexity = profile.complexity;
  if (wantsWrite) {
    if (!options.scope?.length) throw new Error("Write pipeline requires --scope with one or more allowed paths");
    const boundary: WriteBoundary = { allowedPaths: options.scope };
    assertSafeBoundary(boundary);
    const worktree = await createWorktree(cwd, runId, stage.id);
    const run = await runSingle(".", config, providers, stagePrompt, worktree.worktree, stageProfile, { writeBoundary: boundary, excludedFamilies, stateRoot });
    if (!run.result.success) throw new Error(run.result.error ?? `Write stage '${stage.id}' failed`);
    const verification = await verifyWriteBoundary(worktree.worktree, boundary);
    return { id: stage.id, model: run.routing.selectedModel, output: compact(run), verification };
  }
  if (stage.strategy === "fanout") {
    const runs = await runFanout(".", config, providers, stagePrompt, cwd, { ...stageProfile, diversity: "medium" }, 2, undefined, stateRoot);
    return { id: stage.id, model: runs.map((run) => run.model).join(","), output: runs.map((run) => run.result.output.slice(0, 240)).join("\n") };
  }
  const run = await runSingle(".", config, providers, stagePrompt, cwd, stageProfile, { excludedFamilies, stateRoot });
  if (!run.result.success) throw new Error(run.result.error ?? `Stage '${stage.id}' failed`);
  return { id: stage.id, model: run.routing.selectedModel, output: compact(run) };
}

function compact(run: RoutedRun): string { return run.result.output.slice(0, 480); }
