import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { buildCompactTaskPacket, compactTaskPrompt, DISPATCH_CONTRACT, normalizeCompactTask, normalizeRelevantFiles, truncateTaskResult } from "../src/contracts.js";
import { diagnoseProviders } from "../src/doctor.js";
import { evaluateDirectory } from "../src/evals.js";
import { OpenRouterProvider, readOpenRouterCatalog, refreshOpenRouterCatalog } from "../src/providers/openrouter.js";
import { selectModel } from "../src/routing/selector.js";
import { summarizeRuns } from "../src/stats.js";
import { attachRunOutcome, createRunRecord, writeRunRecord } from "../src/telemetry/run-registry.js";
import type { ProcessRunner, WorkerRequest } from "../src/types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const request: WorkerRequest = { prompt: "Inspect a bounded task", cwd: "/tmp", role: "reviewer", model: "qwen/test", effort: "medium", readOnly: true };
const models = `
version: 1
models:
  - id: remote-paid
    provider: openrouter
    family: qwen
    model: qwen/paid
    enabled: true
    local: false
    roles: { architect: 0, implementer: 0, debugger: 0, reviewer: 9, researcher: 0, test: 0, log-analysis: 0 }
    efforts: [low, medium, high]
    default_effort: medium
    capabilities: { tools: false, vision: false, huge_context: false, write_safe: false }
    cost: { input_per_million: 1000, output_per_million: 1000 }
    privacy: { private_code_allowed: false, training_opt_out_required: true }
  - id: local-free
    provider: ollama
    family: qwen-local
    model: local
    enabled: true
    local: true
    roles: { architect: 0, implementer: 0, debugger: 0, reviewer: 8, researcher: 0, test: 0, log-analysis: 0 }
    efforts: [low, medium, high]
    default_effort: medium
    capabilities: { tools: false, vision: false, huge_context: false, write_safe: false }
    cost: { input_per_million: 0, output_per_million: 0 }
    privacy: { private_code_allowed: true, training_opt_out_required: false }
`;
const policy = `
version: 1
phase: 2
defaults: { readOnly: true, timeoutMs: 1000 }
rules: { automaticSelection: true, requireExplicitFallback: true, requireIndependentFamiliesForHighDiversity: true }
effort: { complexity: { trivial: low, normal: medium, difficult: high, extreme: xhigh }, minimumForRisk: { low: low, medium: medium, high: high } }
diversity: { none: { minimumFamilies: 1 }, low: { minimumFamilies: 1 }, medium: { minimumFamilies: 2 }, high: { minimumFamilies: 2, requireIndependentReview: true } }
budget: { mode: capped, max_estimated_cost_usd: 0.01 }
`;
const config = parseConfig(models, policy);
const profile = { role: "reviewer" as const, complexity: "normal" as const, risk: "low" as const, preferLocal: false, requireLocal: false, privacySensitive: false, privateCode: false, allowRemote: true, diversity: "none" as const, requiresTools: false };

describe("optional OpenRouter", () => {
  it("is disabled without a key and never exposes one", async () => {
    const provider = new OpenRouterProvider(undefined);
    expect(await provider.health()).toBe(false); const result = await provider.run(request);
    expect(result.success).toBe(false); expect(result.error).toContain("disabled"); expect(JSON.stringify(result)).not.toContain("OPENROUTER_API_KEY");
  });
  it("uses an explicit model through a mocked request", async () => {
    let body = ""; const provider = new OpenRouterProvider("test-key", async (_url, init) => { body = String(init?.body); return new Response(JSON.stringify({ model: "qwen/test", choices: [{ message: { content: "bounded result" } }], usage: { total_tokens: 17 } }), { status: 200 }); });
    const result = await provider.run(request);
    expect(result).toMatchObject({ success: true, output: "bounded result", providerMetadata: { returned_model: "qwen/test", total_tokens: 17 } }); expect(body).toContain("qwen/test");
  });
});

