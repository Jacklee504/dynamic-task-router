import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

import type { Effort, ProviderId, WorkerRole } from "./types.js";

const providerSchema = z.enum(["claude", "codex", "ollama", "openrouter", "featherless", "antigravity", "opencode"]);
const modelTierSchema = z.enum(["fast", "standard", "deep", "critical"]);
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const roleSchema = z.enum([
  "architect",
  "implementer",
  "debugger",
  "reviewer",
  "researcher",
  "test",
  "log-analysis",
]);

const partialRolesSchema = z.object({
  architect: z.number().int().min(0).max(10).optional(),
  implementer: z.number().int().min(0).max(10).optional(),
  debugger: z.number().int().min(0).max(10).optional(),
  reviewer: z.number().int().min(0).max(10).optional(),
  researcher: z.number().int().min(0).max(10).optional(),
  test: z.number().int().min(0).max(10).optional(),
  "log-analysis": z.number().int().min(0).max(10).optional(),
});

export const modelProfileSchema = z.object({
  provider: providerSchema.optional(),
  family: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  tier: modelTierSchema.optional(),
  enabled: z.boolean().optional(),
  local: z.boolean().optional(),
  roles: partialRolesSchema.optional(),
  efforts: z.array(effortSchema).min(1).optional(),
  default_effort: effortSchema.optional(),
  capabilities: z.object({
    tools: z.boolean().optional(),
    vision: z.boolean().optional(),
    huge_context: z.boolean().optional(),
    write_safe: z.boolean().optional(),
    worktree_scoped_write: z.boolean().optional(),
    workspace_read: z.boolean().optional(),
    workspace_search: z.boolean().optional(),
    shell_access: z.boolean().optional(),
    native_text_attachments: z.boolean().optional(),
    native_image_attachments: z.boolean().optional(),
    verified_read_only_execution: z.boolean().optional(),
  }).optional(),
  limits: z.object({ context_tokens: z.number().int().positive() }).optional(),
  cost: z.object({ input_per_million: z.number().nonnegative(), output_per_million: z.number().nonnegative() }).optional(),
  privacy: z.object({ private_code_allowed: z.boolean(), training_opt_out_required: z.boolean() }).optional(),
});

const rawModelEntrySchema = z.object({
  id: z.string().min(1),
  profile: z.string().min(1).optional(),
  provider: providerSchema.optional(),
  family: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  tier: modelTierSchema.optional(),
  enabled: z.boolean().optional(),
  local: z.boolean().optional(),
  roles: partialRolesSchema.optional(),
  efforts: z.array(effortSchema).min(1).optional(),
  default_effort: effortSchema.optional(),
  capabilities: z.object({
    tools: z.boolean().optional(),
    vision: z.boolean().optional(),
    huge_context: z.boolean().optional(),
    write_safe: z.boolean().optional(),
    worktree_scoped_write: z.boolean().optional(),
    workspace_read: z.boolean().optional(),
    workspace_search: z.boolean().optional(),
    shell_access: z.boolean().optional(),
    native_text_attachments: z.boolean().optional(),
    native_image_attachments: z.boolean().optional(),
    verified_read_only_execution: z.boolean().optional(),
  }).optional(),
  limits: z.object({ context_tokens: z.number().int().positive() }).optional(),
  cost: z.object({ input_per_million: z.number().nonnegative(), output_per_million: z.number().nonnegative() }).optional(),
  privacy: z.object({ private_code_allowed: z.boolean(), training_opt_out_required: z.boolean() }).optional(),
});

const rawModelsConfigSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string(), modelProfileSchema).optional(),
  models: z.array(rawModelEntrySchema).min(1),
});

