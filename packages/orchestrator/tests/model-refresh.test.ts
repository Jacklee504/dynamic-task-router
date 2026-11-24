import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DtrApplication } from "../src/application.js";
import { mergeGeneratedLayer, mergeUserConfig, parseConfig } from "../src/config.js";
import { compareVersions, deriveLineage, emptyGeneratedLayer, lineageVersion, type GeneratedLayer } from "../src/generated-config.js";
import { gradeRole, refreshModels } from "../src/model-refresh.js";
import { OpenCodeProvider } from "../src/providers/opencode.js";
import { selectModel } from "../src/routing/selector.js";
import { classifyTask } from "../src/routing/classifier.js";
import type { ProcessRunner, Provider, ProviderCapabilities, ProviderId, WorkerRequest } from "../src/types.js";

const models = `
version: 1
models:
  - id: codex-sol
    provider: codex
    family: openai
    model: gpt-5.6-sol
    lineage: "gpt-{version}-sol"
    tier: critical
    roles: { architect: 10, implementer: 8, debugger: 10, reviewer: 10, researcher: 8, test: 8, log-analysis: 8 }
    efforts: [low, medium, high]
    default_effort: high
    capabilities: { tools: true, vision: false, huge_context: true, write_safe: true }
    limits: { context_tokens: 400000 }
    cost: { input_per_million: 10, output_per_million: 40 }
    privacy: { private_code_allowed: true, training_opt_out_required: false }
  - id: codex-luna
    provider: codex
    family: openai
    model: gpt-5.6-luna
    lineage: "gpt-{version}-luna"
    tier: fast
    roles: { architect: 5, implementer: 8, debugger: 7, reviewer: 7, researcher: 7, test: 8, log-analysis: 8 }
    efforts: [low, medium, high]
    default_effort: medium
    capabilities: { tools: true, vision: false, huge_context: false, write_safe: true }
    limits: { context_tokens: 128000 }
    cost: { input_per_million: 1.25, output_per_million: 10 }
    privacy: { private_code_allowed: true, training_opt_out_required: false }
  - id: claude-opus
    provider: claude
    family: anthropic
    model: opus
    tier: critical
    roles: { architect: 10, implementer: 7, debugger: 9, reviewer: 10, researcher: 9, test: 7, log-analysis: 7 }
    efforts: [medium, high]
    default_effort: high
    capabilities: { tools: true, vision: true, huge_context: true, write_safe: true }
    privacy: { private_code_allowed: true, training_opt_out_required: false }
  - id: opencode-old
    provider: opencode
    family: other
    model: opencode/old-model
    roles: { reviewer: 6, researcher: 6 }
    efforts: [medium]
    default_effort: medium
    capabilities: { tools: true }
`;
const policy = `
version: 1
phase: 2
defaults: { readOnly: true, timeoutMs: 1000 }
rules: { automaticSelection: true, requireExplicitFallback: true, requireIndependentFamiliesForHighDiversity: true }
effort: { complexity: { trivial: low, normal: medium, difficult: high, extreme: high }, minimumForRisk: { low: low, medium: medium, high: high } }
diversity: { none: { minimumFamilies: 1 }, low: { minimumFamilies: 1 }, medium: { minimumFamilies: 2 }, high: { minimumFamilies: 2, requireIndependentReview: true } }
`;
const pipelines = "version: 1\ntemplates:\n  - id: default\n    stages:\n      - id: stage\n        role: reviewer\n        strategy: single\n        readOnly: true";

