#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";

import { findModel, loadConfig, repositoryRootFromConfig, userConfigPath } from "./config.js";
import { DISPATCH_CONTRACT, buildCompactTaskPacket, compactTaskPrompt } from "./contracts.js";
import { NodeProcessRunner } from "./process.js";
import { createProviders } from "./providers/index.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenCodeProvider } from "./providers/opencode.js";
import { readOpenRouterCatalog, refreshOpenRouterCatalog } from "./providers/openrouter.js";
import { classifyTask, diversityFromFamilies } from "./routing/classifier.js";
import { selectEffort } from "./routing/effort.js";
import { explainSelection } from "./routing/explain.js";
import { modelAvailability } from "./routing/runtime.js";
import { preflightModel } from "./readiness.js";
import { estimateCost, selectModel } from "./routing/selector.js";
import { stateDirectoryFor } from "./state.js";
import { runFanout } from "./strategies/fanout.js";
import { runPipeline } from "./strategies/pipeline.js";
import { runSingle } from "./strategies/single.js";
import { writeRunLog } from "./telemetry/run-log.js";
import { readRunRecord } from "./telemetry/run-registry.js";
import { attachRunOutcome } from "./telemetry/run-registry.js";
import { evaluateDirectory } from "./evals.js";
import { summarizeRuns } from "./stats.js";
import { summarizeUsage } from "./telemetry/usage.js";
import { diagnoseProviders } from "./doctor.js";
import { appendExplicitFileContext } from "./context.js";
import type { Complexity, ContextRequirement, DiversityLevel, Effort, RiskLevel, TaskProfile, WorkerRequest, WorkerRole } from "./types.js";

type Flags = Record<string, string | boolean>;
const roles: WorkerRole[] = ["architect", "implementer", "debugger", "reviewer", "researcher", "test", "log-analysis"];
const complexities: Complexity[] = ["trivial", "normal", "difficult", "extreme"];
const risks: RiskLevel[] = ["low", "medium", "high"];
const diversities: DiversityLevel[] = ["none", "low", "medium", "high"];
const contexts: ContextRequirement[] = ["small", "medium", "large", "huge"];

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const configDir = typeof flags["config-dir"] === "string" ? resolve(flags["config-dir"]) : resolve(dirname(fileURLToPath(import.meta.url)), "../../../config");
  try {
    if (!command || command === "tui") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) { printUsage(); return 1; }
      const { runTui } = await import("@dynamic-task-router/tui");
      await runTui({ configDir, cwd: cwdFrom(flags) });
      return 0;
    }
    if (command === "start") { console.log(DISPATCH_CONTRACT); return 0; }
    if (command === "config") return reportConfig(configDir);
    const config = await loadConfig(configDir, userConfigPath());
    const providers = createProviders(new NodeProcessRunner());
    if (command === "health") return await reportHealth(config.models, providers);
    if (command === "doctor") return await doctor(config.models, flags);
    if (command === "models") return await (flags.refresh ? refreshModels(configDir) : reportModels(config, providers));
    if (command === "opencode-models") return await reportOpenCodeModels(providers, cwdFrom(flags));
    if (command === "run") return await runExplicit(configDir, flags, config, providers);
    if (command === "select") return await selectOnly(flags, config, providers);
    if (command === "route") return await route(configDir, flags, config, providers);
    if (command === "fanout") return await fanout(configDir, flags, config, providers);
    if (command === "pipeline") return await pipeline(flags, config, providers);
    if (command === "status") return await status(flags);
    if (command === "evaluate") return await evaluate(configDir, config);
    if (command === "stats") return await stats(flags);
    if (command === "usage") return await usage(flags);
    if (command === "outcome") return await outcome(flags);
    printUsage(); return 1;
  } catch (error) {
    console.error(`dtr: ${error instanceof Error ? error.message : String(error)}`); return 1;
  }
}

async function reportHealth(models: Awaited<ReturnType<typeof loadConfig>>["models"], providers: ReturnType<typeof createProviders>): Promise<number> {
  for (const [id, provider] of Object.entries(providers)) console.log(`${id}: ${(await provider.health()) ? "available" : "unavailable"}`);
  const ollama = providers.ollama as OllamaProvider;
  for (const model of models.filter((item) => item.provider === "ollama" && item.enabled)) console.log(`ollama model ${model.model}: ${(await ollama.isModelAvailable(model.model)) ? "installed" : "not installed"}`);
  return 0;
}

