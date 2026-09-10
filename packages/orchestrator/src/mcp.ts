#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DtrApplication } from "./application.js";
import { DISPATCH_CONTRACT, MAX_COMPACT_TASK_CHARS, MAX_COMPACT_TASK_WORDS, MAX_RELEVANT_FILES, normalizeCompactTask } from "./contracts.js";
import { classifyTask } from "./routing/classifier.js";

const role = z.enum(["architect", "implementer", "debugger", "reviewer", "researcher", "test", "log-analysis"]);
const profileInput = {
  role, prompt: z.string().min(1).max(MAX_COMPACT_TASK_CHARS).refine((value) => (value.match(/\S+/g)?.length ?? 0) <= MAX_COMPACT_TASK_WORDS, `Task must contain at most ${MAX_COMPACT_TASK_WORDS} words.`), cwd: z.string().min(1).max(2048).optional(),
  complexity: z.enum(["trivial", "normal", "difficult", "extreme"]).optional(), risk: z.enum(["low", "medium", "high"]).optional(), diversity: z.enum(["none", "low", "medium", "high"]).optional(),
  preferLocal: z.boolean().optional(), localOnly: z.boolean().optional(), privacySensitive: z.boolean().optional(), privateCode: z.boolean().optional(), allowRemote: z.boolean().optional(), allowedFamilies: z.array(z.string().min(1)).max(8).optional(), allowedProviders: z.array(z.enum(["claude", "codex", "ollama", "openrouter", "featherless", "antigravity", "opencode"])).max(7).optional(), requiresTools: z.boolean().optional(),
};
export const mcpProfileSchema = z.object(profileInput).strict();
const dispatchInput = {
  ...profileInput,
  files: z.array(z.string().min(1).max(256)).max(MAX_RELEVANT_FILES).optional(),
};
const outcomeInput = {
  runId: z.string().uuid(),
  cwd: z.string().min(1).max(2048).optional(),
  status: z.enum(["accepted", "rejected", "partial", "escalated"]),
  reviewFindingsCount: z.number().int().min(0).max(10_000).optional(),
  regressionDetected: z.boolean().optional(),
  manualScore: z.number().min(0).max(1).optional(),
};
const configDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../config");
const packageVersion = (() => { try { return (JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version?: string }).version ?? "0.0.0"; } catch { return "0.0.0"; } })();

