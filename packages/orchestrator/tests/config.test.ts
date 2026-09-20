import { describe, expect, it } from "vitest";
import { mergeUserConfig, parseConfig } from "../src/config.js";

const models = `
version: 1
models:
  - id: codex-test
    provider: codex
    family: openai
    model: test-model
    enabled: true
    local: false
    roles: { architect: 0, implementer: 0, debugger: 0, reviewer: 9, researcher: 0, test: 0, log-analysis: 0 }
    efforts: [medium, high]
    default_effort: high
    capabilities: { tools: true, vision: false, huge_context: false, write_safe: false }
`;
const policy = `
version: 1
phase: 2
defaults: { readOnly: true, timeoutMs: 60000 }
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

describe("configuration", () => {
  it("parses the Phase 2 registry and policy", () => {
    const config = parseConfig(models.replace("write_safe: false", "write_safe: false, worktree_scoped_write: true"), policy);
    expect(config.models[0]?.roles.reviewer).toBe(9);
    expect(config.models[0]?.capabilities.worktreeScopedWrite).toBe(true);
    expect(config.policy.effort.minimumForRisk.high).toBe("high");
  });
  it("rejects a default effort that is not supported", () => {
    expect(() => parseConfig(models.replace("default_effort: high", "default_effort: low"), policy)).toThrow();
  });
  it("applies a strict personal model override without adding credentials", () => {
    const effective = mergeUserConfig(models, `
version: 1
models:
  overrides:
    - id: codex-test
      enabled: false
      tier: fast
      roles: { reviewer: 6 }
`);
    const parsed = parseConfig(effective, policy);
    expect(parsed.models[0]).toMatchObject({ enabled: false, tier: "fast", roles: { reviewer: 6 } });
  });
  it("rejects unknown personal model overrides and credential-shaped fields", () => {
    expect(() => mergeUserConfig(models, "version: 1\nmodels:\n  overrides:\n    - id: absent\n      enabled: false")).toThrow("unknown model");
    expect(() => mergeUserConfig(models, "version: 1\nmodels:\n  token: forbidden")).toThrow();
  });
});
