import type { ModelConfig, RouterConfig } from "../config.js";
import { selectEffort } from "./effort.js";
import type { ModelSelection, SelectionExplanation, TaskProfile } from "../types.js";

export type Availability = Record<string, boolean | undefined>;
export type SelectionOptions = { requireWrite?: boolean; allowWorktreeScopedWrite?: boolean; modelId?: string; excludedModels?: Set<string>; circuitOpenProviders?: Set<string> };
const tiers = ["fast", "standard", "deep", "critical"] as const;
type ModelTier = typeof tiers[number];

export function selectModel(
  config: RouterConfig,
  task: TaskProfile,
  availability: Availability = {},
  excludedFamilies = new Set<string>(),
  options: SelectionOptions = {},
): ModelSelection | undefined {
  const rejected: Record<string, string[]> = {};
  const eligible: Array<{ model: ModelConfig; score: number; tierDistance: number; reasons: string[] }> = [];
  const requiredTier = minimumTier(task);
  for (const model of config.models) {
    const reasons = gateReasons(model, config, task, availability, excludedFamilies, options);
    if (reasons.length > 0) {
      rejected[model.id] = reasons;
      continue;
    }
    const roleScore = model.roles[task.role]!;
    let score = roleScore;
    const tierDistance = tierIndex(model.tier) - tierIndex(requiredTier);
    const scoreReasons = [`${task.role} role score=${roleScore}`, `tier=${model.tier}; required tier=${requiredTier}`];
    if (task.preferLocal && model.local) { score += 2; scoreReasons.push("local preference bonus=2"); }
    if (task.risk === "high") { score += 2; scoreReasons.push("high-risk suitability bonus=2"); }
    if (task.complexity === "extreme") { score += 1; scoreReasons.push("extreme-complexity suitability bonus=1"); }
    if (config.policy.budget.mode === "prefer_free" && estimateCost(model) === 0) { score += 1; scoreReasons.push("free-model preference bonus=1"); }
    for (const preference of config.policy.preferences) {
      if (Date.parse(preference.until) <= Date.now() || (preference.provider && preference.provider !== model.provider) || (preference.model && preference.model !== model.id)) continue;
      score += preference.bonus; scoreReasons.push(`active preference bonus=${preference.bonus} until=${preference.until}`);
    }
    if (tierDistance < 0) scoreReasons.push(`tier fallback: ${model.tier} is below required ${requiredTier}`);
    else if (tierDistance > 0) scoreReasons.push(`stronger-than-required tier: ${model.tier}`);
    eligible.push({ model, score, tierDistance, reasons: scoreReasons });
  }
  eligible.sort((left, right) => compareTierDistance(left.tierDistance, right.tierDistance) || right.score - left.score || left.model.id.localeCompare(right.model.id));
  const winner = eligible[0];
  if (!winner) return undefined;
  const explanation: SelectionExplanation = {
    selected: winner.model.id,
    score: winner.score,
    reasons: winner.reasons,
    rejected,
  };
  return { model: winner.model.id, score: winner.score, explanation };
}

/** The per-model rejection map for a profile, even when no model is eligible. */
export function selectionRejections(config: RouterConfig, task: TaskProfile, availability: Availability = {}, options: SelectionOptions = {}, excludedFamilies = new Set<string>()): Record<string, string[]> {
  const rejected: Record<string, string[]> = {};
  for (const model of config.models) {
    const reasons = gateReasons(model, config, task, availability, excludedFamilies, options);
    if (reasons.length > 0) rejected[model.id] = reasons;
  }
  return rejected;
}

/** Compact one-line summary of rejection reasons for error messages. */
export function summarizeRejections(rejected: Record<string, string[]>, task?: Pick<TaskProfile, "allowedProviders" | "allowedFamilies">): string {
  const entries = Object.entries(rejected);
  const matching = task && (task.allowedProviders?.length || task.allowedFamilies?.length)
    ? entries.filter(([, reasons]) => !reasons.includes("provider is not allowed") && !reasons.includes("model family is not allowed"))
    : [];
  const ordered = matching.length ? [...matching, ...entries.filter((entry) => !matching.includes(entry))] : entries;
  const lines = ordered.map(([id, reasons]) => `${id} (${reasons.join("; ")})`);
  if (!lines.length) return "constraints cannot be safely satisfied";
  return lines.length > 5 ? `${lines.slice(0, 5).join(", ")}, (+${lines.length - 5} more)` : lines.join(", ");
}