async function doctor(models: Awaited<ReturnType<typeof loadConfig>>["models"], flags: Flags): Promise<number> {
  const report = await diagnoseProviders(new NodeProcessRunner(), models, cwdFrom(flags));
  if (boolFlag(flags, "verbose")) console.log(JSON.stringify(report, null, 2));
  else console.log(JSON.stringify({
    ready: report.ready,
    providers: {
      codex: report.providers.codex.ready ? "ready" : "unavailable",
      claude: report.providers.claude.installed && report.providers.claude.authenticated && report.providers.claude.safe ? "ready" : "unavailable",
      ollama: report.providers.ollama.ready ? "ready" : "unavailable",
      openrouter: report.providers.openrouter.ready ? "ready" : "disabled",
      featherless: report.providers.featherless.ready ? "ready" : "unavailable",
      antigravity: report.providers.antigravity.ready ? "ready" : "unavailable",
      opencode: report.providers.opencode.ready ? "ready" : "unavailable",
    },
    hint: report.ready ? "Run `dtr doctor --verbose` for per-check detail." : "Run `dtr doctor --verbose` to identify the unavailable prerequisite.",
  }, null, 2));
  return report.ready ? 0 : 1;
}

async function reportModels(config: Awaited<ReturnType<typeof loadConfig>>, providers: ReturnType<typeof createProviders>): Promise<number> {
  const availability = await modelAvailability(config, providers);
  for (const model of config.models) console.log(`${model.id}\t${model.provider}\t${model.family}\t${model.model}\t${model.tier}\t${model.enabled ? "enabled" : "disabled"}\t${availability[model.id] ? "available" : "unavailable"}`);
  return 0;
}

function reportConfig(configDir: string): number {
  const personal = userConfigPath();
  console.log(JSON.stringify({ baseConfigDir: configDir, personalConfig: personal, personalConfigLoaded: existsSync(personal), credentials: "not supported in personal config" }, null, 2));
  return 0;
}

/** Lists OpenCode's configured catalog identifiers; these are not automatically routing profiles. */
async function reportOpenCodeModels(providers: ReturnType<typeof createProviders>, cwd: string): Promise<number> {
  const provider = providers.opencode;
  if (!(provider instanceof OpenCodeProvider)) throw new Error("OpenCode provider is not implemented");
  const models = await provider.availableModels(cwd);
  if (!models) throw new Error("OpenCode is unavailable or its configured model catalog could not be read. Run `opencode models` in this Terminal for detail.");
  for (const model of [...models].sort()) console.log(model);
  return 0;
}

async function refreshModels(configDir: string): Promise<number> {
  const root = stateDirectoryFor(repositoryRootFromConfig(configDir));
  try {
    const cache = await refreshOpenRouterCatalog(root);
    console.log(JSON.stringify({ refreshed: true, fetchedAt: cache.fetchedAt, models: cache.models.length }, null, 2));
    return 0;
  } catch (error) {
    const cached = await readOpenRouterCatalog(root);
    console.error(`dtr: ${error instanceof Error ? error.message : String(error)}`);
    if (!cached.cache) return 1;
    console.log(JSON.stringify({ refreshed: false, stale: cached.stale, fetchedAt: cached.cache.fetchedAt, models: cached.cache.models.length }, null, 2));
    return 0;
  }
}