export const modelSchema = z.object({
  id: z.string().min(1),
  provider: providerSchema,
  family: z.string().min(1),
  model: z.string().min(1),
  tier: modelTierSchema.default("standard"),
  enabled: z.boolean().default(true),
  local: z.boolean().default(false),
  roles: z.record(roleSchema, z.number().int().min(0).max(10)),
  efforts: z.array(effortSchema).min(1),
  default_effort: effortSchema,
  capabilities: z.object({
    tools: z.boolean(),
    vision: z.boolean().default(false),
    huge_context: z.boolean().default(false),
    write_safe: z.boolean().default(false),
    worktree_scoped_write: z.boolean().default(false),
    workspace_read: z.boolean().default(true),
    workspace_search: z.boolean().default(false),
    shell_access: z.boolean().default(false),
    native_text_attachments: z.boolean().default(false),
    native_image_attachments: z.boolean().default(false),
    verified_read_only_execution: z.boolean().default(false),
  }),
  limits: z.object({ context_tokens: z.number().int().positive() }).default({ context_tokens: 32_768 }),
  cost: z.object({ input_per_million: z.number().nonnegative(), output_per_million: z.number().nonnegative() }).default({ input_per_million: 0, output_per_million: 0 }),
  privacy: z.object({ private_code_allowed: z.boolean(), training_opt_out_required: z.boolean() }).default({ private_code_allowed: false, training_opt_out_required: true }),
}).superRefine((model, context) => {
  if (Object.values(model.roles).every((score) => score === 0)) {
    context.addIssue({ code: "custom", message: "at least one role score must be positive" });
  }
  if (!model.efforts.includes(model.default_effort)) {
    context.addIssue({ code: "custom", message: "default_effort must be allowed" });
  }
});

export const modelsConfigSchema = z.object({
  version: z.literal(1),
  models: z.array(modelSchema).min(1),
}).superRefine((config, context) => {
  const ids = new Set<string>();
  for (const model of config.models) {
    if (ids.has(model.id)) context.addIssue({ code: "custom", message: `Duplicate model id: ${model.id}` });
    ids.add(model.id);
  }
});

const defaultRoles: Record<WorkerRole, number> = {
  architect: 0,
  implementer: 0,
  debugger: 0,
  reviewer: 0,
  researcher: 0,
  test: 0,
  "log-analysis": 0,
};

export function expandModelsConfig(parsed: unknown): z.infer<typeof modelsConfigSchema> {
  const raw = rawModelsConfigSchema.parse(parsed);
  const profiles = raw.profiles ?? {};
  const expandedModels: unknown[] = [];

  for (const entry of raw.models) {
    if (entry.profile) {
      const profile = profiles[entry.profile];
      if (!profile) {
        throw new Error(`Model '${entry.id}' references unknown profile '${entry.profile}'`);
      }
      const merged = {
        ...profile,
        ...entry,
        roles: { ...defaultRoles, ...(profile.roles ?? {}), ...(entry.roles ?? {}) },
        capabilities: { ...(profile.capabilities ?? {}), ...(entry.capabilities ?? {}) },
        limits: entry.limits ?? profile.limits,
        cost: entry.cost ?? profile.cost,
        privacy: entry.privacy ?? profile.privacy,
        efforts: entry.efforts ?? profile.efforts,
        default_effort: entry.default_effort ?? profile.default_effort,
      };
      expandedModels.push(merged);
    } else {
      expandedModels.push({
        ...entry,
        roles: entry.roles ? { ...defaultRoles, ...entry.roles } : undefined,
      });
    }
  }

  return modelsConfigSchema.parse({ version: raw.version, models: expandedModels });
}

/**
 * Personal settings intentionally have no credential field. They can disable
 * built-in models, tune their routing profile, or add fully reviewed models
 * exposed through a local CLI such as OpenCode.
 */
const userModelOverrideSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().optional(),
  tier: modelTierSchema.optional(),
  roles: z.object({
    architect: z.number().int().min(0).max(10).optional(), implementer: z.number().int().min(0).max(10).optional(),
    debugger: z.number().int().min(0).max(10).optional(), reviewer: z.number().int().min(0).max(10).optional(),
    researcher: z.number().int().min(0).max(10).optional(), test: z.number().int().min(0).max(10).optional(),
    "log-analysis": z.number().int().min(0).max(10).optional(),
  }).strict().optional(),
  efforts: z.array(effortSchema).min(1).optional(),
  default_effort: effortSchema.optional(),
}).strict();
const preferenceSchema = z.object({
  provider: providerSchema.optional(),
  model: z.string().min(1).optional(),
  bonus: z.number().int().min(1).max(10).default(2),
  until: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (!value.provider && !value.model) context.addIssue({ code: "custom", message: "preference needs provider or model" });
  if (Date.parse(value.until) <= Date.now()) context.addIssue({ code: "custom", message: "preference until must be in the future" });
});
const userConfigSchema = z.object({
  version: z.literal(1),
  models: z.object({
    overrides: z.array(userModelOverrideSchema).max(100).default([]),
    additions: z.array(modelSchema).max(100).default([]),
  }).strict().default({ overrides: [], additions: [] }),
  routing: z.object({ preferences: z.array(preferenceSchema).max(20).default([]) }).strict().default({ preferences: [] }),
}).strict();

