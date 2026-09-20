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
  - id: implement-review
    stages:
      - { id: implement, role: implementer, strategy: single, readOnly: false }
      - { id: review, role: reviewer, strategy: single, readOnly: true, dependsOn: [implement], diversity: medium }
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
  it("emits per-stage lifecycle events using stage ids as worker ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "dtr-pipeline-")); directories.push(root, stateDirectoryFor(root)); const calls: WorkerRequest[] = [];
    const started: string[] = []; const completed: string[] = [];
    const lifecycle = {
      onWorkerStarted: (info: { workerId: string }) => { started.push(info.workerId); },
      onWorkerCompleted: (info: { workerId: string }) => { completed.push(info.workerId); },
      onWorkerFailed: () => {},
    };
    await runPipeline(config, { claude: provider("claude", calls), codex: provider("codex", calls) }, "debug-review", "Trace", root, { role: "debugger", complexity: "difficult", risk: "low", preferLocal: false, requireLocal: false, privacySensitive: false, diversity: "none", requiresTools: false }, { lifecycle });
    expect(started).toEqual(["diagnose", "independent", "review"]);
    expect(completed).toEqual(["diagnose", "independent", "review"]);
  });
  it("pins implementation and review separately while preserving independent review", async () => {
    const root = await mkdtemp(join(tmpdir(), "dtr-pipeline-")); directories.push(root, stateDirectoryFor(root)); const calls: WorkerRequest[] = [];
    const task = { role: "implementer" as const, complexity: "normal" as const, risk: "low" as const, preferLocal: false, requireLocal: false, privacySensitive: false, diversity: "none" as const, requiresTools: false };
    const run = await runPipeline(config, { claude: provider("claude", calls), codex: provider("codex", calls) }, "implement-review", "Implement", root, task, { implementationProvider: "codex", reviewProvider: "claude" });
    expect(run.record.stages.map((stage) => stage.model)).toEqual(["codex", "claude"]);
    await expect(runPipeline(config, { claude: provider("claude", []), codex: provider("codex", []) }, "implement-review", "Implement", root, task, { implementationProvider: "codex", reviewProvider: "codex" })).rejects.toThrow("no model family independent");
  });
  it("persists a failed stage and does not run dependents", async () => {
    const root = await mkdtemp(join(tmpdir(), "dtr-pipeline-")); directories.push(root, stateDirectoryFor(root)); const calls: WorkerRequest[] = [];
    const failed: Provider = { id: "codex", health: async () => true, run: async (request) => { calls.push(request); return { provider: "codex", model: request.model, requestedEffort: request.effort, output: "", success: false, durationMs: 1, error: "worker failed" }; } };
    await expect(runPipeline(config, { claude: provider("claude", calls), codex: failed }, "debug-review", "Trace", root, { role: "debugger", complexity: "difficult", risk: "low", preferLocal: false, requireLocal: false, privacySensitive: false, diversity: "none", requiresTools: false })).rejects.toThrow("worker failed");
    const files = await (await import("node:fs/promises")).readdir(join(stateDirectoryFor(root), "runs"));
    const status = await readRunRecord(stateDirectoryFor(root), files.find((file) => file.endsWith(".status.json"))!.replace(".status.json", ""));
    expect(status).toMatchObject({ state: "failed" }); expect(calls).toHaveLength(1);
  });
  it("persists write target metadata and releases lock safely", async () => {
    const root = await gitRepo();
    const calls: WorkerRequest[] = [];
    const writeProvider: Provider = {
      id: "codex",
      health: async () => true,
      run: async (request) => {
        calls.push(request);
        await (await import("node:fs/promises")).writeFile(join(request.cwd, "README.md"), "modified in write\n");
        return { provider: "codex", model: request.model, requestedEffort: request.effort, output: "done", success: true, durationMs: 1 };
      },
    };
    const run = await runPipeline(config, { claude: provider("claude", calls), codex: writeProvider }, "implement-review", "Implement changes", root, { role: "implementer", complexity: "normal", risk: "low", preferLocal: false, requireLocal: false, privacySensitive: false, diversity: "none", requiresTools: false }, { write: true, writeMode: "in-place", scope: ["README.md"] });
    expect(run.record.state).toBe("succeeded");
    expect(run.record.writeMode).toBe("in-place");
    expect(run.record.branch).toBe("main");
    expect(run.record.cwd).toBe(root);
    expect(run.record.scope).toEqual(["README.md"]);
    expect(run.record.stages[0]?.changedPaths).toEqual(["README.md"]);
    expect(run.record.stages[0]?.checks?.[0]?.success).toBe(true);
    const lockExists = (await import("node:fs")).existsSync(join(stateDirectoryFor(root), "write-lock.json"));
    expect(lockExists).toBe(false);
  });
  it("handles no-op implementation: fails by default and allows with allowNoop", async () => {
    const root = await gitRepo();
    const noopProvider: Provider = {
      id: "codex",
      health: async () => true,
      run: async (request) => {
        return { provider: "codex", model: request.model, requestedEffort: request.effort, output: "no changes made", success: true, durationMs: 1 };
      },
    };
    await expect(runPipeline(config, { claude: provider("claude", []), codex: noopProvider }, "implement-review", "Implement", root, { role: "implementer", complexity: "normal", risk: "low", preferLocal: false, requireLocal: false, privacySensitive: false, diversity: "none", requiresTools: false }, { write: true, writeMode: "in-place", scope: ["README.md"] })).rejects.toThrow("produced no file changes");
    const lockExists = (await import("node:fs")).existsSync(join(stateDirectoryFor(root), "write-lock.json"));
    expect(lockExists).toBe(false);

    const allowed = await runPipeline(config, { claude: provider("claude", []), codex: noopProvider }, "implement-review", "Implement", root, { role: "implementer", complexity: "normal", risk: "low", preferLocal: false, requireLocal: false, privacySensitive: false, diversity: "none", requiresTools: false }, { write: true, writeMode: "in-place", scope: ["README.md"], allowNoop: true });
    expect(allowed.record.state).toBe("succeeded");
  });
});

async function gitRepo(): Promise<string> {
  const root = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "dtr-git-"));
  directories.push(root, stateDirectoryFor(root));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("git", ["init", "-b", "main", root]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "DTR Test"]);
  await (await import("node:fs/promises")).writeFile(join(root, "README.md"), "initial\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}