async function runExplicit(configDir: string, flags: Flags, config: Awaited<ReturnType<typeof loadConfig>>, providers: ReturnType<typeof createProviders>): Promise<number> {
  if (!boolFlag(flags, "allow-raw-prompt")) throw new Error("`dtr run` is an expert raw-prompt override. Use `dtr start` then `dtr route --task … --files …` for normal dispatches, or add --allow-raw-prompt deliberately.");
  const providerId = requiredFlag(flags, "provider"); const modelIdentifier = requiredFlag(flags, "model"); const role = enumFlag(flags, "role", roles); const task = requiredFlag(flags, "prompt"); const cwd = cwdFrom(flags); const prompt = await promptWithContext(flags, task, cwd);
  const model = findModel(config, modelIdentifier);
  if (!model) throw new Error(`Configured, enabled model not found: ${modelIdentifier}`);
  if (model.provider !== providerId) throw new Error(`Model '${model.id}' belongs to '${model.provider}', not '${providerId}'`);
  if (!(await preflightModel(model, providers, cwd)).ready) throw new Error(`Model '${model.id}' is not available in the current runtime or signed-in account`);
  if (model.roles[role] === 0) throw new Error(`Role '${role}' is not allowed for '${model.id}'`);
  const profile = profileFrom(flags, task);
  if ((profile.requireLocal || profile.allowRemote === false || profile.privacySensitive) && !model.local) throw new Error(`Model '${model.id}' is remote but this task requires local execution`);
  if (profile.privateCode && !model.privacy.privateCodeAllowed) throw new Error(`Model '${model.id}' is not approved for private code`);
  if (config.policy.budget.mode === "capped" && estimateCost(model) > config.policy.budget.max_estimated_cost_usd) throw new Error(`Model '${model.id}' exceeds the configured cost cap`);
  const effort = (typeof flags.effort === "string" ? flags.effort : model.defaultEffort) as Effort;
  if (!model.efforts.includes(effort)) throw new Error(`Effort '${effort}' is not allowed for '${model.id}'`);
  const request: WorkerRequest = { prompt: compactTaskPrompt(prompt, config.policy.prompt, { provider: model.provider, model: model.model, contextTokens: model.limits.contextTokens }), cwd, role, model: model.model, effort, readOnly: true, timeoutMs: config.policy.defaults.timeoutMs };
  const provider = providers[model.provider];
  if (!provider) throw new Error(`Provider '${model.provider}' is not implemented`);
  const result = await provider.run(request); const logPath = await writeRunLog(stateDirectoryFor(request.cwd), request, result);
  printResult(result.output, result.error, logPath, boolFlag(flags, "verbose")); return result.success ? 0 : 1;
}

async function selectOnly(flags: Flags, config: Awaited<ReturnType<typeof loadConfig>>, providers: ReturnType<typeof createProviders>): Promise<number> {
  const prompt = typeof flags.prompt === "string" ? flags.prompt : ""; const profile = profileFrom(flags, prompt); const selection = selectModel(config, profile, await modelAvailability(config, providers));
  if (!selection) { console.log(JSON.stringify(explainSelection(profile, undefined), null, 2)); return 1; }
  const model = findModel(config, selection.model)!; const effort = selectEffort(config, model, profile);
  console.log(JSON.stringify({ ...explainSelection(profile, selection), effort, provider: model.provider, model: model.model }, null, 2)); return 0;
}

async function route(configDir: string, flags: Flags, config: Awaited<ReturnType<typeof loadConfig>>, providers: ReturnType<typeof createProviders>): Promise<number> {
  if (flags.prompt !== undefined) throw new Error("`dtr route` accepts --task, not --prompt. Run `dtr start` for the compact dispatch contract.");
  if (flags["include-files"] !== undefined) throw new Error("`dtr route` accepts --files (paths only), not --include-files. Do not paste file content into a normal dispatch.");
  const task = requiredFlag(flags, "task"); const cwd = cwdFrom(flags); const role = routeRole(flags, task); const prompt = buildCompactTaskPacket(task, typeof flags.files === "string" ? flags.files : undefined); const run = await runSingle(configDir, config, providers, prompt, cwd, profileFrom(flags, task, undefined, role));
  if (boolFlag(flags, "verbose")) console.error(JSON.stringify({ routing: run.routing, runId: run.runLog, success: run.result.success }, null, 2));
  printResult(run.result.output, run.result.error, run.runLog, boolFlag(flags, "verbose")); return run.result.success ? 0 : 1;
}