const capabilities: ProviderCapabilities = { workspaceRead: true, workspaceSearch: false, shellAccess: false, nativeTextAttachments: false, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: false };
type Probe = WorkerRequest & { provider: ProviderId };
function fakeProviders(accessible: Set<string>, probes: Probe[] = [], opencodeModels?: string[]): Record<ProviderId, Provider> {
  const entries = (["claude", "codex", "ollama", "openrouter", "featherless", "antigravity", "opencode"] as ProviderId[]).map((id) => [id, {
    id, health: async () => true, capabilities: () => capabilities,
    run: async (request: WorkerRequest) => {
      probes.push({ ...request, provider: id });
      const ok = accessible.has(request.model);
      return { provider: id, model: request.model, requestedEffort: request.effort, output: ok ? "OK" : "", success: ok, durationMs: 1, ...(ok ? {} : { error: "model not found" }) };
    },
  } satisfies Provider]);
  const providers = Object.fromEntries(entries) as Record<ProviderId, Provider>;
  if (opencodeModels) {
    const runner: ProcessRunner = { run: async (command) => ({ stdout: command.args[0] === "models" ? `${opencodeModels.join("\n")}\n` : "opencode 1.0", stderr: "", exitCode: 0, timedOut: false }) };
    providers.opencode = new OpenCodeProvider(runner);
  }
  return providers;
}
function catalog(openai: Record<string, unknown>, anthropic: Record<string, unknown> = {}): typeof fetch {
  return async () => new Response(JSON.stringify({ openai: { models: openai }, anthropic: { models: anthropic } }));
}
const failingCatalog: typeof fetch = async () => new Response("unavailable", { status: 503 });

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "dtr-refresh-test-")); directories.push(directory); return directory; }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("model lineages", () => {
  it("parses dotted, single-number, and hyphenated versions and ignores other lines", () => {
    expect(lineageVersion("gpt-{version}-sol", "gpt-6.2-sol")).toEqual([6, 2]);
    expect(lineageVersion("gpt-{version}-sol", "gpt-6-sol")).toEqual([6]);
    expect(lineageVersion("gpt-{version}-sol", "gpt-6.2-terra")).toBeUndefined();
    expect(lineageVersion("gpt-{version}-sol", "gpt-6.2-sol-mini")).toBeUndefined();
    expect(lineageVersion("claude-fable-{version}", "claude-fable-5-2")).toEqual([5, 2]);
    expect(compareVersions([6], [5, 6])).toBeGreaterThan(0);
    expect(compareVersions([6, 1], [6, 2])).toBeLessThan(0);
    expect(compareVersions([6], [6, 0])).toBe(0);
  });

  it("derives a lineage from the first version token without swallowing date suffixes", () => {
    expect(deriveLineage("gpt-6.2-astra")).toBe("gpt-{version}-astra");
    expect(deriveLineage("claude-fable-5-2")).toBe("claude-fable-{version}");
    expect(deriveLineage("claude-sonnet-4-6-20260101")).toBe("claude-sonnet-{version}-20260101");
    expect(deriveLineage("unversioned")).toBeUndefined();
  });
});