function cwd(value: string | undefined): string { return value ? resolve(value) : process.cwd(); }
function profile(input: z.infer<z.ZodObject<typeof profileInput>>) {
  return classifyTask(input.prompt, input.role, {
    ...(input.complexity ? { complexity: input.complexity } : {}), ...(input.risk ? { risk: input.risk } : {}), ...(input.diversity ? { diversity: input.diversity } : {}),
    preferLocal: input.preferLocal ?? false, requireLocal: input.localOnly ?? false, privacySensitive: input.privacySensitive ?? false, privateCode: input.privateCode ?? false, allowRemote: input.allowRemote ?? true, ...(input.allowedFamilies ? { allowedFamilies: input.allowedFamilies } : {}), ...(input.allowedProviders ? { allowedProviders: input.allowedProviders } : {}), requiresTools: input.requiresTools ?? false,
  });
}
function applicationInput(input: z.infer<z.ZodObject<typeof profileInput>>) {
  const task = profile(input); const { role: _role, ...overrides } = task;
  return { prompt: input.prompt, role: input.role, profile: overrides };
}
function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }
function error(reason: unknown) { return { content: [{ type: "text" as const, text: reason instanceof Error ? reason.message : String(reason) }], isError: true }; }

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "dynamic-task-router", version: packageVersion });
  server.registerTool("dtr_health", { description: "Report configured provider and local-model availability.", inputSchema: {} }, async () => {
    try {
      const application = new DtrApplication(configDir); return text({ providers: await application.listProviders(), models: await application.listModels() });
    } catch (reason) { return error(reason); }
  });
  server.registerTool("dtr_models", { description: "List configured model routing metadata without credentials.", inputSchema: {} }, async () => {
    try { return text(await new DtrApplication(configDir).listModels()); } catch (reason) { return error(reason); }
  });
  server.registerTool("dtr_start", { description: "Return DTR's compact dispatch contract before constructing a routed task. Does not invoke a model.", inputSchema: {} }, async () => text({ contract: DISPATCH_CONTRACT }));
  server.registerTool("dtr_doctor", { description: "Run safe, no-inference provider/auth diagnostics before dispatch. Returns only status metadata; never credential values.", inputSchema: { cwd: z.string().min(1).max(2048).optional() } }, async (input) => {
    try { return text(await new DtrApplication(configDir, cwd(input.cwd)).doctor()); } catch (reason) { return error(reason); }
  });
  server.registerTool("dtr_usage", { description: "Summarize DTR execution telemetry for every provider. Account quotas are not scraped.", inputSchema: { cwd: z.string().min(1).max(2048).optional() } }, async (input) => {
    try { return text(await new DtrApplication(configDir, cwd(input.cwd)).usage()); } catch (reason) { return error(reason); }
  });
  server.registerTool("dtr_select", { description: "Dry-run deterministic read-only selection. Does not invoke a model.", inputSchema: profileInput }, async (input) => {
    try { return text(await new DtrApplication(configDir, cwd(input.cwd)).select(applicationInput(input))); } catch (reason) { return error(reason); }
  });
  server.registerTool("dtr_prepare", { description: "Validate one compact task and its relative file paths, then preview the packet, token estimate, and selected route. Does not invoke a model.", inputSchema: dispatchInput }, async (input) => {
    try { normalizeCompactTask(input.prompt); return text(await new DtrApplication(configDir, cwd(input.cwd)).prepare({ ...applicationInput(input), cwd: cwd(input.cwd), files: input.files })); } catch (reason) { return error(reason); }
  });
  server.registerTool("dtr_run", { description: "Select and run one bounded, read-only router task. Pass only the compact objective and up to eight relative file paths; never paste source, logs, transcripts, or reasoning.", inputSchema: dispatchInput }, async (input) => {
    try { normalizeCompactTask(input.prompt); const run = await new DtrApplication(configDir, cwd(input.cwd)).run({ ...applicationInput(input), cwd: cwd(input.cwd), files: input.files }); return text({ runId: run.runId, routing: run.routing, success: run.result.success, result: run.result.output.slice(0, 1200) }); } catch (reason) { return error(reason); }
  });
  server.registerTool("dtr_fanout", { description: "Run the same bounded read-only task through independent model families.", inputSchema: { ...dispatchInput, families: z.number().int().min(2).max(4) } }, async (input) => {
    try { const run = await new DtrApplication(configDir, cwd(input.cwd)).fanout({ ...applicationInput({ ...input, diversity: "medium" }), cwd: cwd(input.cwd), files: input.files, families: input.families }); return text(run.map((item) => ({ runId: item.runId, model: item.model, success: item.result.success, result: item.result.output.slice(0, 1200) }))); } catch (reason) { return error(reason); }
  });
  server.registerTool("dtr_pipeline", { description: "Run a named safe pipeline. Writes require an explicit scope and isolated worktree.", inputSchema: { ...dispatchInput, template: z.enum(["debug-review", "plan-challenge-review", "implement-review"]), write: z.boolean().optional(), scope: z.array(z.string().min(1).max(256)).max(32).optional() } }, async (input) => {
    try { if (input.write && (!input.scope || input.scope.length === 0)) throw new Error("Write pipeline requires a non-empty scope"); const run = await new DtrApplication(configDir, cwd(input.cwd)).pipeline({ ...applicationInput(input), cwd: cwd(input.cwd), files: input.files, template: input.template, ...(input.write !== undefined ? { write: input.write } : {}), ...(input.scope ? { scope: input.scope } : {}) }); return text({ runId: run.record.id, state: run.record.state, stages: run.record.stages }); } catch (reason) { return error(reason); }
  });
  server.registerTool("dtr_status", { description: "Read persisted status for a router run ID.", inputSchema: { runId: z.string().uuid(), cwd: z.string().min(1).max(2048).optional() } }, async (input) => {
    try { const run = await new DtrApplication(configDir, cwd(input.cwd)).getRun(input.runId); if (!run) throw new Error("Run not found"); return text(run); } catch (reason) { return error(reason); }
  });
  server.registerTool("dtr_outcome", { description: "Record the parent review outcome for a completed DTR run. This stores metadata only and helps evaluate routing quality.", inputSchema: outcomeInput }, async (input) => {
    try {
      const { runId, cwd: targetCwd, status, reviewFindingsCount, regressionDetected, manualScore } = input;
      const outcome = { status, ...(reviewFindingsCount !== undefined ? { reviewFindingsCount } : {}), ...(regressionDetected !== undefined ? { regressionDetected } : {}), ...(manualScore !== undefined ? { manualScore } : {}) };
      return text(await new DtrApplication(configDir, cwd(targetCwd)).outcome(runId, outcome));
    } catch (reason) { return error(reason); }
  });
  return server;
}

export async function main(): Promise<void> { await createMcpServer().connect(new StdioServerTransport()); }
function isMainModule(): boolean { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href; } catch { return false; } }
if (isMainModule()) main().catch((reason) => { console.error(reason); process.exitCode = 1; });
