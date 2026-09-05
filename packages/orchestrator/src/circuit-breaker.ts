import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ProviderId } from "./types.js";
import { stateDirectoryFor } from "./state.js";

export const CIRCUIT_FAILURE_THRESHOLD = 2;
export const CIRCUIT_WINDOW_MS = 300_000;
export const CIRCUIT_COOLDOWN_MS = 120_000;

type CircuitState = { version: 1; providers: Partial<Record<ProviderId, { failures: number; firstFailureAt: number; openUntil?: number }>> };

/** Provider-only reliability state. It intentionally stores no task, output, or error text. */
export async function openCircuitProviders(cwd: string, now = Date.now()): Promise<Set<ProviderId>> {
  const state = await readState(cwd);
  return new Set(Object.entries(state.providers).flatMap(([provider, value]) => value?.openUntil && value.openUntil > now ? [provider as ProviderId] : []));
}

export async function recordProviderFailure(provider: ProviderId, cwd: string, now = Date.now()): Promise<{ opened: boolean }> {
  const state = await readState(cwd); const prior = state.providers[provider];
  const failures = prior && now - prior.firstFailureAt <= CIRCUIT_WINDOW_MS ? prior.failures + 1 : 1;
  const firstFailureAt = prior && now - prior.firstFailureAt <= CIRCUIT_WINDOW_MS ? prior.firstFailureAt : now;
  const opened = failures >= CIRCUIT_FAILURE_THRESHOLD;
  state.providers[provider] = { failures, firstFailureAt, ...(opened ? { openUntil: now + CIRCUIT_COOLDOWN_MS } : {}) };
  await writeState(cwd, state); return { opened };
}

export async function recordProviderSuccess(provider: ProviderId, cwd: string): Promise<void> {
  const state = await readState(cwd); if (!(provider in state.providers)) return;
  delete state.providers[provider]; await writeState(cwd, state);
}

async function readState(cwd: string): Promise<CircuitState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resolve(stateDirectoryFor(cwd), "circuits.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1 || typeof (parsed as { providers?: unknown }).providers !== "object") return { version: 1, providers: {} };
    return parsed as CircuitState;
  } catch { return { version: 1, providers: {} }; }
}
async function writeState(cwd: string, state: CircuitState): Promise<void> {
  const path = resolve(stateDirectoryFor(cwd), "circuits.json"); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}
