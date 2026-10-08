import type { ModelConfig, RouterConfig } from "./config.js";
import { AntigravityProvider } from "./providers/antigravity.js";
import { OpenCodeProvider } from "./providers/opencode.js";
import type { Provider, ProviderId } from "./types.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const catalogProviderMap: Record<string, ProviderId | undefined> = {
  openai: "codex",
  anthropic: "claude",
  openrouter: "openrouter",
  featherless: "featherless",
  opencode: "opencode",
};
const MAX_CATALOG_CANDIDATES = 100;

type UnknownRecord = Record<string, unknown>;

export type DiscoverySource = {
  id: "opencode-cli" | "antigravity-cli" | "models.dev";
  status: "available" | "unavailable" | "refreshed" | "failed";
  models?: number;
  detail?: string;
};

export type DiscoveredModel = {
  provider: ProviderId;
  model: string;
  source: "runtime" | "catalog";
  coverage: "configured" | "covered-by-alias" | "unprofiled";
  profiles: string[];
  metadata?: { name?: string; contextTokens?: number; reasoning?: boolean; tools?: boolean };
};

export type ModelDiscoveryReport = {
  generatedAt: string;
  refreshed: boolean;
  sources: DiscoverySource[];
  runtime: DiscoveredModel[];
  catalog: { candidates: DiscoveredModel[]; omitted: number };
  guidance: string[];
};

export async function discoverModels(
  config: RouterConfig,
  providers: Record<ProviderId, Provider>,
  cwd: string,
  options: { refresh?: boolean; fetcher?: typeof fetch } = {},
): Promise<ModelDiscoveryReport> {
  const refresh = options.refresh ?? false;
  const sources: DiscoverySource[] = [];
  const runtime: DiscoveredModel[] = [];

  const openCode = providers.opencode;
  if (openCode instanceof OpenCodeProvider) {
    try {
      const models = await openCode.availableModels(cwd, refresh);
      if (models) {
        runtime.push(...[...models].sort().map((model) => discovered(config.models, "opencode", model, "runtime")));
        sources.push({ id: "opencode-cli", status: refresh ? "refreshed" : "available", models: models.size });
      } else sources.push({ id: "opencode-cli", status: "unavailable" });
    } catch { sources.push({ id: "opencode-cli", status: "failed", detail: "catalog could not be read" }); }
  }

  const antigravity = providers.antigravity;
  if (antigravity instanceof AntigravityProvider) {
    try {
      const models = await antigravity.availableModels(cwd);
      if (models) {
        runtime.push(...[...models].sort().map((model) => discovered(config.models, "antigravity", model, "runtime")));
        sources.push({ id: "antigravity-cli", status: "available", models: models.size });
      } else sources.push({ id: "antigravity-cli", status: "unavailable" });
    } catch { sources.push({ id: "antigravity-cli", status: "failed", detail: "catalog could not be read" }); }
  }

  const catalog = await discoverCatalog(config.models, options.fetcher ?? fetch);
  sources.push(catalog.source);
  return {
    generatedAt: new Date().toISOString(),
    refreshed: refresh,
    sources,
    runtime: runtime.sort(compareDiscovered),
    catalog: { candidates: catalog.candidates.slice(0, MAX_CATALOG_CANDIDATES), omitted: Math.max(0, catalog.candidates.length - MAX_CATALOG_CANDIDATES) },
    guidance: [
      "Runtime entries are account-aware but are not automatically routing profiles.",
      "Catalog candidates are public metadata only. Review privacy, access, cost, and routing scores before adding one.",
      "Claude aliases such as opus and sonnet are reported as covered-by-alias and do not need a version-specific profile.",
    ],
  };
}