const routingPolicySchema = z.object({
  version: z.literal(1),
  phase: z.literal(2),
  defaults: z.object({
    readOnly: z.literal(true),
    timeoutMs: z.number().int().positive(),
  }),
  rules: z.object({
    automaticSelection: z.literal(true),
    requireExplicitFallback: z.literal(true),
    requireIndependentFamiliesForHighDiversity: z.literal(true),
  }),
  effort: z.object({
    complexity: z.record(z.enum(["trivial", "normal", "difficult", "extreme"]), effortSchema),
    minimumForRisk: z.record(z.enum(["low", "medium", "high"]), effortSchema),
  }),
  diversity: z.record(z.enum(["none", "low", "medium", "high"]), z.object({
    minimumFamilies: z.number().int().min(1),
    requireIndependentReview: z.boolean().optional(),
  })),
  prompt: z.object({
    charsPerToken: z.number().int().min(1).max(16),
    maxInputTokens: z.number().int().positive(),
    responseReserveTokens: z.number().int().nonnegative(),
    hostContextReserveTokens: z.object({
      claude: z.number().int().nonnegative().optional(), codex: z.number().int().nonnegative().optional(),
      ollama: z.number().int().nonnegative().optional(), openrouter: z.number().int().nonnegative().optional(), featherless: z.number().int().nonnegative().optional(), antigravity: z.number().int().nonnegative().optional(), opencode: z.number().int().nonnegative().optional(),
    }).default({}),
    providers: z.object({
      claude: z.object({ append: z.array(z.string().min(1).max(400)).max(3) }).optional(),
      codex: z.object({ append: z.array(z.string().min(1).max(400)).max(3) }).optional(),
      ollama: z.object({ append: z.array(z.string().min(1).max(400)).max(3) }).optional(),
      openrouter: z.object({ append: z.array(z.string().min(1).max(400)).max(3) }).optional(),
      featherless: z.object({ append: z.array(z.string().min(1).max(400)).max(3) }).optional(),
      antigravity: z.object({ append: z.array(z.string().min(1).max(400)).max(3) }).optional(),
      opencode: z.object({ append: z.array(z.string().min(1).max(400)).max(3) }).optional(),
    }).default({}),
  }).default({ charsPerToken: 4, maxInputTokens: 1500, responseReserveTokens: 1024, hostContextReserveTokens: {}, providers: {} }),
  budget: z.object({ mode: z.enum(["ignore", "prefer_free", "capped"]), max_estimated_cost_usd: z.number().nonnegative() }).default({ mode: "ignore", max_estimated_cost_usd: 0 }),
  preferences: z.array(preferenceSchema).default([]),
});

const pipelineStageSchema = z.object({
  id: z.string().min(1), role: roleSchema, strategy: z.enum(["single", "fanout"]), readOnly: z.boolean(),
  dependsOn: z.array(z.string().min(1)).optional(), diversity: z.enum(["none", "low", "medium", "high"]).optional(), preferredFamilies: z.array(z.string().min(1)).optional(),
});
const pipelinesSchema = z.object({ version: z.literal(1), templates: z.array(z.object({ id: z.string().min(1), stages: z.array(pipelineStageSchema).min(1) })).min(1) });

export type ModelConfig = {
  id: string;
  provider: ProviderId;
  family: string;
  model: string;
  tier: z.infer<typeof modelTierSchema>;
  enabled: boolean;
  local: boolean;
  roles: Record<WorkerRole, number>;
  efforts: Effort[];
  defaultEffort: Effort;
  capabilities: {
    tools: boolean;
    vision: boolean;
    hugeContext: boolean;
    writeSafe: boolean;
    worktreeScopedWrite: boolean;
    workspaceRead: boolean;
    workspaceSearch: boolean;
    shellAccess: boolean;
    nativeTextAttachments: boolean;
    nativeImageAttachments: boolean;
    verifiedReadOnlyExecution: boolean;
  };
  limits: { contextTokens: number };
  cost: { inputPerMillion: number; outputPerMillion: number };
  privacy: { privateCodeAllowed: boolean; trainingOptOutRequired: boolean };
};

export type RouterConfig = {
  models: ModelConfig[];
  policy: z.infer<typeof routingPolicySchema>;
  pipelines: z.infer<typeof pipelinesSchema>["templates"];
};

