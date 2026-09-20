#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";

import { DtrApplication } from "./application.js";
import { findModel, repositoryRootFromConfig, userConfigPath } from "./config.js";
import { DISPATCH_CONTRACT, compactTaskPrompt } from "./contracts.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenCodeProvider } from "./providers/opencode.js";
import { classifyTask, diversityFromFamilies } from "./routing/classifier.js";
import { selectEffort } from "./routing/effort.js";
import { explainSelection } from "./routing/explain.js";
import { modelAvailability } from "./routing/runtime.js";
import { preflightModel } from "./readiness.js";
import { estimateCost, selectModel, selectionRejections } from "./routing/selector.js";
import { stateDirectoryFor } from "./state.js";
import { writeRunLog } from "./telemetry/run-log.js";
import { evaluateDirectory } from "./evals.js";
import { appendExplicitFileContext } from "./context.js";
import type { WriteMode } from "./worktrees/types.js";
import type { Complexity, ContextRequirement, DiversityLevel, Effort, ProviderId, RiskLevel, TaskProfile, WorkerLifecycle, WorkerRequest, WorkerRole } from "./types.js";

type Flags = Record<string, string | boolean>;
const roles: WorkerRole[] = ["architect", "implementer", "debugger", "reviewer", "researcher", "test", "log-analysis"];
const complexities: Complexity[] = ["trivial", "normal", "difficult", "extreme"];
const risks: RiskLevel[] = ["low", "medium", "high"];
const diversities: DiversityLevel[] = ["none", "low", "medium", "high"];
const contexts: ContextRequirement[] = ["small", "medium", "large", "huge"];
const providerIds = ["claude", "codex", "ollama", "openrouter", "featherless", "antigravity", "opencode"] as const;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  let subcommand = "";
  let flagArgs = rest;
  if (command === "models" && rest[0] && !rest[0].startsWith("--")) { subcommand = rest[0]; flagArgs = rest.slice(1); }
  const flags = parseFlags(flagArgs);
  const configDir = typeof flags["config-dir"] === "string" ? resolve(flags["config-dir"]) : resolve(dirname(fileURLToPath(import.meta.url)), "../../../config");
  try {
    if (!command || command === "tui") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) { printUsage(); return 1; }
      const { runTui } = await import("@dynamic-task-router/tui");
      await runTui({ configDir, cwd: cwdFrom(flags) });
      return 0;
    }
    if (command === "help" || command === "--help") { printUsage(process.stdout); return 0; }
    if (command === "version" || command === "--version") { printVersion(); return 0; }
    if (command === "start") { console.log(DISPATCH_CONTRACT); return 0; }
    if (command === "config") return reportConfig(configDir);
    const app = new DtrApplication(configDir, cwdFrom(flags));
    if (command === "health") return await reportHealth(app);
    if (command === "doctor") return await doctor(app, flags);
    if (command === "models") {
      if (subcommand && subcommand !== "refresh") throw new Error(`Unexpected argument: ${subcommand}`);
      return await (subcommand === "refresh" || flags.refresh ? refreshModels(app) : reportModels(app));
    }
    if (command === "opencode-models") return await reportOpenCodeModels(app["providers"], cwdFrom(flags));
    if (command === "run") return await runExplicit(configDir, flags, app);
    if (command === "select") return await selectOnly(app, flags);
    if (command === "route") return await route(app, flags);
    if (command === "fanout") return await fanout(app, flags);
    if (command === "pipeline") return await pipeline(app, flags);
    if (command === "status") return await status(app, flags);
    if (command === "evaluate") return await evaluate(configDir);
    if (command === "stats") return await stats(app);
    if (command === "usage") return await usage(app);
    if (command === "outcome") return await outcome(app, flags);
    console.error(`dtr: unknown command: ${command}`);
    printUsage(); return 1;
  } catch (error) {
    console.error(`dtr: ${error instanceof Error ? error.message : String(error)}`); return 1;
  }
}

