import { isAbsolute, normalize } from "node:path";
import type { ProviderId } from "./types.js";

/** Limits for the normal, model-routed dispatch path. */
export const MAX_COMPACT_TASK_WORDS = 100;
export const MAX_COMPACT_TASK_CHARS = 1_000;
export const MAX_RELEVANT_FILES = 8;
export const MAX_RELEVANT_FILE_CHARS = 256;

/** Limits retained for the explicit, expert raw-prompt escape hatch. */
export const MAX_TASK_INPUT_CHARS = 6_000;
export const MAX_TASK_RESULT_CHARS = 1_200;

/** Baseline restrictions for every routed worker. */
export const EXECUTION_RESTRICTIONS = "SAFETY: Do not run rm/rmdir/unlink or recursive deletion; do not commit, push, reset, clean, checkout, merge, or rebase Git; do not change secrets, auth, global config, dependencies, or use network installs. Edit only when DTR grants a write scope; never delete or rename files.";

export const DISPATCH_CONTRACT = [
  "DTR dispatch contract v1",
  `1. Send one task of at most ${MAX_COMPACT_TASK_WORDS} words.`,
  "2. Include only the goal, essential facts, constraints, and desired check.",
  "3. List relevant file paths; do not paste source, logs, transcripts, or reasoning.",
  "4. Dispatch with: dtr route --task \"…\" --files \"path1,path2\".",
  "5. Result is capped to a concise STATUS, PATHS, CHECK, and RISK handoff.",
].join("\n");

type ProviderScoped<T> = { claude?: T | undefined; codex?: T | undefined; ollama?: T | undefined; openrouter?: T | undefined; featherless?: T | undefined; antigravity?: T | undefined; opencode?: T | undefined };

export type PromptPolicy = {
  charsPerToken: number;
  maxInputTokens: number;
  responseReserveTokens: number;
  hostContextReserveTokens: ProviderScoped<number>;
  providers: ProviderScoped<{ append: string[] }>;
};

export type PromptTarget = { provider: ProviderId; model: string; contextTokens: number };

/**
 * Builds the only packet accepted by the normal `dtr route` path. Keeping the
 * user-provided task and file list separate prevents an accidental source or
 * transcript dump from becoming worker context.
 */
export function buildCompactTaskPacket(task: string, files?: string | readonly string[]): string {
  const normalizedTask = normalizeCompactTask(task);
  const listedFiles = normalizeRelevantFiles(files);
  return [
    `TASK:\n${normalizedTask}`,
    `RELEVANT FILES:\n${listedFiles.length ? listedFiles.map((file) => `- ${file}`).join("\n") : "- none named"}`,
    "WORKING BOUNDARY:\nTreat the named files as the initial scope. Do not perform a broad repository scan. Read another path only when it is a direct dependency, and name it in PATHS.",
    "RETURN (120 words maximum):\nSTATUS: done | blocked | needs-decision\nPATHS: changed, inspected, or none\nCHECK: command/result, or not run + why\nRISK: blocker, follow-up, or none",
  ].join("\n\n");
}

export function normalizeCompactTask(task: string): string {
  const normalized = task.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Compact task text must not be empty. Run `dtr start` for the dispatch contract.");
  if (normalized.length > MAX_COMPACT_TASK_CHARS) throw new Error(`Compact task rejected: ${normalized.length} characters exceeds the ${MAX_COMPACT_TASK_CHARS}-character limit. Remove reasoning, logs, pasted source, and transcripts.`);
  const words = normalized.match(/\S+/g)?.length ?? 0;
  if (words > MAX_COMPACT_TASK_WORDS) throw new Error(`Compact task rejected: ${words} words exceeds the ${MAX_COMPACT_TASK_WORDS}-word limit. Remove routing rationale, logs, pasted source, and transcripts.`);
  return normalized;
}

export function normalizeRelevantFiles(files?: string | readonly string[]): string[] {
  const values = typeof files === "string" ? files.split(",") : files ?? [];
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length > MAX_RELEVANT_FILES) throw new Error(`--files accepts at most ${MAX_RELEVANT_FILES} paths; list only the files needed for the task.`);
  const unique = new Set<string>();
  for (const file of normalized) {
    if (file.length > MAX_RELEVANT_FILE_CHARS) throw new Error(`File path '${file.slice(0, 80)}…' exceeds the ${MAX_RELEVANT_FILE_CHARS}-character limit.`);
    const canonical = normalize(file);
    if (isAbsolute(canonical) || canonical === ".." || canonical.startsWith(`..${String.fromCharCode(47)}`) || canonical.includes("\0")) throw new Error(`File path '${file}' must be a relative path inside --cwd.`);
    unique.add(canonical);
  }
  return [...unique];
}

export function compactTaskPrompt(prompt: string, policy?: PromptPolicy, target?: PromptTarget): string {
  const normalized = prompt.trim();
  if (!normalized) throw new Error("Task prompt must not be empty");
  if (normalized.length > MAX_TASK_INPUT_CHARS) throw new Error(`Task prompt exceeds the ${MAX_TASK_INPUT_CHARS}-character bound; reduce it to the required paths, symbols, and evidence.`);
  const additions = policy && target ? policy.providers[target.provider]?.append ?? [] : [];
  const composed = [
    normalized,
    additions.length ? `Provider instructions:\n${additions.map((instruction) => `- ${instruction.trim()}`).join("\n")}` : "",
    EXECUTION_RESTRICTIONS,
    "Return only this concise handoff (120 words maximum): STATUS; PATHS; CHECK; RISK. Do not include a prose preamble, rationale, transcript, or raw log.",
  ].filter(Boolean).join("\n\n");
  if (policy && target) assertTokenBudget(composed, policy, target);
  return composed;
}

function assertTokenBudget(prompt: string, policy: PromptPolicy, target: PromptTarget): void {
  const hostReserve = policy.hostContextReserveTokens[target.provider] ?? 0;
  const contextBudget = target.contextTokens - policy.responseReserveTokens - hostReserve;
  const inputBudget = Math.min(policy.maxInputTokens, contextBudget);
  if (inputBudget <= 0) throw new Error(`Prompt budget for ${target.provider}/${target.model} is exhausted by configured response and host-context reserves.`);
  const estimatedTokens = Math.ceil(prompt.length / policy.charsPerToken);
  if (estimatedTokens > inputBudget) {
    throw new Error(`Prompt requires an estimated ${estimatedTokens} tokens, above the ${inputBudget}-token budget for ${target.provider}/${target.model}. Reduce task context or provider instructions.`);
  }
}

export function truncateTaskResult(value: string): string {
  return value.length <= MAX_TASK_RESULT_CHARS ? value : `${value.slice(0, MAX_TASK_RESULT_CHARS)}\n[Result truncated by Dynamic Task Router]`;
}
