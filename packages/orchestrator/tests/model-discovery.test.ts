import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { assessModelDrift, discoverModels, parseModelsDevCatalog } from "../src/model-discovery.js";
import { OpenCodeProvider } from "../src/providers/opencode.js";
import type { ProcessRunner, Provider, ProviderCapabilities, ProviderId } from "../src/types.js";

const models = `
version: 1
models:
  - id: codex-luna
    provider: codex
    family: openai
    model: gpt-5.6-luna
    enabled: true
    local: false
    roles: { architect: 3, implementer: 7, debugger: 6, reviewer: 5, researcher: 5, test: 7, log-analysis: 6 }
    efforts: [low, medium, high]
    default_effort: medium
    capabilities: { tools: true, vision: false, huge_context: false, write_safe: true }
    cost: { input_per_million: 0, output_per_million: 0 }
    privacy: { private_code_allowed: true, training_opt_out_required: false }
  - id: claude-opus
    provider: claude
    family: anthropic
    model: opus
    enabled: true
    local: false
    roles: { architect: 8, implementer: 7, debugger: 8, reviewer: 9, researcher: 7, test: 7, log-analysis: 7 }
    efforts: [low, medium, high]
    default_effort: high
    capabilities: { tools: true, vision: false, huge_context: true, write_safe: true }
    cost: { input_per_million: 0, output_per_million: 0 }
    privacy: { private_code_allowed: true, training_opt_out_required: false }
`;
const policy = `
version: 1
phase: 2
defaults: { readOnly: true, timeoutMs: 1000 }
rules: { automaticSelection: true, requireExplicitFallback: true, requireIndependentFamiliesForHighDiversity: true }
effort: { complexity: { trivial: low, normal: medium, difficult: high, extreme: high }, minimumForRisk: { low: low, medium: medium, high: high } }
diversity: { none: { minimumFamilies: 1 }, low: { minimumFamilies: 1 }, medium: { minimumFamilies: 2 }, high: { minimumFamilies: 2, requireIndependentReview: true } }
`;
const capabilities: ProviderCapabilities = { workspaceRead: false, workspaceSearch: false, shellAccess: false, nativeTextAttachments: false, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: false };
const providers = Object.fromEntries((["claude", "codex", "ollama", "openrouter", "featherless", "antigravity", "opencode"] as ProviderId[]).map((id) => [id, { id, health: async () => false, capabilities: () => capabilities, run: async () => { throw new Error("not used"); } } satisfies Provider])) as Record<ProviderId, Provider>;

describe("model discovery", () => {
  it("extracts only supported provider records and ignores retired catalog entries", () => {
    const parsed = parseModelsDevCatalog({
      providers: {
        openai: { models: { "gpt-6-luna": { name: "GPT-6 Luna", limit: { context: 128000 }, reasoning: true } } },
        anthropic: { models: { "claude-opus-5": { tool_call: true } } },
        ignored: { models: { example: {} } },
        openrouter: { models: { retired: { status: "deprecated" } } },
      },
    });
    expect(parsed).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "codex", model: "gpt-6-luna", metadata: { name: "GPT-6 Luna", contextTokens: 128000, reasoning: true } }),
      expect.objectContaining({ provider: "claude", model: "claude-opus-5", metadata: { tools: true } }),
    ]));
    expect(parsed).toHaveLength(2);
  });

  it("reports catalog candidates without silently adding profiles and recognises Claude aliases", async () => {
    const config = parseConfig(models, policy);
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      openai: { models: { "gpt-6-luna": {}, "gpt-6-astra": { reasoning: true } } },
      anthropic: { models: { "claude-opus-5": {}, "claude-sonnet-5": {} } },
    }));
    const report = await discoverModels(config, providers, "/tmp", { fetcher });
    expect(report.catalog.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "codex", model: "gpt-6-astra", coverage: "unprofiled" }),
      expect.objectContaining({ provider: "claude", model: "claude-sonnet-5", coverage: "unprofiled" }),
    ]));
    expect(report.catalog.candidates.find((item) => item.model === "gpt-5.6-luna")).toBeUndefined();
    expect(report.catalog.candidates.find((item) => item.model === "claude-opus-5")).toBeUndefined();
    expect(report.sources.find((item) => item.id === "models.dev")).toMatchObject({ status: "refreshed" });
    expect(report.drift.missingConfigured).toEqual([]);
    expect(report.profileSuggestions).toEqual([]);
  });

  it("reports new, missing, and duplicate runtime profiles only when a CLI catalog was read", () => {
    const configured = parseConfig(models, policy).models;
    const duplicate = { ...configured[0]!, id: "codex-luna-copy" };
    const oldOpenCode = { ...configured[0]!, id: "opencode-old", provider: "opencode" as const, model: "opencode/old" };
    const oldAntigravity = { ...configured[0]!, id: "agy-old", provider: "antigravity" as const, model: "agy-old" };
    const runtime = [{ provider: "opencode" as const, model: "opencode/new", source: "runtime" as const, coverage: "unprofiled" as const, profiles: [] }];
    const drift = assessModelDrift([...configured, duplicate, oldOpenCode, oldAntigravity], runtime, [
      { id: "opencode-cli", status: "available", models: 1 },
      { id: "antigravity-cli", status: "unavailable" },
      { id: "models.dev", status: "refreshed" },
    ]);
    expect(drift.newlyAvailable).toEqual(runtime);
    expect(drift.missingConfigured).toEqual([{ provider: "opencode", model: "opencode/old", profiles: ["opencode-old"] }]);
    expect(drift.duplicateProfiles).toEqual([{ provider: "codex", model: "gpt-5.6-luna", profiles: ["codex-luna", "codex-luna-copy"] }]);
  });

  it("suggests disabled, incomplete starters for newly visible account models", async () => {
    const runner: ProcessRunner = { run: async (command) => ({
      stdout: command.args[0] === "models" ? "opencode/new-model\nopencode/other\n" : "opencode 1.0",
      stderr: "", exitCode: 0, timedOut: false,
    }) };
    const config = parseConfig(models, policy);
    const report = await discoverModels(config, { ...providers, opencode: new OpenCodeProvider(runner) }, "/tmp", {
      fetcher: async () => new Response(JSON.stringify({})),
    });
    expect(report.drift.newlyAvailable.map((item) => item.model)).toEqual(["opencode/new-model", "opencode/other"]);
    expect(report.profileSuggestions).toEqual([
      expect.objectContaining({ starter: { id: "opencode-new-model", provider: "opencode", model: "opencode/new-model", enabled: false }, reviewRequired: expect.arrayContaining(["roles", "privacy", "cost"]) }),
      expect.objectContaining({ starter: { id: "opencode-other", provider: "opencode", model: "opencode/other", enabled: false } }),
    ]);
  });
});