async function discoverCatalog(configured: ModelConfig[], fetcher: typeof fetch): Promise<{ source: DiscoverySource; candidates: DiscoveredModel[] }> {
  try {
    const response = await fetcher(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { source: { id: "models.dev", status: "failed", detail: `catalog returned ${response.status}` }, candidates: [] };
    const payload = await response.json() as unknown;
    const candidates = parseModelsDevCatalog(payload)
      .map((item) => ({ ...discovered(configured, item.provider, item.model, "catalog"), ...(item.metadata ? { metadata: item.metadata } : {}) }))
      .filter((item) => item.coverage === "unprofiled" && isActionableCatalogCandidate(configured, item))
      .sort(compareDiscovered);
    return { source: { id: "models.dev", status: "refreshed", models: candidates.length }, candidates };
  } catch {
    return { source: { id: "models.dev", status: "failed", detail: "catalog could not be refreshed" }, candidates: [] };
  }
}

/** Parse the public models.dev provider map without trusting a particular catalog version. */
export function parseModelsDevCatalog(payload: unknown): Array<{ provider: ProviderId; model: string; metadata?: DiscoveredModel["metadata"] }> {
  const root = record(payload);
  const providers = record(root?.providers) ?? root;
  if (!providers) return [];
  const entries: Array<{ provider: ProviderId; model: string; metadata?: DiscoveredModel["metadata"] }> = [];
  for (const [catalogProvider, value] of Object.entries(providers)) {
    const provider = catalogProviderMap[catalogProvider];
    const models = record(record(value)?.models);
    if (!provider || !models) continue;
    for (const [key, modelValue] of Object.entries(models)) {
      const model = record(modelValue);
      if (model?.status === "deprecated") continue;
      const id = string(model?.id) ?? key;
      const bare = id.startsWith(`${catalogProvider}/`) ? id.slice(catalogProvider.length + 1) : id;
      const normalized = provider === "opencode" && !bare.startsWith("opencode/") ? `opencode/${bare}` : bare;
      if (!normalized) continue;
      const limit = record(model?.limit);
      const name = string(model?.name);
      const contextTokens = number(limit?.context);
      const reasoning = boolean(model?.reasoning);
      const tools = boolean(model?.tool_call);
      entries.push({
        provider,
        model: normalized,
        metadata: compactMetadata({ ...(name !== undefined ? { name } : {}), ...(contextTokens !== undefined ? { contextTokens } : {}), ...(reasoning !== undefined ? { reasoning } : {}), ...(tools !== undefined ? { tools } : {}) }),
      });
    }
  }
  return entries;
}

function discovered(configured: ModelConfig[], provider: ProviderId, model: string, source: DiscoveredModel["source"]): DiscoveredModel {
  const exact = configured.filter((profile) => profile.provider === provider && profile.model === model).map((profile) => profile.id);
  const aliases = exact.length === 0 && provider === "claude"
    ? configured.filter((profile) => profile.provider === "claude" && model.startsWith(`claude-${profile.model}-`)).map((profile) => profile.id)
    : [];
  return { provider, model, source, coverage: exact.length ? "configured" : aliases.length ? "covered-by-alias" : "unprofiled", profiles: exact.length ? exact : aliases };
}

/** Public catalogues are not account-aware. Only surface actionable upgrades here. */
function isActionableCatalogCandidate(configured: ModelConfig[], candidate: DiscoveredModel): boolean {
  if (candidate.provider === "claude") return true;
  if (candidate.provider !== "codex") return false;
  const candidateGeneration = gptGeneration(candidate.model);
  if (candidateGeneration === undefined) return false;
  const configuredGeneration = Math.max(...configured.filter((model) => model.provider === "codex").map((model) => gptGeneration(model.model) ?? 0), 0);
  return candidateGeneration > configuredGeneration;
}

function gptGeneration(model: string): number | undefined {
  const match = model.match(/^gpt-(\d+)/);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function compactMetadata(value: NonNullable<DiscoveredModel["metadata"]>): DiscoveredModel["metadata"] | undefined {
  return Object.keys(value).length ? value : undefined;
}
function compareDiscovered(a: DiscoveredModel, b: DiscoveredModel): number { return `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`); }
function record(value: unknown): UnknownRecord | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function boolean(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