describe("generated model layer", () => {
  const base = (layer: GeneratedLayer) => parseConfig(mergeGeneratedLayer(models, layer), policy, pipelines);

  it("applies a newer lineage upgrade with its catalogue limits and cost", () => {
    const config = base({ ...emptyGeneratedLayer(), upgrades: [{ id: "codex-sol", model: "gpt-6.2-sol", previous: "gpt-5.6-sol", upgradedAt: "2026-11-24T00:00:00.000Z", context_tokens: 1_050_000, cost: { input_per_million: 5, output_per_million: 30 } }] });
    expect(config.models.find((model) => model.id === "codex-sol")).toMatchObject({ model: "gpt-6.2-sol", limits: { contextTokens: 1_050_000 }, cost: { inputPerMillion: 5, outputPerMillion: 30 }, roles: { reviewer: 10 } });
  });

  it("ignores an upgrade the checked-in registry has already overtaken", () => {
    const config = base({ ...emptyGeneratedLayer(), upgrades: [{ id: "codex-sol", model: "gpt-5.4-sol", previous: "gpt-5.2-sol", upgradedAt: "2026-11-24T00:00:00.000Z" }] });
    expect(config.models.find((model) => model.id === "codex-sol")!.model).toBe("gpt-5.6-sol");
  });

  it("lets personal settings override generated grades and replace provisional additions", () => {
    const layer: GeneratedLayer = {
      ...emptyGeneratedLayer(),
      grades: [{ id: "codex-luna", model: "gpt-5.6-luna", roles: { reviewer: 3 }, samples: { reviewer: 4 }, gradedAt: "2026-11-24T00:00:00.000Z" }],
      additions: [{ id: "codex-gpt-astra", provider: "codex", family: "openai", model: "gpt-6.2-astra", lineage: "gpt-{version}-astra", tier: "standard", enabled: true, local: false, provisional: true, roles: { architect: 5, implementer: 5, debugger: 5, reviewer: 5, researcher: 5, test: 5, "log-analysis": 5 }, efforts: ["low", "medium"], default_effort: "medium", capabilities: { tools: true, vision: false, huge_context: true, write_safe: false }, limits: { context_tokens: 1_050_000 }, cost: { input_per_million: 2, output_per_million: 8 }, privacy: { private_code_allowed: true, training_opt_out_required: false }, addedAt: "2026-11-24T00:00:00.000Z" }],
    };
    expect(base(layer).models.find((model) => model.id === "codex-luna")!.roles.reviewer).toBe(3);
    expect(base(layer).models.find((model) => model.id === "codex-gpt-astra")!.provisional).toBe(true);
    const personal = `version: 1
models:
  overrides: [{ id: codex-luna, roles: { reviewer: 9 } }]
  additions:
    - { id: my-astra, provider: codex, family: openai, model: gpt-6.2-astra, roles: { architect: 0, implementer: 0, debugger: 0, reviewer: 8, researcher: 0, test: 0, log-analysis: 0 }, efforts: [medium], default_effort: medium, capabilities: { tools: true } }
`;
    const config = parseConfig(mergeUserConfig(mergeGeneratedLayer(models, layer), personal), policy, pipelines);
    expect(config.models.find((model) => model.id === "codex-luna")!.roles.reviewer).toBe(9);
    expect(config.models.find((model) => model.id === "codex-gpt-astra")).toBeUndefined();
    expect(config.models.find((model) => model.id === "my-astra")!.provisional).toBeUndefined();
  });

  it("clears provisional status once a model has enough graded outcomes", () => {
    const addition = { id: "codex-gpt-astra", provider: "codex" as const, family: "openai", model: "gpt-6.2-astra", tier: "standard" as const, enabled: true as const, local: false as const, provisional: true as const, roles: { architect: 5, implementer: 5, debugger: 5, reviewer: 5, researcher: 5, test: 5, "log-analysis": 5 }, efforts: ["medium" as const], default_effort: "medium" as const, capabilities: { tools: true, vision: false, huge_context: false, write_safe: false as const }, limits: { context_tokens: 128_000 }, cost: { input_per_million: 1, output_per_million: 1 }, privacy: { private_code_allowed: true, training_opt_out_required: false }, addedAt: "2026-11-24T00:00:00.000Z" };
    const graded = base({ ...emptyGeneratedLayer(), additions: [addition], grades: [{ id: addition.id, model: addition.model, roles: { reviewer: 8 }, samples: { reviewer: 10 }, gradedAt: "2026-11-24T00:00:00.000Z" }] });
    expect(graded.models.find((model) => model.id === addition.id)).toMatchObject({ roles: { reviewer: 8 } });
    expect(graded.models.find((model) => model.id === addition.id)!.provisional).toBeUndefined();
  });

  it("keeps provisional models off medium-risk routes unless explicitly selected", () => {
    const addition = { id: "codex-gpt-astra", provider: "codex" as const, family: "openai", model: "gpt-6.2-astra", tier: "critical" as const, enabled: true as const, local: false as const, provisional: true as const, roles: { architect: 10, implementer: 10, debugger: 10, reviewer: 10, researcher: 10, test: 10, "log-analysis": 10 }, efforts: ["low" as const, "medium" as const, "high" as const], default_effort: "medium" as const, capabilities: { tools: true, vision: false, huge_context: false, write_safe: false as const }, limits: { context_tokens: 128_000 }, cost: { input_per_million: 0, output_per_million: 0 }, privacy: { private_code_allowed: true, training_opt_out_required: false }, addedAt: "2026-11-24T00:00:00.000Z" };
    const config = base({ ...emptyGeneratedLayer(), additions: [addition] });
    const medium = classifyTask("Review the change", "reviewer", { risk: "medium", complexity: "normal" });
    expect(selectModel(config, medium)!.explanation.rejected["codex-gpt-astra"]).toContain("provisional model is limited to low-risk tasks until graded");
    expect(selectModel(config, medium, {}, new Set(), { modelId: "codex-gpt-astra" })!.model).toBe("codex-gpt-astra");
    const low = classifyTask("Review the change", "reviewer", { risk: "low", complexity: "normal" });
    expect(selectModel(config, low)!.explanation.rejected["codex-gpt-astra"]).toBeUndefined();
  });
});

