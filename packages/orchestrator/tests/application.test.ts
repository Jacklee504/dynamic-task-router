import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DtrApplication, readOllamaRuntime, safeError, type DtrEvent } from "../src/application.js";
import { stateDirectoryFor } from "../src/state.js";
import type { Provider, ProviderId, WorkerRequest, WorkerResult } from "../src/types.js";

const models = `
version: 1
models:
  - id: claude-review
    provider: claude
    family: anthropic
    model: review
    enabled: true
    local: false
    roles: { architect: 8, implementer: 7, debugger: 8, reviewer: 10, researcher: 7, test: 7, log-analysis: 7 }
    efforts: [medium, high]
    default_effort: high
    capabilities: { tools: true, vision: false, huge_context: true, write_safe: false }
  - id: codex-build
    provider: codex
    family: openai
    model: build
    enabled: true
    local: false
    roles: { architect: 9, implementer: 9, debugger: 9, reviewer: 8, researcher: 8, test: 9, log-analysis: 8 }
    efforts: [low, medium, high, xhigh]
    default_effort: high
    capabilities: { tools: true, vision: false, huge_context: true, write_safe: false }
`;
const policy = `
version: 1
phase: 2
defaults: { readOnly: true, timeoutMs: 1000 }
rules: { automaticSelection: true, requireExplicitFallback: true, requireIndependentFamiliesForHighDiversity: true }
effort:
  complexity: { trivial: low, normal: medium, difficult: high, extreme: xhigh }
  minimumForRisk: { low: low, medium: medium, high: high }
diversity:
  none: { minimumFamilies: 1 }
  low: { minimumFamilies: 1 }
  medium: { minimumFamilies: 2 }
  high: { minimumFamilies: 2, requireIndependentReview: true }
`;
const pipelines = `
version: 1
templates:
  - id: debug-review
    stages:
      - { id: diagnose, role: debugger, strategy: single, readOnly: true }
      - { id: review, role: reviewer, strategy: single, readOnly: true, dependsOn: [diagnose], diversity: medium }
`;

const trash: string[] = [];
afterEach(async () => { await Promise.all(trash.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function scaffold(): Promise<{ configDir: string; cwd: string }> {
  const configDir = await mkdtemp(join(tmpdir(), "dtr-app-config-"));
  await writeFile(join(configDir, "models.yaml"), models, "utf8");
  await writeFile(join(configDir, "routing-policy.yaml"), policy, "utf8");
  await writeFile(join(configDir, "pipelines.yaml"), pipelines, "utf8");
  const cwd = await mkdtemp(join(tmpdir(), "dtr-app-cwd-"));
  trash.push(configDir, cwd, stateDirectoryFor(cwd));
  return { configDir, cwd };
}

type ProviderScript = { output?: string; success?: boolean; error?: string; delayMs?: number; throwError?: string };
function fakeProviders(script: Partial<Record<ProviderId, ProviderScript>> = {}): Record<ProviderId, Provider> {
  const build = (id: ProviderId): Provider => ({
    id,
    health: async () => true,
    run: async (request: WorkerRequest): Promise<WorkerResult> => {
      const spec = script[id] ?? {};
      if (spec.throwError) throw new Error(spec.throwError);
      if (spec.delayMs) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, spec.delayMs);
        request.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
      });
      const success = spec.success !== false;
      return { provider: id, model: request.model, requestedEffort: request.effort, effectiveEffort: request.effort, output: spec.output ?? `${id} ok`, success, durationMs: 1, ...(success ? {} : { error: spec.error ?? "worker failed" }) };
    },
  });
  return { claude: build("claude"), codex: build("codex"), ollama: build("ollama"), openrouter: build("openrouter"), featherless: build("featherless"), antigravity: build("antigravity"), opencode: build("opencode") };
}