async function fanout(configDir: string, flags: Flags, config: Awaited<ReturnType<typeof loadConfig>>, providers: ReturnType<typeof createProviders>): Promise<number> {
  const task = requiredFlag(flags, "prompt"); const cwd = cwdFrom(flags); const prompt = await promptWithContext(flags, task, cwd); const families = typeof flags.families === "string" ? Number.parseInt(flags.families, 10) : undefined;
  if (families !== undefined && (!Number.isInteger(families) || families < 2)) throw new Error("--families must be an integer of at least 2");
  const runs = await runFanout(configDir, config, providers, prompt, cwd, profileFrom(flags, task, families), families);
  for (const run of runs) { console.log(JSON.stringify({ model: run.model, routing: run.routing, runId: run.runLog, success: run.result.success }, null, 2)); printResult(run.result.output, run.result.error, run.runLog); }
  return runs.every((run) => run.result.success) ? 0 : 1;
}

async function pipeline(flags: Flags, config: Awaited<ReturnType<typeof loadConfig>>, providers: ReturnType<typeof createProviders>): Promise<number> {
  const task = requiredFlag(flags, "prompt"); const cwd = cwdFrom(flags); const prompt = await promptWithContext(flags, task, cwd); const template = requiredFlag(flags, "template"); const write = boolFlag(flags, "write");
  const scope = typeof flags.scope === "string" ? flags.scope.split(",").map((item) => item.trim()).filter(Boolean) : [];
  if (write && scope.length === 0) throw new Error("--write requires --scope path1,path2");
  const run = await runPipeline(config, providers, template, prompt, cwd, profileFrom(flags, task), { write, scope });
  console.log(JSON.stringify({ runId: run.record.id, state: run.record.state, stages: run.record.stages }, null, 2)); return run.record.state === "succeeded" ? 0 : 1;
}

async function status(flags: Flags): Promise<number> { console.log(JSON.stringify(await readRunRecord(stateDirectoryFor(cwdFrom(flags)), requiredFlag(flags, "run-id")), null, 2)); return 0; }
async function evaluate(configDir: string, config: Awaited<ReturnType<typeof loadConfig>>): Promise<number> { const result = await evaluateDirectory(config, resolve(repositoryRootFromConfig(configDir), "evals", "cases")); console.log(JSON.stringify(result, null, 2)); return result.passed === result.total ? 0 : 1; }
async function stats(flags: Flags): Promise<number> { console.log(JSON.stringify(await summarizeRuns(stateDirectoryFor(cwdFrom(flags))), null, 2)); return 0; }
async function usage(flags: Flags): Promise<number> { console.log(JSON.stringify(await summarizeUsage(stateDirectoryFor(cwdFrom(flags))), null, 2)); return 0; }
async function outcome(flags: Flags): Promise<number> { const status = enumFlag(flags, "status", ["accepted", "rejected", "partial", "escalated"] as const); const findings = typeof flags.findings === "string" ? Number.parseInt(flags.findings, 10) : undefined; const score = typeof flags.score === "string" ? Number.parseFloat(flags.score) : undefined; console.log(JSON.stringify(await attachRunOutcome(stateDirectoryFor(cwdFrom(flags)), requiredFlag(flags, "run-id"), { status, ...(findings !== undefined ? { reviewFindingsCount: findings } : {}), ...(score !== undefined ? { manualScore: score } : {}), ...(boolFlag(flags, "regression") ? { regressionDetected: true } : {}) }), null, 2)); return 0; }

