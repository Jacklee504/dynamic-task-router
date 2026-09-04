import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { selectEffort } from "../src/routing/effort.js";
import { eligibleSelections, selectModel } from "../src/routing/selector.js";
import { runFanout } from "../src/strategies/fanout.js";
import { runSingle } from "../src/strategies/single.js";
import type { Provider, TaskProfile, WorkerRequest } from "../src/types.js";

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
  - id: qwen-local
    provider: ollama
    family: qwen
    model: local
    enabled: true
    local: true
    roles: { architect: 4, implementer: 5, debugger: 5, reviewer: 6, researcher: 7, test: 7, log-analysis: 9 }
    efforts: [medium, high]
    default_effort: medium
    capabilities: { tools: false, vision: false, huge_context: false, write_safe: false }
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
prompt:
  charsPerToken: 4
  maxInputTokens: 1500
  responseReserveTokens: 1024
  hostContextReserveTokens: {}
  providers:
    claude:
      append: ["Follow applicable CLAUDE.md instructions before starting."]
`;
const config = parseConfig(models, policy);
const profile = (overrides: Partial<TaskProfile> = {}): TaskProfile => ({ role: "reviewer", complexity: "normal", risk: "low", preferLocal: false, requireLocal: false, privacySensitive: false, diversity: "none", requiresTools: false, ...overrides });

describe("routing policy", () => {
  it.each([
    ["reviewer", "claude-review"],
    ["implementer", "codex-build"],
    ["log-analysis", "qwen-local"],
  ] as const)("uses role priors for %s", (role, expected) => {
    expect(selectModel(config, profile({ role }))?.model).toBe(expected);
  });
  it("selects the strongest eligible model for the requested role", () => {
    expect(selectModel(config, profile())?.model).toBe("claude-review");
  });
  it("prefers the smallest eligible quality tier before role-score tie breaking", () => {
    const tiered = structuredClone(config);
    tiered.models.find((model) => model.id === "claude-review")!.tier = "critical";
    tiered.models.find((model) => model.id === "codex-build")!.tier = "standard";
    tiered.models.find((model) => model.id === "qwen-local")!.tier = "fast";
    const normal = selectModel(tiered, profile());
    expect(normal?.model).toBe("codex-build");
    expect(normal?.explanation.reasons.join(" ")).toContain("required tier=standard");
    const difficult = selectModel(tiered, profile({ complexity: "difficult" }));
    expect(difficult?.model).toBe("claude-review");
  });
  it("uses local preference and enforces a local requirement", () => {
    expect(selectModel(config, profile({ role: "log-analysis", preferLocal: true }))?.model).toBe("qwen-local");
    const selection = selectModel(config, profile({ role: "log-analysis", requireLocal: true }));
    expect(selection?.model).toBe("qwen-local");
    expect(selection?.explanation.rejected["claude-review"]).toContain("local-only task");
  });
  it("maps unsupported effort explicitly and raises high-risk effort", () => {
    const local = config.models.find((model) => model.id === "qwen-local")!;
    expect(selectEffort(config, local, profile({ complexity: "trivial" }))).toMatchObject({ requested: "low", effective: "medium" });
    expect(selectEffort(config, local, profile({ risk: "high" }))).toMatchObject({ requested: "high", effective: "high" });
  });
  it("rejects weak models for high-risk review", () => {
    const selection = selectModel(config, profile({ risk: "high" }));
    expect(selection?.model).toBe("claude-review");
    expect(selection?.explanation.rejected["qwen-local"]?.join(" ")).toContain("below minimum 8");
  });
  it("uses independent families and reports unavailable fallbacks", () => {
    expect(eligibleSelections(config, profile({ role: "debugger" })).map((item) => item.model)).toEqual(["codex-build", "claude-review", "qwen-local"]);
    const fallback = selectModel(config, profile(), { "claude-review": false });
    expect(fallback?.model).toBe("codex-build");
    expect(fallback?.explanation.rejected["claude-review"]).toContain("provider unavailable");
  });
  it("fails closed for privacy-sensitive work when no local model is available", () => {
    expect(selectModel(config, profile({ privacySensitive: true }), { "qwen-local": false })).toBeUndefined();
  });
});

function fakeProvider(id: "claude" | "codex", calls: WorkerRequest[]): Provider {
  return {
    id,
    health: async () => true,
    run: async (request) => {
      calls.push(request);
      return { provider: id, model: request.model, requestedEffort: request.effort, effectiveEffort: request.effort, output: `${id} result`, success: true, durationMs: 1 };
    },
  };
}

describe("execution strategies", () => {
  it("records single-run selection metadata", async () => {
    const calls: WorkerRequest[] = [];
    const providers = { claude: fakeProvider("claude", calls), codex: fakeProvider("codex", calls) };
    const run = await runSingle("/tmp/dtr-routing-test/config", config, providers, "Review this", "/tmp", profile());
    expect(run.routing.selectedModel).toBe("claude-review");
    expect(run.routing.requestedEffort).toBe("medium");
    expect(calls[0]?.readOnly).toBe(true);
    expect(calls[0]?.prompt).toContain("Follow applicable CLAUDE.md instructions before starting.");
  });
  it("fans out to independent families without passing sibling outputs", async () => {
    const calls: WorkerRequest[] = [];
    const providers = { claude: fakeProvider("claude", calls), codex: fakeProvider("codex", calls) };
    const runs = await runFanout("/tmp/dtr-routing-test/config", config, providers, "Find the root cause", "/tmp", profile({ role: "debugger", complexity: "difficult", diversity: "medium" }), 2);
    expect(runs.map((run) => run.model)).toEqual(["codex-build", "claude-review"]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.prompt.startsWith("Find the root cause") && call.prompt.includes("120 words maximum") && call.readOnly)).toBe(true);
  });
  it("emits per-worker lifecycle events during fanout", async () => {
    const calls: WorkerRequest[] = [];
    const providers = { claude: fakeProvider("claude", calls), codex: fakeProvider("codex", calls) };
    const started: string[] = []; const completed: string[] = []; const failed: string[] = [];
    const lifecycle = {
      onWorkerStarted: (info: { workerId: string }) => { started.push(info.workerId); },
      onWorkerCompleted: (info: { workerId: string }) => { completed.push(info.workerId); },
      onWorkerFailed: (info: { workerId: string }) => { failed.push(info.workerId); },
    };
    await runFanout("/tmp/dtr-routing-test/config", config, providers, "Find the root cause", "/tmp", profile({ role: "debugger", complexity: "difficult", diversity: "medium" }), 2, undefined, undefined, lifecycle);
    expect(started.sort()).toEqual(["claude-review", "codex-build"]);
    expect(completed.sort()).toEqual(["claude-review", "codex-build"]);
    expect(failed).toEqual([]);
  });
  it("returns an explicit degraded result when enough families are unavailable", async () => {
    const calls: WorkerRequest[] = [];
    const providers = { claude: fakeProvider("claude", calls), codex: fakeProvider("codex", calls) };
    await expect(runFanout("/tmp/dtr-routing-test/config", config, providers, "Review", "/tmp", profile({ diversity: "high" }), 3)).rejects.toThrow("Degraded routing");
    expect(calls).toHaveLength(0);
  });
});
