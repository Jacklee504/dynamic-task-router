import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ModelConfig, RouterConfig } from "./config.js";
import { compareVersions, deriveLineage, emptyGeneratedLayer, lineageVersion, type GeneratedAddition, type GeneratedLayer } from "./generated-config.js";
import { actionableCatalogCandidates, fetchModelsDevCatalog, type CatalogEntry, type DiscoverySource } from "./model-discovery.js";
import { AntigravityProvider } from "./providers/antigravity.js";
import { OpenCodeProvider } from "./providers/opencode.js";
import type { Effort, Provider, ProviderId, WorkerRole } from "./types.js";

/** Providers whose public catalogue is confirmed per account with a tiny read-only probe. */
const PROBED_PROVIDERS: ProviderId[] = ["codex", "claude"];
/** Providers whose CLI lists the models this account can use, so no probe is needed. */
const LISTED_PROVIDERS: ProviderId[] = ["antigravity", "opencode"];
/** Listed providers whose new models are added automatically (OpenCode exposes hundreds of models, so it only upgrades). */
const ADDING_LISTED_PROVIDERS: ProviderId[] = ["antigravity"];
const ROLES: WorkerRole[] = ["architect", "implementer", "debugger", "reviewer", "researcher", "test", "log-analysis"];
const PROBE_PROMPT = "Reply with the single word OK.";
const PROBE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 180_000;
const DEFAULT_PROBE_LIMIT = 4;
const MIN_ROLE_SAMPLES = 3;
const PRIOR_WEIGHT = 5;
const ROLLBACK_FAILURES = 3;
const NEUTRAL_ROLE_SCORE = 5;

export type ModelRefreshReport = {
  refreshedAt: string;
  sources: DiscoverySource[];
  changes: string[];
  pending: string[];
  layer: GeneratedLayer;
};

export type ModelRefreshOptions = {
  /** Registry plus personal settings, without the generated layer. */
  config: RouterConfig;
  providers: Record<ProviderId, Provider>;
  previous?: GeneratedLayer | undefined;
  /** Root holding every repository's DTR state directory. */
  stateBase?: string;
  fetcher?: typeof fetch;
  now?: Date;
  probeLimit?: number;
};

type Offer = { model: string; contextTokens?: number | undefined; inputPerMillion?: number | undefined; outputPerMillion?: number | undefined; tools?: boolean | undefined };
type Evidence = { outcomes: Array<{ id: string; model: string; role: WorkerRole; score: number }>; logs: Array<{ provider: ProviderId; model: string; success: boolean; at: number }> };

