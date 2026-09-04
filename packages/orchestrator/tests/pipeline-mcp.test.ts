import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mcpProfileSchema } from "../src/mcp.js";
import { parseConfig } from "../src/config.js";
import { runPipeline } from "../src/strategies/pipeline.js";
import { readRunRecord } from "../src/telemetry/run-registry.js";
import { stateDirectoryFor } from "../src/state.js";
import type { Provider, WorkerRequest } from "../src/types.js";

const models = `
version: 1
models:
  - id: claude
    provider: claude
    family: anthropic
    model: claude
    enabled: true
    local: false
    roles: { architect: 8, implementer: 8, debugger: 8, reviewer: 10, researcher: 8, test: 8, log-analysis: 8 }
    efforts: [low, medium, high]
    default_effort: high
    capabilities: { tools: true, vision: false, huge_context: true, write_safe: true }
  - id: codex
    provider: codex
    family: openai
    model: codex
    enabled: true
    local: false
    roles: { architect: 9, implementer: 9, debugger: 9, reviewer: 8, researcher: 8, test: 9, log-analysis: 8 }
    efforts: [low, medium, high, xhigh]
    default_effort: high
    capabilities: { tools: true, vision: false, huge_context: true, write_safe: true }
`;
const policy = `
version: 1
phase: 2
defaults: { readOnly: true, timeoutMs: 1000 }
rules: { automaticSelection: true, requireExplicitFallback: true, requireIndependentFamiliesForHighDiversity: true }
effort: { complexity: { trivial: low, normal: medium, difficult: high, extreme: xhigh }, minimumForRisk: { low: low, medium: medium, high: high } }
diversity: { none: { minimumFamilies: 1 }, low: { minimumFamilies: 1 }, medium: { minimumFamilies: 2 }, high: { minimumFamilies: 2, requireIndependentReview: true } }
`;
const pipelines = `
version: 1
templates:
  - id: debug-review
    stages:
      - { id: diagnose, role: debugger, strategy: single, readOnly: true }
      - { id: independent, role: debugger, strategy: single, readOnly: true, dependsOn: [diagnose], diversity: medium }
      - { id: review, role: reviewer, strategy: single, readOnly: true, dependsOn: [diagnose, independent], diversity: medium }
`;
const config = parseConfig(models, policy, pipelines);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function provider(id: "claude" | "codex", calls: WorkerRequest[]): Provider { return { id, health: async () => true, run: async (request) => { calls.push(request); return { provider: id, model: request.model, requestedEffort: request.effort, output: `${id} evidence`, success: true, durationMs: 1 }; } }; }

describe("MCP and pipelines", () => {
  it("rejects unsafe MCP input before router execution", () => {
    expect(() => mcpProfileSchema.parse({ role: "reviewer", prompt: "ok", shell: "rm -rf /" })).toThrow();
    expect(() => mcpProfileSchema.parse({ role: "reviewer", prompt: "" })).toThrow();
  });
  it("orders dependencies and supplies only required prior evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "dtr-pipeline-")); directories.push(root, stateDirectoryFor(root)); const calls: WorkerRequest[] = [];
    const run = await runPipeline(config, { claude: provider("claude", calls), codex: provider("codex", calls) }, "debug-review", "Trace the issue", root, { role: "debugger", complexity: "difficult", risk: "low", preferLocal: false, requireLocal: false, privacySensitive: false, diversity: "none", requiresTools: false });
    expect(run.record.state).toBe("succeeded"); expect(run.record.stages.map((stage) => stage.id)).toEqual(["diagnose", "independent", "review"]);
    expect(run.record.stages.map((stage) => stage.model)).toEqual(["codex", "claude", "claude"]);
    expect(calls[1]?.prompt).toContain("diagnose: codex evidence"); expect(calls[1]?.prompt).not.toContain("claude evidence");
    expect(calls[2]?.prompt).toContain("diagnose: codex evidence"); expect(calls[2]?.prompt).toContain("independent: claude evidence");
    expect(calls.every((call) => call.readOnly)).toBe(true);
    await expect(readRunRecord(stateDirectoryFor(root), run.record.id)).resolves.toMatchObject({ state: "succeeded", template: "debug-review" });
    await expect((await import("node:fs/promises")).access(join(root, ".dtr"))).rejects.toThrow();
  });
  it("persists a failed stage and does not run dependents", async () => {
    const root = await mkdtemp(join(tmpdir(), "dtr-pipeline-")); directories.push(root, stateDirectoryFor(root)); const calls: WorkerRequest[] = [];
    const failed: Provider = { id: "codex", health: async () => true, run: async (request) => { calls.push(request); return { provider: "codex", model: request.model, requestedEffort: request.effort, output: "", success: false, durationMs: 1, error: "worker failed" }; } };
    await expect(runPipeline(config, { claude: provider("claude", calls), codex: failed }, "debug-review", "Trace", root, { role: "debugger", complexity: "difficult", risk: "low", preferLocal: false, requireLocal: false, privacySensitive: false, diversity: "none", requiresTools: false })).rejects.toThrow("worker failed");
    const files = await (await import("node:fs/promises")).readdir(join(stateDirectoryFor(root), "runs"));
    const status = await readRunRecord(stateDirectoryFor(root), files.find((file) => file.endsWith(".status.json"))!.replace(".status.json", ""));
    expect(status).toMatchObject({ state: "failed" }); expect(calls).toHaveLength(1);
  });
});