describe("application observability", () => {
  it("normalizes documented local Ollama runtime metadata without a live server", async () => {
    const runtime = await readOllamaRuntime(async () => new Response(JSON.stringify({ models: [{ name: "qwen3.5:9b", size: 5_500_000_000, size_vram: 4_000_000_000, context_length: 4096, expires_at: "2030-01-01T00:00:00Z" }] }), { status: 200 }));
    expect(runtime).toMatchObject({ available: true, models: [{ name: "qwen3.5:9b", runtimeSizeBytes: 4_000_000_000, contextLength: 4096 }] });
  });
  it("redacts provider-style credentials from UI-safe errors", () => {
    expect(safeError("OPENROUTER_API_KEY=secret Authorization: Bearer abc")).not.toContain("secret");
    expect(safeError("OPENROUTER_API_KEY=secret Authorization: Bearer abc")).not.toContain("abc");
    expect(safeError("FEATHERLESS_API_KEY=secret")).not.toContain("secret");
  });
  it("resolves persisted runs by unambiguous id prefix", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    const run = await app.run({ prompt: "Review one", role: "reviewer", cwd });
    await expect(app.getRun(run.runId.slice(0, 8))).resolves.toMatchObject({ id: run.runId });
    await expect(app.getRun("00000000-0000")).resolves.toBeNull();
  });
});

describe("DtrApplication event flow", () => {
  it("prepares a compact packet with typed relative paths without invoking a worker", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    const prepared = await app.prepare({ prompt: "Review the parser error path", files: ["src/parser.ts", "test/parser.test.ts"], role: "reviewer", cwd });
    expect(prepared.files).toEqual(["src/parser.ts", "test/parser.test.ts"]);
    expect(prepared.packet).toContain("- src/parser.ts");
    expect(prepared.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("emits run-created, route-selected, worker-started, worker-completed, run-completed for a successful single run", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    const events: DtrEvent[] = [];
    app.onEvent((event) => { events.push(event); });
    const outcome = await app.run({ prompt: "Review the src directory", role: "reviewer", cwd });
    expect(outcome.result.success).toBe(true);
    const types = events.map((event) => event.type);
    expect(types).toEqual(["run-created", "route-selected", "worker-started", "worker-completed", "run-completed"]);
    expect(events.every((event) => "runId" in event ? event.runId === outcome.runId : true)).toBe(true);
  });

  it("emits per-worker events for fanout with one runId shared across selections", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    const events: DtrEvent[] = [];
    app.onEvent((event) => { events.push(event); });
    const runs = await app.fanout({ prompt: "Trace the reconnect failure", role: "debugger", profile: { complexity: "difficult", diversity: "medium" }, cwd, families: 2 });
    expect(runs).toHaveLength(2);
    const runId = runs[0]!.runId;
    const starts = events.filter((event) => event.type === "worker-started");
    const completes = events.filter((event) => event.type === "worker-completed");
    expect(starts).toHaveLength(2);
    expect(completes).toHaveLength(2);
    expect(new Set(starts.map((event) => event.type === "worker-started" ? event.workerId : ""))).toEqual(new Set(["codex-build", "claude-review"]));
    expect(events.every((event) => "runId" in event ? event.runId === runId : true)).toBe(true);
    expect(events.at(-1)?.type).toBe("run-completed");
  });

  it("emits per-stage events for pipeline using stage ids as worker ids", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    const events: DtrEvent[] = [];
    app.onEvent((event) => { events.push(event); });
    const run = await app.pipeline({ prompt: "Trace the issue", role: "debugger", cwd, template: "debug-review" });
    expect(run.record.state).toBe("succeeded");
    const stageWorkers = events.filter((event) => event.type === "worker-started").map((event) => event.type === "worker-started" ? event.workerId : "");
    expect(stageWorkers).toEqual(["diagnose", "review"]);
    expect(events.at(0)?.type).toBe("run-created");
    expect(events.at(-1)?.type).toBe("run-completed");
  });

  it("emits worker-failed and run-failed when a provider reports a failure", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders({ claude: { success: false, error: "boom" } }), null);
    const events: DtrEvent[] = [];
    app.onEvent((event) => { events.push(event); });
    const outcome = await app.run({ prompt: "Review the src directory", role: "reviewer", cwd });
    expect(outcome.result.success).toBe(false);
    const types = events.map((event) => event.type);
    expect(types).toContain("worker-failed");
    expect(types.at(-1)).toBe("run-failed");
  });
});

