import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ModelConfig } from "./config.js";
import { AntigravityProvider } from "./providers/antigravity.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenCodeProvider } from "./providers/opencode.js";
import { stateDirectoryFor } from "./state.js";
import type { Provider } from "./types.js";

export const READINESS_CACHE_MS = 120_000;
type ReadinessCache = { version: 1; checks: Record<string, { checkedAt: number }> };
export type ModelPreflight = { ready: boolean; cached: boolean; reason?: string };

/**
 * Checks only the model under consideration. Successful checks are cached in
 * DTR's OS-temporary state directory; failures are deliberately never cached.
 * No command output, auth data, or credentials is persisted.
 */
export async function preflightModel(
  model: ModelConfig,
  providers: Record<string, Provider>,
  cwd: string,
  options: { cacheTtlMs?: number; now?: number } = {},
): Promise<ModelPreflight> {
  const now = options.now ?? Date.now();
  const cacheTtlMs = options.cacheTtlMs ?? READINESS_CACHE_MS;
  const cachePath = resolve(stateDirectoryFor(cwd), "readiness.json");
  const key = `${model.provider}:${model.model}`;
  const cache = await readCache(cachePath);
  const prior = cache.checks[key];
  if (prior && now - prior.checkedAt >= 0 && now - prior.checkedAt < cacheTtlMs) return { ready: true, cached: true };

  const provider = providers[model.provider];
  const ready = provider ? await checkModel(provider, model, cwd) : false;
  if (!ready) return { ready: false, cached: false, reason: "selected provider or model is unavailable" };

  cache.checks[key] = { checkedAt: now };
  await writeCache(cachePath, cache);
  return { ready: true, cached: false };
}

async function checkModel(provider: Provider, model: ModelConfig, cwd: string): Promise<boolean> {
  if (provider instanceof OllamaProvider) return provider.isModelAvailable(model.model);
  if (provider instanceof AntigravityProvider) return Boolean((await provider.availableModels(cwd))?.has(model.model));
  if (provider instanceof OpenCodeProvider) return Boolean((await provider.availableModels(cwd))?.has(model.model));
  return provider.health();
}

async function readCache(path: string): Promise<ReadinessCache> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) return { version: 1, checks: {} };
    const checks = (parsed as { checks?: unknown }).checks;
    if (typeof checks !== "object" || checks === null) return { version: 1, checks: {} };
    const valid = Object.fromEntries(Object.entries(checks).flatMap(([key, value]) => typeof value === "object" && value !== null && typeof (value as { checkedAt?: unknown }).checkedAt === "number" ? [[key, { checkedAt: (value as { checkedAt: number }).checkedAt }]] : []));
    return { version: 1, checks: valid };
  } catch { return { version: 1, checks: {} }; }
}

async function writeCache(path: string, cache: ReadinessCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache), { mode: 0o600 });
}