export function parseConfig(modelsText: string, policyText: string, pipelinesText = "version: 1\ntemplates:\n  - id: default\n    stages:\n      - id: stage\n        role: reviewer\n        strategy: single\n        readOnly: true"): RouterConfig {
  const models = expandModelsConfig(parse(modelsText));
  const policy = routingPolicySchema.parse(parse(policyText));
  const pipelines = pipelinesSchema.parse(parse(pipelinesText));
  return {
    models: models.models.map((model) => ({
      id: model.id,
      provider: model.provider,
      family: model.family,
      model: model.model,
      tier: model.tier,
      enabled: model.enabled,
      local: model.local,
      roles: model.roles,
      efforts: model.efforts,
      defaultEffort: model.default_effort,
      capabilities: {
        tools: model.capabilities.tools,
        vision: model.capabilities.vision,
        hugeContext: model.capabilities.huge_context,
        writeSafe: model.capabilities.write_safe,
        worktreeScopedWrite: model.capabilities.worktree_scoped_write,
        workspaceRead: model.capabilities.workspace_read ?? true,
        workspaceSearch: model.capabilities.workspace_search ?? false,
        shellAccess: model.capabilities.shell_access ?? false,
        nativeTextAttachments: model.capabilities.native_text_attachments ?? false,
        nativeImageAttachments: model.capabilities.native_image_attachments ?? false,
        verifiedReadOnlyExecution: model.capabilities.verified_read_only_execution ?? false,
      },
      limits: { contextTokens: model.limits.context_tokens },
      cost: { inputPerMillion: model.cost.input_per_million, outputPerMillion: model.cost.output_per_million },
      privacy: { privateCodeAllowed: model.privacy.private_code_allowed, trainingOptOutRequired: model.privacy.training_opt_out_required },
    })),
    policy, pipelines: pipelines.templates,
  };
}

/** Non-secret personal routing configuration. Never points at an env file. */
export function userConfigPath(): string {
  const configured = process.env.DTR_USER_CONFIG?.trim();
  return configured ? resolve(configured) : resolve(homedir(), ".config", "dynamic-task-router", "config.yaml");
}

export function mergeUserConfig(modelsText: string, userText: string): string {
  const base = expandModelsConfig(parse(modelsText));
  const overlay = userConfigSchema.parse(parse(userText));
  const models = base.models.map((model) => ({ ...model, roles: { ...model.roles }, efforts: [...model.efforts] }));
  for (const override of overlay.models.overrides) {
    const model = models.find((candidate) => candidate.id === override.id);
    if (!model) throw new Error(`Personal configuration references unknown model '${override.id}'`);
    if (override.enabled !== undefined) model.enabled = override.enabled;
    if (override.tier !== undefined) model.tier = override.tier;
    if (override.roles) model.roles = { ...model.roles, ...Object.fromEntries(Object.entries(override.roles).filter(([, value]) => value !== undefined)) as Partial<typeof model.roles> };
    if (override.efforts) model.efforts = override.efforts;
    if (override.default_effort !== undefined) model.default_effort = override.default_effort;
  }
  for (const addition of overlay.models.additions) {
    if (models.some((model) => model.id === addition.id)) throw new Error(`Personal configuration duplicates model id '${addition.id}'`);
    models.push(addition);
  }
  return JSON.stringify(modelsConfigSchema.parse({ version: 1, models }));
}

export async function loadConfig(configDir = resolve(process.cwd(), "config"), personalConfig?: string): Promise<RouterConfig> {
  const [modelsText, policyText, pipelinesText] = await Promise.all([
    readFile(resolve(configDir, "models.yaml"), "utf8"),
    readFile(resolve(configDir, "routing-policy.yaml"), "utf8"),
    readFile(resolve(configDir, "pipelines.yaml"), "utf8"),
  ]);
  const overlayText = personalConfig ? await readOptionalPersonalConfig(personalConfig) : undefined;
  const config = parseConfig(overlayText ? mergeUserConfig(modelsText, overlayText) : modelsText, policyText, pipelinesText);
  if (overlayText) config.policy.preferences = userConfigSchema.parse(parse(overlayText)).routing.preferences;
  return config;
}

async function readOptionalPersonalConfig(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read personal DTR configuration at '${path}'`);
  }
}

export function repositoryRootFromConfig(configDir: string): string {
  return dirname(resolve(configDir));
}

export function findModel(config: RouterConfig, identifier: string): ModelConfig | undefined {
  return config.models.find((model) => model.enabled && (model.id === identifier || model.model === identifier));
}