describe("DtrApplication abort", () => {
  it("aborts an in-flight run and reports it in the run record + events", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders({ claude: { delayMs: 5_000 } }), null);
    const events: DtrEvent[] = [];
    app.onEvent((event) => { events.push(event); });
    const runPromise = app.run({ prompt: "Review", role: "reviewer", cwd });
    // Wait for run-created so we know the runId is registered
    await new Promise<void>((resolve) => {
      const check = () => { if (events.some((event) => event.type === "run-created")) resolve(); else setTimeout(check, 5); };
      check();
    });
    const created = events.find((event) => event.type === "run-created")!;
    const runId = created.type === "run-created" ? created.runId : "";
    const result = await app.abort(runId);
    expect(result).toMatchObject({ accepted: true, state: "aborting" });
    await runPromise.catch(() => undefined);
    const stored = await app.getRun(runId);
    expect(stored?.state === "aborted" || stored?.state === "failed").toBe(true);
    expect(events.some((event) => event.type === "run-aborting")).toBe(true);
  });

  it("returns unavailable when aborting an unknown run", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    await expect(app.abort("does-not-exist")).resolves.toEqual({ runId: "does-not-exist", accepted: false, state: "unavailable" });
  });
});

describe("DtrApplication failure record hygiene", () => {
  it("marks the stage and record failed when a provider throws", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders({ claude: { throwError: "provider exploded" } }), null);
    await expect(app.run({ prompt: "Review the src directory", role: "reviewer", cwd })).rejects.toThrow("provider exploded");
    const runs = await app.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("failed");
    expect(runs[0]?.stages[0]?.state).toBe("failed");
  });

  it("marks a fanout record failed when routing cannot satisfy the family requirement", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    await expect(app.fanout({ prompt: "Review the src directory", role: "reviewer", cwd, families: 3 })).rejects.toThrow("Degraded routing");
    const runs = await app.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("failed");
    expect(runs[0]?.error).toContain("Degraded routing");
  });

  it("marks a pipeline record failed when the template is unknown", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    await expect(app.pipeline({ prompt: "Review", role: "reviewer", cwd, template: "does-not-exist" })).rejects.toThrow("Unknown pipeline template");
    const runs = await app.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("failed");
    expect(runs[0]?.error).toContain("Unknown pipeline template");
  });

  it("skips corrupt run records instead of hiding all runs", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    const run = await app.run({ prompt: "Review one", role: "reviewer", cwd });
    await writeFile(join(stateDirectoryFor(cwd), "runs", "00000000-0000-0000-0000-0000000bad00.status.json"), "{not json", "utf8");
    const listed = await app.listRuns();
    expect(listed.map((record) => record.id)).toEqual([run.runId]);
  });
});

describe("DtrApplication telemetry lookup", () => {
  it("returns null for an unknown run and lists runs after they complete", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    expect(await app.getRun("00000000-0000-0000-0000-000000000000")).toBeNull();
    const first = await app.run({ prompt: "Review one", role: "reviewer", cwd });
    const second = await app.run({ prompt: "Review two", role: "reviewer", cwd });
    const listed = await app.listRuns();
    expect(listed.map((record) => record.id).sort()).toEqual([first.runId, second.runId].sort());
    const stored = await app.getRun(first.runId);
    expect(stored?.state).toBe("succeeded");
  });

  it("stores parent review outcomes as metadata only", async () => {
    const { configDir, cwd } = await scaffold();
    const app = new DtrApplication(configDir, cwd, fakeProviders(), null);
    const run = await app.run({ prompt: "Review one", role: "reviewer", cwd });
    const stored = await app.outcome(run.runId, { status: "accepted", manualScore: 1 });
    expect(stored.outcome).toEqual({ status: "accepted", manualScore: 1 });
  });
});