describe("refreshModels", () => {
  const config = parseConfig(models, policy, pipelines);

  it("upgrades each lineage to the newest version the account confirms and adds new lines provisionally", async () => {
    const probes: Probe[] = [];
    const report = await refreshModels({
      config, providers: fakeProviders(new Set(["gpt-6.1-sol", "gpt-6-luna", "gpt-6.2-astra"]), probes), stateBase: await temporaryDirectory(), probeLimit: 10,
      fetcher: catalog({
        "gpt-6.2-sol": { limit: { context: 1_050_000 }, cost: { input: 5, output: 30 }, tool_call: true },
        "gpt-6.1-sol": { limit: { context: 1_050_000 }, cost: { input: 4, output: 24 }, tool_call: true },
        "gpt-6-luna": { tool_call: true },
        "gpt-6-astra": { tool_call: true },
        "gpt-6.2-astra": { limit: { context: 1_050_000 }, cost: { input: 2, output: 8 }, tool_call: true },
        "gpt-4o": { tool_call: true },
      }),
    });
    expect(report.layer.upgrades).toEqual([
      expect.objectContaining({ id: "codex-sol", model: "gpt-6.1-sol", previous: "gpt-5.6-sol", context_tokens: 1_050_000, cost: { input_per_million: 4, output_per_million: 24 } }),
      expect.objectContaining({ id: "codex-luna", model: "gpt-6-luna", previous: "gpt-5.6-luna" }),
    ]);
    expect(report.layer.additions).toEqual([expect.objectContaining({ id: "codex-gpt-astra", model: "gpt-6.2-astra", lineage: "gpt-{version}-astra", provisional: true, privacy: { private_code_allowed: true, training_opt_out_required: false }, capabilities: expect.objectContaining({ write_safe: false }) })]);
    expect(report.layer.probes).toEqual(expect.arrayContaining([expect.objectContaining({ model: "gpt-6.2-sol", ok: false }), expect.objectContaining({ model: "gpt-6.1-sol", ok: true })]));
    expect(probes.every((probe) => probe.readOnly && probe.effort === "low" && probe.cwd.includes("dtr-probe-"))).toBe(true);
    expect(probes.some((probe) => probe.model === "gpt-4o")).toBe(false);
    expect(report.changes).toEqual(expect.arrayContaining(["upgraded codex-sol: gpt-5.6-sol -> gpt-6.1-sol", "added provisional codex-gpt-astra (gpt-6.2-astra)"]));
  });

  it("reuses cached probes and keeps earlier results when a catalogue is unavailable", async () => {
    const previous: GeneratedLayer = { ...emptyGeneratedLayer(), upgrades: [{ id: "codex-sol", model: "gpt-6.2-sol", previous: "gpt-5.6-sol", upgradedAt: "2026-11-20T00:00:00.000Z" }], probes: [{ provider: "codex", model: "gpt-6.2-sol", ok: true, at: "2026-11-20T00:00:00.000Z" }] };
    const probes: Probe[] = [];
    const offline = await refreshModels({ config, providers: fakeProviders(new Set(), probes), previous, stateBase: await temporaryDirectory(), fetcher: failingCatalog });
    expect(offline.layer.upgrades).toEqual(previous.upgrades);
    const online = await refreshModels({ config, providers: fakeProviders(new Set(), probes), previous, stateBase: await temporaryDirectory(), fetcher: catalog({ "gpt-6.2-sol": {} }) });
    expect(online.layer.upgrades).toEqual([expect.objectContaining({ model: "gpt-6.2-sol", upgradedAt: "2026-11-20T00:00:00.000Z" })]);
    expect(probes).toEqual([]);
    expect(online.changes).toEqual([]);
  });

  it("stops at the probe budget and reports the remaining work as pending", async () => {
    const report = await refreshModels({ config, providers: fakeProviders(new Set(["gpt-6.2-sol", "gpt-6-luna"])), stateBase: await temporaryDirectory(), probeLimit: 1, fetcher: catalog({ "gpt-6.2-sol": {}, "gpt-6-luna": {} }) });
    expect(report.layer.upgrades.map((upgrade) => upgrade.id)).toEqual(["codex-sol"]);
    expect(report.pending).toEqual(["codex-luna: gpt-6-luna awaits an account probe"]);
  });

  it("disables models an account-aware CLI no longer lists", async () => {
    const report = await refreshModels({ config, providers: fakeProviders(new Set(), [], ["opencode/new-model"]), stateBase: await temporaryDirectory(), fetcher: failingCatalog });
    expect(report.layer.disabled).toEqual([expect.objectContaining({ id: "opencode-old", model: "opencode/old-model" })]);
    expect(report.layer.additions).toEqual([]);
  });

  it("grades the exact model that ran from reviewed outcomes and rolls back an upgrade that only fails", async () => {
    const stateBase = await temporaryDirectory(); const runs = join(stateBase, "repo-hash", "runs"); await mkdir(runs, { recursive: true });
    const statuses = ["accepted", "accepted", "rejected", "accepted"];
    await Promise.all(statuses.map((status, index) => writeFile(join(runs, `00000000-0000-4000-8000-00000000000${index}.status.json`), JSON.stringify({ id: `run-${index}`, state: "succeeded", strategy: "single", startedAt: "2026-11-24T00:00:00.000Z", stages: [{ id: "route", state: "succeeded", model: "codex-luna", role: "reviewer", provider: "codex", providerModel: "gpt-5.6-luna" }], outcome: { status } }))));
    await writeFile(join(runs, "other-model.status.json"), JSON.stringify({ strategy: "single", stages: [{ model: "codex-luna", role: "reviewer", providerModel: "gpt-5.5-luna" }], outcome: { status: "rejected" } }));
    await Promise.all([0, 1, 2].map((index) => writeFile(join(runs, `2026-11-24-log-${index}.json`), JSON.stringify({ provider: "codex", model: "gpt-6.2-sol", role: "reviewer", success: false, durationMs: 1, timestamp: "2026-11-24T01:00:00.000Z" }))));
    const previous: GeneratedLayer = { ...emptyGeneratedLayer(), upgrades: [{ id: "codex-sol", model: "gpt-6.2-sol", previous: "gpt-5.6-sol", upgradedAt: "2026-11-24T00:00:00.000Z" }] };
    const report = await refreshModels({ config, providers: fakeProviders(new Set(["gpt-6.2-sol"])), previous, stateBase, fetcher: catalog({ "gpt-6.2-sol": {} }) });
    expect(report.layer.grades).toEqual([expect.objectContaining({ id: "codex-luna", model: "gpt-5.6-luna", roles: { reviewer: gradeRole(7, [1, 1, 0, 1]) }, samples: { reviewer: 4 } })]);
    expect(report.layer.blocked).toEqual([expect.objectContaining({ provider: "codex", model: "gpt-6.2-sol" })]);
    expect(report.layer.upgrades).toEqual([]);
    expect(report.changes).toEqual(expect.arrayContaining(["rolled back codex-sol: gpt-6.2-sol -> gpt-5.6-sol (3 failed runs)"]));
  });

  it("blends prior scores with outcomes and never grades below 1", () => {
    expect(gradeRole(7, [1, 1, 1, 1, 1])).toBe(9);
    expect(gradeRole(7, [0, 0, 0, 0, 0])).toBe(4);
    expect(gradeRole(2, Array.from({ length: 50 }, () => 0))).toBe(1);
  });
});