async function reportHealth(app: DtrApplication): Promise<number> {
  const providers = await app.health();
  for (const provider of providers) console.log(`${provider.id}: ${provider.healthy ? "available" : "unavailable"}`);
  const ollama = app["providers"].ollama as OllamaProvider;
  const config = await app.config();
  for (const model of config.models.filter((item) => item.provider === "ollama" && item.enabled)) console.log(`ollama model ${model.model}: ${(await ollama.isModelAvailable(model.model)) ? "installed" : "not installed"}`);
  return 0;
}

async function doctor(app: DtrApplication, flags: Flags): Promise<number> {
  const report = await app.doctor();
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

async function reportModels(app: DtrApplication): Promise<number> {
  const models = await app.listModels();
  for (const model of models) console.log(`${model.id}\t${model.provider}\t${model.family}\t${model.model}\t${model.tier}\t${model.enabled ? "enabled" : "disabled"}\t${model.available ? "available" : "unavailable"}`);
  return 0;
}

function reportConfig(configDir: string): number {
  const personal = userConfigPath();
  console.log(JSON.stringify({ baseConfigDir: configDir, personalConfig: personal, personalConfigLoaded: existsSync(personal), credentials: "not supported in personal config" }, null, 2));
  return 0;
}

/** Lists OpenCode's configured catalog identifiers; these are not automatically routing profiles. */
async function reportOpenCodeModels(providers: DtrApplication["providers"], cwd: string): Promise<number> {
  const provider = providers.opencode;
  if (!(provider instanceof OpenCodeProvider)) throw new Error("OpenCode provider is not implemented");
  const models = await provider.availableModels(cwd);
  if (!models) throw new Error("OpenCode is unavailable or its configured model catalog could not be read. Run `opencode models` in this Terminal for detail.");
  for (const model of [...models].sort()) console.log(model);
  return 0;
}

async function refreshModels(app: DtrApplication): Promise<number> {
  try {
    await app.config();
    const cache = await app.refreshCatalog();
    console.log(JSON.stringify(cache, null, 2));
    return 0;
  } catch (error) {
    const cached = await app.readCatalog();
    console.error(`dtr: ${error instanceof Error ? error.message : String(error)}`);
    if (!cached.cache) return 1;
    console.log(JSON.stringify({ refreshed: false, stale: cached.stale, fetchedAt: cached.cache.fetchedAt, models: cached.cache.models.length }, null, 2));
    return 0;
  }
}

async function runExplicit(configDir: string, flags: Flags, app: DtrApplication): Promise<number> {
  if (!boolFlag(flags, "allow-raw-prompt")) throw new Error("`dtr run` is an expert raw-prompt override. Use `dtr start` then `dtr route --task … --files …` for normal dispatches, or add --allow-raw-prompt deliberately.");
  const config = await app.config();
  const providers = app["providers"];
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
  const progress = cliProgress();
  progress.onRouteSelected?.({ modelId: model.id, provider: model.provider, model: model.model, effort });
  progress.onWorkerStarted?.({ workerId: model.id, provider: model.provider, model: model.model, role, effort });
  const startedAt = Date.now(); const heartbeat = setInterval(() => progress.onWorkerHeartbeat?.({ workerId: model.id, provider: model.provider, model: model.model, role, effort, elapsedMs: Date.now() - startedAt }), 30_000);
  let result;
  try { result = await provider.run(request); }
  finally { clearInterval(heartbeat); }
  if (result.success) progress.onWorkerCompleted?.({ workerId: model.id, result }); else progress.onWorkerFailed?.({ workerId: model.id, error: result.error ?? "Worker failed" });
  const logPath = await writeRunLog(stateDirectoryFor(request.cwd), request, result);
  printResult(result.output, result.error, logPath, boolFlag(flags, "verbose")); return result.success ? 0 : 1;
}

async function selectOnly(app: DtrApplication, flags: Flags): Promise<number> {
  const prompt = typeof flags.prompt === "string" ? flags.prompt : "";
  const role = optionalEnumFlag(flags, "role", roles) ?? "researcher";
  const profile = profileFrom(flags, prompt, undefined, role);
  try {
    const selected = await app.select({ prompt, role, profile, modelId: typeof flags.model === "string" ? flags.model : undefined, provider: optionalProviderFlag(flags, "provider"), effort: optionalEnumFlag(flags, "effort", ["low", "medium", "high", "xhigh", "max"] as const) });
    console.log(JSON.stringify({ ...explainSelection(profile, selected.selection), effort: selected.effort, provider: selected.model.provider, model: selected.model.model }, null, 2));
    return 0;
  } catch {
    const config = await app.config();
    const availability = await modelAvailability(config, app["providers"]);
    console.log(JSON.stringify(explainSelection(profile, undefined, selectionRejections(config, profile, availability)), null, 2));
    return 1;
  }
}

async function route(app: DtrApplication, flags: Flags): Promise<number> {
  if (flags.prompt !== undefined) throw new Error("`dtr route` accepts --task, not --prompt. Run `dtr start` for the compact dispatch contract.");
  if (flags["include-files"] !== undefined) throw new Error("`dtr route` accepts --files (paths only), not --include-files. Do not paste file content into a normal dispatch.");
  const task = requiredFlag(flags, "task");
  const cwd = cwdFrom(flags);
  const role = routeRole(flags, task);
  const files = typeof flags.files === "string" ? flags.files.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const run = await app.run({ prompt: task, role, cwd, files, profile: profileFrom(flags, task, undefined, role), lifecycle: cliProgress() });
  if (boolFlag(flags, "verbose")) console.error(JSON.stringify({ routing: run.routing, runLog: run.runLog, success: run.result.success }, null, 2));
  printResult(run.result.output, run.result.error, run.runLog, boolFlag(flags, "verbose"));
  return run.result.success ? 0 : 1;
}

async function fanout(app: DtrApplication, flags: Flags): Promise<number> {
  const task = requiredFlag(flags, "prompt");
  const cwd = cwdFrom(flags);
  const families = typeof flags.families === "string" ? Number.parseInt(flags.families, 10) : undefined;
  if (families !== undefined && (!Number.isInteger(families) || families < 2)) throw new Error("--families must be an integer of at least 2");
  const files = typeof flags["include-files"] === "string" ? flags["include-files"].split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const runs = await app.fanout({ prompt: task, role: enumFlag(flags, "role", roles), cwd, files, families, profile: profileFrom(flags, task, families), lifecycle: cliProgress() });
  for (const run of runs) {
    console.log(JSON.stringify({ model: run.model, routing: run.routing, runLog: run.runLog, success: run.result.success }, null, 2));
    printResult(run.result.output, run.result.error, run.runLog);
  }
  return runs.every((run) => run.result.success) ? 0 : 1;
}

async function pipeline(app: DtrApplication, flags: Flags): Promise<number> {
  if (flags.provider !== undefined) throw new Error("`dtr pipeline` does not accept --provider because independent stages need different providers. Use --implementation-provider and/or --review-provider.");
  const task = requiredFlag(flags, "prompt");
  const cwd = cwdFrom(flags);
  const template = requiredFlag(flags, "template");
  const write = boolFlag(flags, "write");
  const scope = typeof flags.scope === "string" ? flags.scope.split(",").map((item) => item.trim()).filter(Boolean) : [];
  const isolated = boolFlag(flags, "isolated");
  if (flags.branch !== undefined && (typeof flags.branch !== "string" || flags.branch.trim() === "")) {
    throw new Error("--branch requires a branch name");
  }
  const branchName = typeof flags.branch === "string" ? flags.branch : undefined;
  if (isolated && branchName !== undefined) throw new Error("--isolated and --branch are mutually exclusive");
  const allowNoop = boolFlag(flags, "allow-noop");
  const writeMode: WriteMode | undefined = isolated ? "isolated" : branchName ? "branch" : write ? "in-place" : undefined;
const implementationProvider = optionalProviderFlag(flags, "implementation-provider");
const reviewProvider = optionalProviderFlag(flags, "review-provider");
const files = typeof flags["include-files"] === "string" ? flags["include-files"].split(",").map((s) => s.trim()).filter(Boolean) : undefined;
const run = await app.pipeline({ prompt: task, role: enumFlag(flags, "role", roles), cwd, template, write, scope, allowNoop, profile: profileFrom(flags, task), lifecycle: cliProgress(), ...(files ? { files } : {}), ...(writeMode ? { writeMode } : {}), ...(branchName ? { branch: branchName } : {}), ...(implementationProvider ? { implementationProvider } : {}), ...(reviewProvider ? { reviewProvider } : {}) });
  console.log(JSON.stringify({ runId: run.record.id, state: run.record.state, stages: run.record.stages }, null, 2));
  return run.record.state === "succeeded" ? 0 : 1;
}

async function status(app: DtrApplication, flags: Flags): Promise<number> {
  const record = await app.getRun(requiredFlag(flags, "run-id"));
  if (!record) throw new Error("Run not found");
  console.log(JSON.stringify(record, null, 2));
  return 0;
}

async function evaluate(configDir: string): Promise<number> {
  const app = new DtrApplication(configDir, undefined, undefined, null);
  const config = await app.config();
  const result = await evaluateDirectory(config, resolve(repositoryRootFromConfig(configDir), "evals", "cases"));
  console.log(JSON.stringify(result, null, 2));
  return result.passed === result.total ? 0 : 1;
}

async function stats(app: DtrApplication): Promise<number> {
  console.log(JSON.stringify(await app.stats(), null, 2));
  return 0;
}

async function usage(app: DtrApplication): Promise<number> {
  console.log(JSON.stringify(await app.usage(), null, 2));
  return 0;
}

async function outcome(app: DtrApplication, flags: Flags): Promise<number> {
  const statusValue = enumFlag(flags, "status", ["accepted", "rejected", "partial", "escalated"] as const);
  const findings = typeof flags.findings === "string" ? Number.parseInt(flags.findings, 10) : undefined;
  const score = typeof flags.score === "string" ? Number.parseFloat(flags.score) : undefined;
  console.log(JSON.stringify(await app.outcome(requiredFlag(flags, "run-id"), { status: statusValue, ...(findings !== undefined ? { reviewFindingsCount: findings } : {}), ...(score !== undefined ? { manualScore: score } : {}), ...(boolFlag(flags, "regression") ? { regressionDetected: true } : {}) }), null, 2));
  return 0;
}

function profileFrom(flags: Flags, prompt: string, families?: number, providedRole?: WorkerRole): TaskProfile {
  const complexity = optionalEnumFlag(flags, "complexity", complexities);
  const risk = optionalEnumFlag(flags, "risk", risks);
  const diversity = optionalEnumFlag(flags, "diversity", diversities) ?? (families ? diversityFromFamilies(families) : undefined);
  const contextRequirement = optionalEnumFlag(flags, "context", contexts);
  return classifyTask(prompt, providedRole ?? enumFlag(flags, "role", roles), {
    ...(complexity ? { complexity } : {}), ...(risk ? { risk } : {}), ...(diversity ? { diversity } : {}), ...(contextRequirement ? { contextRequirement } : {}),
    preferLocal: boolFlag(flags, "prefer-local"), requireLocal: boolFlag(flags, "local-only"), privacySensitive: boolFlag(flags, "privacy-sensitive"), privateCode: boolFlag(flags, "private-code"), allowRemote: !boolFlag(flags, "no-remote"), ...(flags.provider !== undefined ? { allowedProviders: [enumFlag(flags, "provider", providerIds)] } : {}), requiresTools: boolFlag(flags, "requires-tools"),
  });
}
function optionalProviderFlag(flags: Flags, name: string): ProviderId | undefined { return flags[name] === undefined ? undefined : enumFlag(flags, name, providerIds); }
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
function parseFlags(args: string[]): Flags { const flags: Flags = {}; for (let index = 0; index < args.length; index += 1) { const arg = args[index]; if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg ?? ""}`); const body = arg.slice(2); const equals = body.indexOf("="); if (equals >= 0) { flags[body.slice(0, equals)] = body.slice(equals + 1); continue; } const value = args[index + 1]; if (!value || value.startsWith("--")) { flags[body] = true; continue; } flags[body] = value; index += 1; } return flags; }
function requiredFlag(flags: Flags, name: string): string { const value = flags[name]; if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`); return value; }
function printResult(output: string, error: string | undefined, logPath: string, showLog = false): void { if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`); if (error) console.error(`dtr: ${error}`); if (showLog) console.error(`dtr: run log ${logPath}`); }
function cliProgress(): WorkerLifecycle {
  return {
    onRouteSelected: ({ modelId, provider, model, effort }) => console.error(`dtr: selected ${modelId} (${provider}/${model}, ${effort})`),
    onWorkerStarted: ({ workerId, role }) => console.error(`dtr: worker ${workerId} started for ${role}`),
    onWorkerHeartbeat: ({ workerId, elapsedMs }) => console.error(`dtr: worker ${workerId} still running (${formatElapsed(elapsedMs)})`),
    onWorkerCompleted: ({ workerId }) => console.error(`dtr: worker ${workerId} completed`),
    onWorkerFailed: ({ workerId, error }) => console.error(`dtr: worker ${workerId} failed: ${error}`),
  };
}
function formatElapsed(elapsedMs: number): string { const seconds = Math.floor(elapsedMs / 1_000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function printUsage(stream: NodeJS.WriteStream = process.stderr): void {
  const lines = [
    "Usage: dtr <start|tui|health|doctor|config|models|opencode-models|run|select|route|fanout|pipeline|status|evaluate|stats|usage|outcome|help|version> [options]",
    "Start: dtr start  (print the compact dispatch contract; no model call)",
    "Route: dtr route --task <100-word task> [--files path1,path2] [--role <role>] [--provider <provider>] [profile flags]",
    "Run: dtr run --allow-raw-prompt --provider <provider> --model <model> --role <role> --prompt <text> (expert override)",
    "Context: raw run, fanout, and pipeline accept --include-files path1,path2 (explicit files below --cwd only)",
    "Doctor: dtr doctor [--verbose] [--cwd <target-repository>]",
    "Config: dtr config (show the non-secret personal overlay path)",
    "TUI: dtr tui [--cwd <target-repository>]",
    "Models: dtr models [--refresh] (or `dtr models refresh`); dtr opencode-models (OpenCode's unprofiled configured catalog)",
    "Select: dtr select --role <role> [--prompt <text>] [--complexity <level>] [--risk <level>] [--diversity <level>] [--provider <provider>]",
    "Fanout: dtr fanout --families <n> --role <role> --prompt <text> [profile flags]",
    "Pipeline: dtr pipeline --template <name> --role <role> --prompt <text> [--write] [--isolated] [--branch <name>] [--scope path1,path2] [--allow-noop] [--implementation-provider <provider>] [--review-provider <provider>]",
    "Usage: dtr usage [--cwd <repo>] (DTR execution telemetry; not account quota)",
    "Status: dtr status --run-id <uuid> [--cwd <repo>]",
    "Help: dtr --help; Version: dtr --version",
  ];
  for (const line of lines) stream.write(`${line}\n`);
}
function printVersion(): void {
  try { const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version?: string }; console.log(`dtr ${pkg.version ?? "unknown"}`); } catch { console.log("dtr unknown"); }
}
function isMainModule(): boolean { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href; } catch { return false; } }
if (isMainModule()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