/** Rebuild the generated model layer from live catalogues, account probes, and reviewed outcomes. */
export async function refreshModels(options: ModelRefreshOptions): Promise<ModelRefreshReport> {
  const now = options.now ?? new Date(); const at = now.toISOString();
  const previous = options.previous ?? emptyGeneratedLayer();
  const base = options.config.models;
  const sources: DiscoverySource[] = []; const changes: string[] = []; const pending: string[] = [];

  const catalog = await fetchModelsDevCatalog(options.fetcher ?? fetch);
  sources.push(catalog.source);
  const listed = new Map<ProviderId, Set<string>>();
  for (const provider of LISTED_PROVIDERS) {
    const instance = options.providers[provider];
    try {
      const models = instance instanceof OpenCodeProvider ? await instance.availableModels(process.cwd(), true) : instance instanceof AntigravityProvider ? await instance.availableModels(process.cwd()) : undefined;
      if (models) { listed.set(provider, models); sources.push({ id: provider === "opencode" ? "opencode-cli" : "antigravity-cli", status: "available", models: models.size }); }
      else sources.push({ id: provider === "opencode" ? "opencode-cli" : "antigravity-cli", status: "unavailable" });
    } catch { sources.push({ id: provider === "opencode" ? "opencode-cli" : "antigravity-cli", status: "failed", detail: "catalog could not be read" }); }
  }
  const offers = (provider: ProviderId): Offer[] | undefined => {
    if (LISTED_PROVIDERS.includes(provider)) { const models = listed.get(provider); return models ? [...models].map((model) => ({ model })) : undefined; }
    if (!PROBED_PROVIDERS.includes(provider) || !catalog.entries) return undefined;
    return catalog.entries.filter((entry) => entry.provider === provider).map((entry) => offerFrom(entry));
  };

  const evidence = await readEvidence(options.stateBase ?? resolve(tmpdir(), "dynamic-task-router"));
  const layer: GeneratedLayer = { ...emptyGeneratedLayer(), refreshedAt: at, blocked: [...previous.blocked], probes: [...previous.probes] };
  const isBlocked = (provider: ProviderId, model: string): boolean => layer.blocked.some((entry) => entry.provider === provider && entry.model === model);

  // Roll back an earlier upgrade that has only failed since it was applied.
  for (const upgrade of previous.upgrades) {
    const profile = base.find((model) => model.id === upgrade.id);
    if (!profile || isBlocked(profile.provider, upgrade.model)) continue;
    const runs = evidence.logs.filter((log) => log.provider === profile.provider && log.model === upgrade.model && log.at >= Date.parse(upgrade.upgradedAt));
    if (runs.length >= ROLLBACK_FAILURES && runs.every((log) => !log.success)) {
      layer.blocked.push({ provider: profile.provider, model: upgrade.model, reason: `${runs.length} consecutive failed runs after upgrade`, at });
      changes.push(`rolled back ${upgrade.id}: ${upgrade.model} -> ${upgrade.previous} (${runs.length} failed runs)`);
    }
  }

  let probesLeft = options.probeLimit ?? DEFAULT_PROBE_LIMIT;
  const confirm = async (provider: ProviderId, model: string): Promise<boolean | undefined> => {
    if (LISTED_PROVIDERS.includes(provider)) return listed.get(provider)?.has(model) ?? false;
    const cached = layer.probes.find((probe) => probe.provider === provider && probe.model === model);
    if (cached?.ok) return true;
    if (cached && now.getTime() - Date.parse(cached.at) < PROBE_RETRY_MS) return false;
    if (probesLeft <= 0) return undefined;
    probesLeft--;
    const ok = await probe(options.providers[provider], model);
    layer.probes = [...layer.probes.filter((entry) => entry !== cached), { provider, model, ok, at }].slice(-200);
    return ok;
  };

  // Lineage upgrades: move each profile to the newest confirmed version of its own line.
  const effectiveModel = new Map(base.map((model) => [model.id, model.model]));
  for (const profile of base) {
    if (!profile.lineage || !profile.enabled) continue;
    const current = lineageVersion(profile.lineage, profile.model);
    const prior = previous.upgrades.find((upgrade) => upgrade.id === profile.id && !isBlocked(profile.provider, upgrade.model));
    const available = offers(profile.provider);
    if (!current || !available) { if (prior) keepUpgrade(layer, prior, effectiveModel); continue; }
    const candidates = available
      .flatMap((offer) => { const version = lineageVersion(profile.lineage!, offer.model); return version && compareVersions(version, current) > 0 ? [{ offer, version }] : []; })
      .filter(({ offer }) => !isBlocked(profile.provider, offer.model) && !base.some((other) => other.id !== profile.id && other.provider === profile.provider && other.model === offer.model))
      .sort((left, right) => compareVersions(right.version, left.version));
    for (const { offer } of candidates) {
      const confirmed = await confirm(profile.provider, offer.model);
      if (confirmed === false) continue;
      if (confirmed === undefined) { pending.push(`${profile.id}: ${offer.model} awaits an account probe`); if (prior) keepUpgrade(layer, prior, effectiveModel); break; }
      layer.upgrades.push({
        id: profile.id, model: offer.model, previous: profile.model,
        upgradedAt: prior?.model === offer.model ? prior.upgradedAt : at,
        ...(offer.contextTokens ? { context_tokens: offer.contextTokens } : {}),
        ...(offer.inputPerMillion !== undefined && offer.outputPerMillion !== undefined ? { cost: { input_per_million: offer.inputPerMillion, output_per_million: offer.outputPerMillion } } : {}),
      });
      effectiveModel.set(profile.id, offer.model);
      if (prior?.model !== offer.model) changes.push(`upgraded ${profile.id}: ${profile.model} -> ${offer.model}`);
      break;
    }
  }

  // New model lines nobody has profiled yet: add the newest confirmed version as a provisional profile.
  const covered = (provider: ProviderId, model: string): boolean => {
    const lineage = deriveLineage(model);
    return base.some((profile) => profile.provider === provider && (profile.model === model || (profile.lineage !== undefined && lineageVersion(profile.lineage, model) !== undefined) || (lineage !== undefined && deriveLineage(profile.model) === lineage)));
  };
  const additionSources: Array<{ provider: ProviderId; offers: Offer[] | undefined }> = [
    ...PROBED_PROVIDERS.map((provider) => ({ provider, offers: catalog.entries ? actionableCatalogCandidates(base, catalog.entries).filter((item) => item.provider === provider && item.metadata?.tools !== false).map((item) => offerFrom({ provider, model: item.model, ...(item.metadata ? { metadata: item.metadata } : {}) })) : undefined })),
    ...ADDING_LISTED_PROVIDERS.map((provider) => ({ provider, offers: offers(provider) })),
  ];
  for (const { provider, offers: available } of additionSources) {
    if (!available) { for (const prior of previous.additions.filter((addition) => addition.provider === provider)) keepAddition(layer, prior, base); continue; }
    const lines = new Map<string, Offer[]>();
    for (const offer of available) {
      if (covered(provider, offer.model) || isBlocked(provider, offer.model)) continue;
      const lineage = deriveLineage(offer.model) ?? offer.model;
      lines.set(lineage, [...(lines.get(lineage) ?? []), offer]);
    }
    for (const [lineage, members] of lines) {
      const sorted = lineage.includes("{version}") ? [...members].sort((left, right) => compareVersions(lineageVersion(lineage, right.model) ?? [0], lineageVersion(lineage, left.model) ?? [0])) : members;
      const id = additionId(provider, lineage);
      const prior = previous.additions.find((addition) => addition.id === id);
      let added = false;
      for (const offer of sorted) {
        const confirmed = await confirm(provider, offer.model);
        if (confirmed === false) continue;
        if (confirmed === undefined) { pending.push(`${id}: ${offer.model} awaits an account probe`); break; }
        const addition = makeAddition(id, provider, lineage, offer, base, prior?.model === offer.model ? prior.addedAt : at);
        if (base.some((profile) => profile.id === id)) break;
        layer.additions.push(addition); added = true;
        if (prior?.model !== offer.model) changes.push(prior ? `upgraded provisional ${id}: ${prior.model} -> ${offer.model}` : `added provisional ${id} (${offer.model})`);
        break;
      }
      if (!added && prior) keepAddition(layer, prior, base);
    }
  }

  // Configured models that an account-aware CLI no longer offers are disabled until they reappear.
  for (const profile of base) {
    if (!profile.enabled || !LISTED_PROVIDERS.includes(profile.provider)) continue;
    const models = listed.get(profile.provider); const model = effectiveModel.get(profile.id)!;
    if (!models) { const prior = previous.disabled.find((entry) => entry.id === profile.id && entry.model === model); if (prior) layer.disabled.push(prior); continue; }
    if (models.has(model)) continue;
    const prior = previous.disabled.find((entry) => entry.id === profile.id && entry.model === model);
    layer.disabled.push(prior ?? { id: profile.id, model, reason: `not offered by the ${profile.provider} CLI`, at });
    if (!prior) changes.push(`disabled ${profile.id}: ${model} is no longer offered`);
  }

  // Grades: blend each profile's prior role scores with reviewed outcomes for the exact model that ran.
  const graded: Array<{ id: string; model: string; roles: Record<WorkerRole, number> }> = [
    ...base.map((profile) => ({ id: profile.id, model: effectiveModel.get(profile.id)!, roles: profile.roles })),
    ...layer.additions.map((addition) => ({ id: addition.id, model: addition.model, roles: addition.roles as Record<WorkerRole, number> })),
  ];
  for (const profile of graded) {
    const roles: Partial<Record<WorkerRole, number>> = {}; const samples: Partial<Record<WorkerRole, number>> = {};
    for (const role of ROLES) {
      const scores = evidence.outcomes.filter((outcome) => outcome.id === profile.id && outcome.model === profile.model && outcome.role === role).map((outcome) => outcome.score);
      if (scores.length < MIN_ROLE_SAMPLES) continue;
      roles[role] = gradeRole(profile.roles[role] ?? 0, scores); samples[role] = scores.length;
    }
    if (!Object.keys(roles).length) continue;
    layer.grades.push({ id: profile.id, model: profile.model, roles, samples, gradedAt: at });
    const prior = previous.grades.find((grade) => grade.id === profile.id && grade.model === profile.model);
    const moved = ROLES.filter((role) => roles[role] !== undefined && roles[role] !== (prior?.roles[role] ?? profile.roles[role]));
    if (moved.length) changes.push(`graded ${profile.id} (${profile.model}): ${moved.map((role) => `${role}=${roles[role]}`).join(", ")}`);
  }

  return { refreshedAt: at, sources, changes, pending, layer };
}

