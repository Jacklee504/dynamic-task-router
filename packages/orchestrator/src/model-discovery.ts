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
  drift: {
    newlyAvailable: DiscoveredModel[];
    missingConfigured: Array<{ provider: ProviderId; model: string; profiles: string[] }>;
    duplicateProfiles: Array<{ provider: ProviderId; model: string; profiles: string[] }>;
  };
  profileSuggestions: Array<{
    starter: { id: string; provider: ProviderId; model: string; enabled: false };
    reviewRequired: string[];
  }>;
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
  const drift = assessModelDrift(config.models, runtime, sources);
  return {
    generatedAt: new Date().toISOString(),
    refreshed: refresh,
    sources,
    runtime: runtime.sort(compareDiscovered),
    catalog: { candidates: catalog.candidates.slice(0, MAX_CATALOG_CANDIDATES), omitted: Math.max(0, catalog.candidates.length - MAX_CATALOG_CANDIDATES) },
    drift,
    profileSuggestions: profileSuggestions(config.models, drift.newlyAvailable),
    guidance: [
      "Runtime entries are account-aware but are not automatically routing profiles.",
      "Missing profiles are compared only against successfully read CLI catalogs; a missing entry may reflect account or catalog changes.",
      "Profile starters are incomplete and disabled. Review all required fields before adding a model to routing.",
      "Catalog candidates are public metadata only. Review privacy, access, cost, and routing scores before adding one.",
      "Claude aliases such as opus and sonnet are reported as covered-by-alias and do not need a version-specific profile.",
    ],
  };
}

export function assessModelDrift(
  configured: ModelConfig[],
  runtime: DiscoveredModel[],
  sources: DiscoverySource[],
): ModelDiscoveryReport["drift"] {
  const available = new Set<ProviderId>();
  for (const source of sources) {
    if (source.status !== "available" && source.status !== "refreshed") continue;
    if (source.id === "opencode-cli") available.add("opencode");
    if (source.id === "antigravity-cli") available.add("antigravity");
  }
  const live = new Set(runtime.map((item) => `${item.provider}\0${item.model}`));
  const groups = new Map<string, ModelConfig[]>();
  for (const profile of configured) {
    const key = `${profile.provider}\0${profile.model}`;
    groups.set(key, [...(groups.get(key) ?? []), profile]);
  }
  const missingConfigured: ModelDiscoveryReport["drift"]["missingConfigured"] = [];
  const duplicateProfiles: ModelDiscoveryReport["drift"]["duplicateProfiles"] = [];
  for (const [key, profiles] of groups) {
    const [provider, model] = key.split("\0") as [ProviderId, string];
    const entry = { provider, model, profiles: profiles.map((profile) => profile.id).sort() };
    if (available.has(provider) && !live.has(key)) missingConfigured.push(entry);
    if (profiles.length > 1) duplicateProfiles.push(entry);
  }
  const compare = (a: { provider: ProviderId; model: string }, b: { provider: ProviderId; model: string }): number =>
    `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`);
  return {
    newlyAvailable: runtime.filter((item) => item.coverage === "unprofiled").sort(compareDiscovered),
    missingConfigured: missingConfigured.sort(compare),
    duplicateProfiles: duplicateProfiles.sort(compare),
  };
}

function profileSuggestions(configured: ModelConfig[], candidates: DiscoveredModel[]): ModelDiscoveryReport["profileSuggestions"] {
  const ids = new Set(configured.map((profile) => profile.id));
  return candidates.map((candidate) => {
    const model = candidate.model.startsWith(`${candidate.provider}/`) ? candidate.model.slice(candidate.provider.length + 1) : candidate.model;
    const base = `${candidate.provider}-${model}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    let id = base;
    for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`;
    ids.add(id);
    return {
      starter: { id, provider: candidate.provider, model: candidate.model, enabled: false as const },
      reviewRequired: ["family", "tier", "roles", "efforts", "default_effort", "capabilities", "limits", "cost", "privacy"],
    };
  });
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