function profileFrom(flags: Flags, prompt: string, families?: number, providedRole?: WorkerRole): TaskProfile {
  const complexity = optionalEnumFlag(flags, "complexity", complexities);
  const risk = optionalEnumFlag(flags, "risk", risks);
  const diversity = optionalEnumFlag(flags, "diversity", diversities) ?? (families ? diversityFromFamilies(families) : undefined);
  const contextRequirement = optionalEnumFlag(flags, "context", contexts);
  return classifyTask(prompt, providedRole ?? enumFlag(flags, "role", roles), {
    ...(complexity ? { complexity } : {}), ...(risk ? { risk } : {}), ...(diversity ? { diversity } : {}), ...(contextRequirement ? { contextRequirement } : {}),
    preferLocal: boolFlag(flags, "prefer-local"), requireLocal: boolFlag(flags, "local-only"), privacySensitive: boolFlag(flags, "privacy-sensitive"), privateCode: boolFlag(flags, "private-code"), allowRemote: !boolFlag(flags, "no-remote"), ...(flags.provider !== undefined ? { allowedProviders: [enumFlag(flags, "provider", ["claude", "codex", "ollama", "openrouter", "featherless", "antigravity", "opencode"] as const)] } : {}), requiresTools: boolFlag(flags, "requires-tools"),
  });
}
function routeRole(flags: Flags, task: string): WorkerRole {
  if (flags.role !== undefined) return enumFlag(flags, "role", roles);
  if (/\b(review|audit)\b/i.test(task)) return "reviewer";
  if (/\b(debug|why|fail|error|root cause)\b/i.test(task)) return "debugger";
  if (/\b(log|trace)\b/i.test(task)) return "log-analysis";
  if (/\b(implement|fix|change|add)\b/i.test(task)) return "implementer";
  if (/\b(architecture|design|plan)\b/i.test(task)) return "architect";
  return "researcher";
}
async function promptWithContext(flags: Flags, task: string, cwd: string): Promise<string> { return appendExplicitFileContext(task, typeof flags["include-files"] === "string" ? flags["include-files"] : undefined, cwd); }
function cwdFrom(flags: Flags): string { return typeof flags.cwd === "string" ? resolve(flags.cwd) : process.cwd(); }
function boolFlag(flags: Flags, name: string): boolean { return flags[name] === true || flags[name] === "true"; }
function enumFlag<T extends string>(flags: Flags, name: string, values: readonly T[]): T { const value = requiredFlag(flags, name); if (!values.includes(value as T)) throw new Error(`Invalid --${name}: ${value}`); return value as T; }
function optionalEnumFlag<T extends string>(flags: Flags, name: string, values: readonly T[]): T | undefined { return flags[name] === undefined ? undefined : enumFlag(flags, name, values); }
function parseFlags(args: string[]): Flags { const flags: Flags = {}; for (let index = 0; index < args.length; index += 1) { const arg = args[index]; if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg ?? ""}`); const key = arg.slice(2); const value = args[index + 1]; if (!value || value.startsWith("--")) { flags[key] = true; continue; } flags[key] = value; index += 1; } return flags; }
function requiredFlag(flags: Flags, name: string): string { const value = flags[name]; if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`); return value; }
function printResult(output: string, error: string | undefined, logPath: string, showLog = false): void { if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`); if (error) console.error(`dtr: ${error}`); if (showLog) console.error(`dtr: run log ${logPath}`); }
function printUsage(): void { console.error("Usage: dtr <start|tui|health|doctor|config|models|opencode-models|run|select|route|fanout|pipeline|status|evaluate|stats|usage|outcome> [options]"); console.error("Start: dtr start  (print the compact dispatch contract; no model call)"); console.error("Route: dtr route --task <100-word task> [--files path1,path2] [--role <role>] [--provider <provider>] [profile flags]"); console.error("Run: dtr run --allow-raw-prompt --provider <provider> --model <model> --role <role> --prompt <text> (expert override)"); console.error("Context: raw run, fanout, and pipeline accept --include-files path1,path2 (explicit files below --cwd only)"); console.error("Doctor: dtr doctor [--verbose] [--cwd <target-repository>]"); console.error("Config: dtr config (show the non-secret personal overlay path)"); console.error("TUI: dtr tui [--cwd <target-repository>]"); console.error("Models: dtr models; dtr opencode-models (OpenCode's unprofiled configured catalog)"); console.error("Select: dtr select --role <role> [--prompt <text>] [--complexity <level>] [--risk <level>] [--diversity <level>] [--provider <provider>]"); console.error("Fanout: dtr fanout --families <n> --role <role> --prompt <text> [profile flags]"); console.error("Pipeline: dtr pipeline --template <name> --role <role> --prompt <text> [--write --scope path1,path2]"); console.error("Usage: dtr usage [--cwd <repo>] (DTR execution telemetry; not account quota)"); console.error("Status: dtr status --run-id <uuid> [--cwd <repo>]"); }
function isMainModule(): boolean { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href; } catch { return false; } }
if (isMainModule()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