function gateReasons(
  model: ModelConfig,
  config: RouterConfig,
  task: TaskProfile,
  availability: Availability,
  excludedFamilies: Set<string>,
  options: SelectionOptions,
): string[] {
  const reasons: string[] = [];
  const declaredRoleScore = model.roles[task.role];
  const roleScore = declaredRoleScore ?? 0;
  const minimumRole = task.risk === "high" || task.complexity === "extreme" ? 8 : task.complexity === "difficult" ? 6 : 1;
  if (!model.enabled) reasons.push("disabled");
  if (options.modelId && model.id !== options.modelId) reasons.push("not selected by the explicit model override");
  if (options.excludedModels?.has(model.id)) reasons.push("failed selected-model preflight");
  if (options.circuitOpenProviders?.has(model.provider)) reasons.push("provider circuit breaker is temporarily open");
  if (availability[model.id] === false) reasons.push("provider unavailable");
  if (excludedFamilies.has(model.family)) reasons.push(`family '${model.family}' already selected`);
  if (task.requireLocal && !model.local) reasons.push("local-only task");
  if (task.privacySensitive && !model.local) reasons.push("privacy-sensitive task requires local model");
  if (task.allowRemote === false && !model.local) reasons.push("remote models are disallowed");
  if (task.privateCode && !model.privacy.privateCodeAllowed) reasons.push("private code is not approved for this model");
  if (task.allowedFamilies && !task.allowedFamilies.includes(model.family)) reasons.push("model family is not allowed");
  if (task.allowedProviders && !task.allowedProviders.includes(model.provider)) reasons.push("provider is not allowed");
  if (task.requiresTools && !model.capabilities.tools) reasons.push("required tools unavailable");
  if (options.requireWrite && !model.capabilities.writeSafe) {
    if (!model.capabilities.worktreeScopedWrite) reasons.push("isolated write capability unavailable");
    else if (!options.allowWorktreeScopedWrite) reasons.push("worktree-scoped write requires an explicit non-root scope");
  }
  if (task.contextRequirement === "huge" && !model.capabilities.hugeContext) reasons.push("huge context unavailable");
  if (declaredRoleScore === undefined) reasons.push(`no declared score for role '${task.role}'`);
  else if (roleScore < minimumRole) reasons.push(`role score ${roleScore} below minimum ${minimumRole}`);
  try { selectEffort(config, model, task); } catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
  const estimatedCost = estimateCost(model);
  if (config.policy.budget.mode === "capped" && estimatedCost > config.policy.budget.max_estimated_cost_usd) reasons.push(`estimated cost $${estimatedCost.toFixed(4)} exceeds cap`);
  return reasons;
}

/** Select the smallest suitable quality tier before comparing role priors. */
function minimumTier(task: TaskProfile): ModelTier {
  const complexity: Record<TaskProfile["complexity"], ModelTier> = { trivial: "fast", normal: "standard", difficult: "deep", extreme: "critical" };
  const risk: Record<TaskProfile["risk"], ModelTier> = { low: "fast", medium: "standard", high: "deep" };
  return tiers[Math.max(tierIndex(complexity[task.complexity]), tierIndex(risk[task.risk]))]!;
}

function tierIndex(tier: ModelTier): number { return tiers.indexOf(tier); }

function compareTierDistance(left: number, right: number): number {
  // Any tier meeting the requirement beats a downgrade. Among suitable tiers,
  // prefer the smallest escalation; only then use the model's role score.
  const leftSuitable = left >= 0; const rightSuitable = right >= 0;
  if (leftSuitable !== rightSuitable) return leftSuitable ? -1 : 1;
  if (leftSuitable) return left - right;
  return right - left;
}

export function estimateCost(model: ModelConfig, inputTokens = 1_000, outputTokens = 500): number {
  return ((inputTokens * model.cost.inputPerMillion) + (outputTokens * model.cost.outputPerMillion)) / 1_000_000;
}

export function eligibleSelections(config: RouterConfig, task: TaskProfile, availability: Availability = {}, options: SelectionOptions = {}): ModelSelection[] {
  const selected: ModelSelection[] = [];
  const excluded = new Set<string>();
  while (true) {
    const selection = selectModel(config, task, availability, excluded, options);
    if (!selection) return selected;
    selected.push(selection);
    const model = config.models.find((item) => item.id === selection.model)!;
    excluded.add(model.family);
  }
}
