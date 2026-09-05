import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CIRCUIT_COOLDOWN_MS, recordProviderFailure, recordProviderSuccess, openCircuitProviders } from "../src/circuit-breaker.js";
import { stateDirectoryFor } from "../src/state.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("provider circuit breaker", () => {
  it("opens after two failures, expires, and clears on success", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dtr-circuit-target-")); directories.push(cwd, stateDirectoryFor(cwd));
    await recordProviderFailure("opencode", cwd, 1_000);
    expect(await openCircuitProviders(cwd, 1_001)).toEqual(new Set());
    expect(await recordProviderFailure("opencode", cwd, 2_000)).toEqual({ opened: true });
    expect(await openCircuitProviders(cwd, 2_001)).toEqual(new Set(["opencode"]));
    expect(await openCircuitProviders(cwd, 2_000 + CIRCUIT_COOLDOWN_MS + 1)).toEqual(new Set());
    await recordProviderSuccess("opencode", cwd);
    expect(await openCircuitProviders(cwd, 2_001)).toEqual(new Set());
  });
});
