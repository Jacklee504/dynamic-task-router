import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type { ProviderId, WorkerRole } from "./types.js";

/**
 * The machine-maintained model layer. `dtr update-models` writes it next to the
 * personal configuration; the checked-in registry is never rewritten. It is
 * applied after the repository registry and before personal overrides, so a
 * person's own settings always win.
 */
const providerSchema = z.enum(["claude", "codex", "ollama", "openrouter", "featherless", "antigravity", "opencode"]);
const roleSchema = z.enum(["architect", "implementer", "debugger", "reviewer", "researcher", "test", "log-analysis"]);
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const costSchema = z.object({ input_per_million: z.number().nonnegative(), output_per_million: z.number().nonnegative() }).strict();
const roleScores = z.record(roleSchema, z.number().int().min(0).max(10));

export const generatedAdditionSchema = z.object({
  id: z.string().min(1),
  provider: providerSchema,
  family: z.string().min(1),
  model: z.string().min(1),
  lineage: z.string().min(1).optional(),
  tier: z.enum(["fast", "standard", "deep", "critical"]),
  enabled: z.literal(true),
  local: z.literal(false),
  provisional: z.literal(true),
  roles: roleScores,
  efforts: z.array(effortSchema).min(1),
  default_effort: effortSchema,
  capabilities: z.object({ tools: z.boolean(), vision: z.boolean(), huge_context: z.boolean(), write_safe: z.literal(false) }).strict(),
  limits: z.object({ context_tokens: z.number().int().positive() }).strict(),
  cost: costSchema,
  privacy: z.object({ private_code_allowed: z.boolean(), training_opt_out_required: z.boolean() }).strict(),
  addedAt: z.string().datetime(),
}).strict();

export const generatedLayerSchema = z.object({
  version: z.literal(1),
  refreshedAt: z.string().datetime().optional(),
  upgrades: z.array(z.object({
    id: z.string().min(1), model: z.string().min(1), previous: z.string().min(1), upgradedAt: z.string().datetime(),
    context_tokens: z.number().int().positive().optional(), cost: costSchema.optional(),
  }).strict()).default([]),
  additions: z.array(generatedAdditionSchema).default([]),
  disabled: z.array(z.object({ id: z.string().min(1), model: z.string().min(1), reason: z.string().min(1).max(200), at: z.string().datetime() }).strict()).default([]),
  grades: z.array(z.object({
    id: z.string().min(1), model: z.string().min(1), roles: z.partialRecord(roleSchema, z.number().int().min(0).max(10)), samples: z.partialRecord(roleSchema, z.number().int().nonnegative()), gradedAt: z.string().datetime(),
  }).strict()).default([]),
  probes: z.array(z.object({ provider: providerSchema, model: z.string().min(1), ok: z.boolean(), at: z.string().datetime() }).strict()).default([]),
  blocked: z.array(z.object({ provider: providerSchema, model: z.string().min(1), reason: z.string().min(1).max(200), at: z.string().datetime() }).strict()).default([]),
}).strict();

export type GeneratedLayer = z.infer<typeof generatedLayerSchema>;
export type GeneratedAddition = z.infer<typeof generatedAdditionSchema>;

/** Grades replace provisional status once a model has this many reviewed outcomes. */
export const GRADED_SAMPLE_THRESHOLD = 10;

export function emptyGeneratedLayer(): GeneratedLayer {
  return { version: 1, upgrades: [], additions: [], disabled: [], grades: [], probes: [], blocked: [] };
}

export function generatedConfigPath(personalConfig: string): string {
  const configured = process.env.DTR_GENERATED_CONFIG?.trim();
  return configured ? resolve(configured) : resolve(dirname(personalConfig), "models.generated.json");
}

export async function readGeneratedLayer(path: string): Promise<GeneratedLayer | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read generated DTR model layer at '${path}'`);
  }
  try { return generatedLayerSchema.parse(JSON.parse(text)); } catch { throw new Error(`Generated DTR model layer at '${path}' is invalid; delete it and run 'dtr update-models'.`); }
}

export async function writeGeneratedLayer(path: string, layer: GeneratedLayer): Promise<void> {
  const validated = generatedLayerSchema.parse(layer);
  // Never overwrite a file that is not already a generated layer, such as a misdirected DTR_GENERATED_CONFIG.
  if (!path.endsWith(".json")) throw new Error(`Refusing to write the generated DTR model layer to '${path}': it must be a .json file.`);
  await readGeneratedLayer(path).catch(() => { throw new Error(`Refusing to overwrite '${path}': it is not a generated DTR model layer.`); });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

type RawModel = {
  id: string; provider: ProviderId; model: string; enabled: boolean; lineage?: string | undefined; provisional?: boolean | undefined;
  roles: Partial<Record<WorkerRole, number>>; limits?: { context_tokens: number } | undefined; cost?: { input_per_million: number; output_per_million: number } | undefined;
};

/** Apply the generated layer to expanded registry entries (snake_case, pre-validation). */
export function applyGeneratedLayer<T extends RawModel>(models: T[], layer: GeneratedLayer): T[] {
  const result = models.map((model) => ({ ...model, roles: { ...model.roles } }));
  for (const upgrade of layer.upgrades) {
    const model = result.find((candidate) => candidate.id === upgrade.id);
    if (!model?.lineage) continue;
    const target = lineageVersion(model.lineage, upgrade.model); const current = lineageVersion(model.lineage, model.model);
    if (!target || !current || compareVersions(target, current) <= 0) continue;
    if (result.some((other) => other !== model && other.provider === model.provider && other.model === upgrade.model)) continue;
    model.model = upgrade.model;
    if (upgrade.context_tokens) model.limits = { context_tokens: upgrade.context_tokens };
    if (upgrade.cost) model.cost = upgrade.cost;
  }
  for (const addition of layer.additions) {
    if (result.some((model) => model.id === addition.id || (model.provider === addition.provider && model.model === addition.model))) continue;
    const { addedAt: _addedAt, ...entry } = addition;
    result.push(entry as unknown as T);
  }
  for (const disabled of layer.disabled) {
    const model = result.find((candidate) => candidate.id === disabled.id && candidate.model === disabled.model);
    if (model) model.enabled = false;
  }
  for (const grade of layer.grades) {
    const model = result.find((candidate) => candidate.id === grade.id && candidate.model === grade.model);
    if (!model) continue;
    model.roles = { ...model.roles, ...grade.roles };
    if (Object.values(grade.samples).reduce((sum, count) => sum + count, 0) >= GRADED_SAMPLE_THRESHOLD) model.provisional = false;
  }
  return result;
}

const VERSION = "(?<!\\d)(\\d{1,3}(?!\\d)(?:[.-]\\d{1,3}(?!\\d))*)";

/** The numeric version of `model` within a `prefix{version}suffix` lineage, if it belongs to it. */
export function lineageVersion(lineage: string, model: string): number[] | undefined {
  const parts = lineage.split("{version}");
  if (parts.length !== 2) return undefined;
  const match = model.match(new RegExp(`^${escapeRegExp(parts[0]!)}${VERSION}${escapeRegExp(parts[1]!)}$`));
  return match ? match[1]!.split(/[.-]/).map(Number) : undefined;
}

/** Derive a lineage from a model id by replacing its first version token. */
export function deriveLineage(model: string): string | undefined {
  const match = new RegExp(VERSION).exec(model);
  return match ? `${model.slice(0, match.index)}{version}${model.slice(match.index + match[1]!.length)}` : undefined;
}

export function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
