import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";
import { preflightModel } from "../src/readiness.js";
import { stateDirectoryFor } from "../src/state.js";
import type { Provider } from "../src/types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const config = parseConfig(`
version: 1
models:
  - id: claude-test
    provider: claude
    family: anthropic
    model: test
    enabled: true
    local: false
    roles: { architect: 0, implementer: 0, debugger: 0, reviewer: 8, researcher: 0, test: 0, log-analysis: 0 }
    efforts: [medium]
    default_effort: medium
    capabilities: { tools: true, vision: false, huge_context: false, write_safe: false }
`, `
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
`);

describe("selected-model readiness", () => {
  it("caches successful selected-provider checks outside the target repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dtr-readiness-target-"));
    directories.push(cwd, stateDirectoryFor(cwd));
    let checks = 0;
    const provider: Provider = { id: "claude", health: async () => { checks += 1; return true; }, run: async () => { throw new Error("not used"); } };
    const first = await preflightModel(config.models[0]!, { claude: provider }, cwd, { now: 100 });
    const second = await preflightModel(config.models[0]!, { claude: provider }, cwd, { now: 200 });
    expect(first).toMatchObject({ ready: true, cached: false });
    expect(second).toMatchObject({ ready: true, cached: true });
    expect(checks).toBe(1);
  });
  it("does not cache failures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dtr-readiness-target-"));
    directories.push(cwd, stateDirectoryFor(cwd));
    let checks = 0;
    const provider: Provider = { id: "claude", health: async () => { checks += 1; return false; }, run: async () => { throw new Error("not used"); } };
    await preflightModel(config.models[0]!, { claude: provider }, cwd);
    await preflightModel(config.models[0]!, { claude: provider }, cwd);
    expect(checks).toBe(2);
  });
});