describe("bounded task contracts", () => {
  it("rejects oversized input and caps returned task text", () => {
    expect(() => compactTaskPrompt("x".repeat(6_001))).toThrow("exceeds");
    expect(truncateTaskResult("x".repeat(1_201))).toContain("Result truncated");
  });
  it("builds a short task packet from task text and listed paths only", () => {
    expect(DISPATCH_CONTRACT).toContain("100 words");
    expect(buildCompactTaskPacket("Review the parser's error path", "src/parser.ts, test/parser.test.ts")).toContain("- src/parser.ts");
    expect(buildCompactTaskPacket("Review the parser's error path", "src/parser.ts")).not.toContain("--- src/parser.ts ---");
    expect(() => normalizeCompactTask(Array.from({ length: 101 }, () => "word").join(" "))).toThrow("100-word limit");
    expect(() => normalizeRelevantFiles("../secret.txt")).toThrow("relative path");
  });
  it("accounts for provider additions and reserved context before dispatch", () => {
    const policy = { charsPerToken: 4, maxInputTokens: 80, responseReserveTokens: 0, hostContextReserveTokens: { claude: 0 }, providers: { claude: { append: ["Follow CLAUDE.md when present."] } } };
    const target = { provider: "claude" as const, model: "test", contextTokens: 64 };
    expect(compactTaskPrompt("Review the parser", policy, target)).toContain("Follow CLAUDE.md when present.");
    expect(() => compactTaskPrompt("x".repeat(300), policy, target)).toThrow("64-token budget");
    expect(() => compactTaskPrompt("Review", { ...policy, responseReserveTokens: 64 }, target)).toThrow("exhausted");
  });
});

describe("privacy and cost eligibility", () => {
  it("filters private code before score and applies caps without changing policy", () => {
    const before = JSON.stringify(config); expect(selectModel(config, { ...profile, privateCode: true })?.model).toBe("local-free");
    expect(selectModel(config, profile)?.model).toBe("local-free"); expect(JSON.stringify(config)).toBe(before);
  });
});

describe("provider diagnostics", () => {
  it("reports configured local-model readiness without exposing a credential", async () => {
    const runner: ProcessRunner = {
      run: async (command) => {
        if (command.command === "ollama" && command.args[0] === "--version") return { stdout: "ollama version 1.0", stderr: "", exitCode: 0, timedOut: false };
        if (command.command === "ollama" && command.args[0] === "list") return { stdout: "NAME ID SIZE\nlocal hash 1 GB", stderr: "", exitCode: 0, timedOut: false };
        return { stdout: "", stderr: "", exitCode: 1, timedOut: false };
      },
    };
    const report = await diagnoseProviders(runner, config.models, "/tmp", false);
    expect(report.ready).toBe(true);
    expect(report.providers.ollama).toMatchObject({ ready: true, configuredModels: [{ id: "local-free", model: "local", installed: true }] });
    expect(report.providers.openrouter).toEqual({ ready: false, credentialConfigured: false });
    expect(JSON.stringify(report)).not.toContain("OPENROUTER_API_KEY");
  });
});

describe("catalog, evals, and reviewed outcomes", () => {
  it("uses a cache when refresh is unavailable and marks stale metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "dtr-catalog-")); directories.push(root);
    await refreshOpenRouterCatalog(root, "key", async () => new Response(JSON.stringify({ data: [{ id: "qwen/test" }] }), { status: 200 }));
    await writeFile(join(root, "cache", "openrouter-models.json"), JSON.stringify({ fetchedAt: "2000-01-01T00:00:00.000Z", models: [] }));
    await expect(refreshOpenRouterCatalog(root, "key", async () => new Response("no", { status: 500 }))).rejects.toThrow("refresh failed");
    await expect(readOpenRouterCatalog(root)).resolves.toMatchObject({ stale: true, cache: { models: [] } });
  });
  it("runs version-controlled evals and only suggests reviewed changes after enough samples", async () => {
    const root = await mkdtemp(join(tmpdir(), "dtr-stats-")); directories.push(root);
    const record = await createRunRecord(root, "single"); record.state = "succeeded"; await writeRunRecord(root, record); await attachRunOutcome(root, record.id, { status: "accepted", manualScore: 1 });
    await expect(summarizeRuns(root)).resolves.toMatchObject({ runs: 1, outcomes: { accepted: 1 } });
    const actual = await (await import("../src/config.js")).loadConfig(resolve(process.cwd(), "../../config"));
    const before = JSON.stringify(actual);
    const evaluation = await evaluateDirectory(actual, resolve(process.cwd(), "../../evals/cases"));
    expect(evaluation.total).toBeGreaterThanOrEqual(7);
    expect(evaluation.passed).toBe(evaluation.total);
    expect(JSON.stringify(actual)).toBe(before);
  });
});