/** Bayesian blend of a 0-10 prior with outcome scores in [0, 1]; never below 1 so a graded role stays declarable. */
export function gradeRole(prior: number, scores: number[]): number {
  const observed = scores.reduce((sum, score) => sum + score, 0) * 10;
  return Math.min(10, Math.max(1, Math.round((prior * PRIOR_WEIGHT + observed) / (PRIOR_WEIGHT + scores.length))));
}

const OUTCOME_SCORES = { accepted: 1, partial: 0.5, escalated: 0, rejected: 0 } as const;

/** Read reviewed single-route outcomes and run logs across every repository's DTR state. Never reads prompts or output. */
export async function readEvidence(stateBase: string): Promise<Evidence> {
  const evidence: Evidence = { outcomes: [], logs: [] };
  let roots: string[] = [];
  try { roots = (await readdir(stateBase, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(stateBase, entry.name, "runs")); } catch { return evidence; }
  for (const root of roots) {
    let names: string[] = [];
    try { names = await readdir(root); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(await readFile(join(root, name), "utf8")) as Record<string, unknown>; } catch { continue; }
      if (name.endsWith(".status.json")) {
        const stage = Array.isArray(parsed.stages) ? parsed.stages[0] as Record<string, unknown> | undefined : undefined;
        const outcome = parsed.outcome as { status?: keyof typeof OUTCOME_SCORES; manualScore?: number } | undefined;
        if (parsed.strategy !== "single" || !stage || !outcome?.status || !(outcome.status in OUTCOME_SCORES)) continue;
        if (typeof stage.model !== "string" || typeof stage.providerModel !== "string" || !ROLES.includes(stage.role as WorkerRole)) continue;
        const score = typeof outcome.manualScore === "number" && outcome.manualScore >= 0 && outcome.manualScore <= 1 ? outcome.manualScore : OUTCOME_SCORES[outcome.status];
        evidence.outcomes.push({ id: stage.model, model: stage.providerModel, role: stage.role as WorkerRole, score });
      } else if (typeof parsed.provider === "string" && typeof parsed.model === "string" && typeof parsed.success === "boolean" && typeof parsed.timestamp === "string") {
        evidence.logs.push({ provider: parsed.provider as ProviderId, model: parsed.model, success: parsed.success, at: Date.parse(parsed.timestamp) });
      }
    }
  }
  return evidence;
}