describe("DtrApplication.updateModels", () => {
  it("writes the generated layer only outside dry runs and routes with it afterwards", async () => {
    const directory = await temporaryDirectory(); const configDir = join(directory, "config"); await mkdir(configDir);
    await Promise.all([writeFile(join(configDir, "models.yaml"), models), writeFile(join(configDir, "routing-policy.yaml"), policy), writeFile(join(configDir, "pipelines.yaml"), pipelines)]);
    const generated = join(directory, "models.generated.json");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = catalog({ "gpt-6.2-sol": {} });
    try {
      const app = new DtrApplication(configDir, directory, fakeProviders(new Set(["gpt-6.2-sol"])), join(directory, "config.yaml"), generated);
      const dry = await app.updateModels({ dryRun: true });
      expect(dry).toMatchObject({ written: false, path: generated });
      await expect(readFile(generated, "utf8")).rejects.toThrow();
      expect((await app.config()).models.find((model) => model.id === "codex-sol")!.model).toBe("gpt-5.6-sol");
      await app.updateModels();
      expect((await app.config()).models.find((model) => model.id === "codex-sol")!.model).toBe("gpt-6.2-sol");
      expect(await app.autoUpdateModels()).toBeUndefined();
    } finally { globalThis.fetch = originalFetch; }
  });
});