/** Confirm the account can use a model with a tiny read-only request through the provider's own safety checks. */
async function probe(provider: Provider | undefined, model: string): Promise<boolean> {
  if (!provider) return false;
  const directory = await mkdtemp(join(tmpdir(), "dtr-probe-"));
  try {
    const result = await provider.run({ prompt: PROBE_PROMPT, cwd: directory, role: "test", model, effort: "low", readOnly: true, timeoutMs: PROBE_TIMEOUT_MS });
    return result.success && result.output.trim().length > 0;
  } catch { return false; }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function offerFrom(entry: CatalogEntry): Offer {
  return { model: entry.model, contextTokens: entry.metadata?.contextTokens, inputPerMillion: entry.metadata?.inputPerMillion, outputPerMillion: entry.metadata?.outputPerMillion, tools: entry.metadata?.tools };
}

function keepUpgrade(layer: GeneratedLayer, upgrade: GeneratedLayer["upgrades"][number], effective: Map<string, string>): void {
  layer.upgrades.push(upgrade); effective.set(upgrade.id, upgrade.model);
}

function keepAddition(layer: GeneratedLayer, addition: GeneratedAddition, base: ModelConfig[]): void {
  if (layer.blocked.some((entry) => entry.provider === addition.provider && entry.model === addition.model)) return;
  if (base.some((profile) => profile.id === addition.id || (profile.provider === addition.provider && profile.model === addition.model))) return;
  layer.additions.push(addition);
}

function additionId(provider: ProviderId, lineage: string): string {
  const slug = lineage.replace("{version}", "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.startsWith(`${provider}-`) ? slug : `${provider}-${slug}`;
}

function makeAddition(id: string, provider: ProviderId, lineage: string, offer: Offer, base: ModelConfig[], addedAt: string): GeneratedAddition {
  const siblings = base.filter((profile) => profile.provider === provider && profile.enabled);
  const sibling = siblings[0];
  const efforts: Effort[] = sibling ? [...sibling.efforts] : ["low", "medium", "high"];
  const defaultEffort: Effort = sibling && efforts.includes(sibling.defaultEffort) ? sibling.defaultEffort : efforts.includes("medium") ? "medium" : efforts[0]!;
  const contextTokens = offer.contextTokens ?? sibling?.limits.contextTokens ?? 32_768;
  const privateCode = siblings.length > 0 && siblings.every((profile) => profile.privacy.privateCodeAllowed);
  const cost = offer.inputPerMillion !== undefined && offer.outputPerMillion !== undefined
    ? { input_per_million: offer.inputPerMillion, output_per_million: offer.outputPerMillion }
    : { input_per_million: Math.max(0, ...siblings.map((profile) => profile.cost.inputPerMillion)), output_per_million: Math.max(0, ...siblings.map((profile) => profile.cost.outputPerMillion)) };
  return {
    id, provider, family: familyFor(offer.model, sibling?.family ?? provider), model: offer.model,
    ...(lineage.includes("{version}") ? { lineage } : {}),
    tier: /(?:mini|nano|flash|lite|haiku|luna|small)/i.test(offer.model) ? "fast" : "standard",
    enabled: true, local: false, provisional: true,
    roles: Object.fromEntries(ROLES.map((role) => [role, NEUTRAL_ROLE_SCORE])) as Record<WorkerRole, number>,
    efforts, default_effort: defaultEffort,
    capabilities: { tools: offer.tools ?? sibling?.capabilities.tools ?? false, vision: false, huge_context: contextTokens >= 400_000, write_safe: false },
    limits: { context_tokens: contextTokens },
    cost,
    privacy: privateCode ? { private_code_allowed: true, training_opt_out_required: false } : { private_code_allowed: false, training_opt_out_required: true },
    addedAt,
  };
}

function familyFor(model: string, fallback: string): string {
  if (/^(?:gpt|o\d)/i.test(model)) return "openai";
  if (/^claude/i.test(model)) return "anthropic";
  if (/^gemini/i.test(model)) return "google";
  return fallback;
}
