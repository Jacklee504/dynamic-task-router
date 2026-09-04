import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ProviderId, TokenUsage } from "../types.js";
import type { RunLog } from "./run-log.js";

export type ProviderUsageReport = {
  provider: ProviderId;
  executions: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  tokens: {
    reportingExecutions: number;
    unreportedExecutions: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  accountQuota: { status: "not-exposed" | "not-applicable"; detail: string };
};

export type UsageReport = { scope: "DTR execution telemetry"; providers: ProviderUsageReport[] };

const providerIds: ProviderId[] = ["claude", "codex", "ollama", "openrouter", "featherless", "antigravity", "opencode"];

export async function summarizeUsage(root: string, included: ProviderId[] = providerIds): Promise<UsageReport> {
  const entries = await readLogs(root);
  return {
    scope: "DTR execution telemetry",
    providers: included.map((provider) => summarizeProvider(provider, entries.filter((entry) => entry.provider === provider))),
  };
}

async function readLogs(stateRoot: string): Promise<RunLog[]> {
  try {
    const directory = resolve(stateRoot, "runs");
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json") && !name.endsWith(".status.json"));
    const logs = await Promise.all(names.map(async (name) => parseLog(await readFile(resolve(directory, name), "utf8"))));
    return logs.filter((log): log is RunLog => log !== undefined);
  } catch { return []; }
}

function parseLog(value: string): RunLog | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<RunLog>;
    return providerIds.includes(parsed.provider as ProviderId) && typeof parsed.success === "boolean" && typeof parsed.durationMs === "number" ? parsed as RunLog : undefined;
  } catch { return undefined; }
}

function summarizeProvider(provider: ProviderId, entries: RunLog[]): ProviderUsageReport {
  const reported = entries.map((entry) => entry.usage).filter((usage): usage is TokenUsage => usage?.source === "provider-reported");
  const tokens = aggregate(reported);
  return {
    provider,
    executions: entries.length,
    succeeded: entries.filter((entry) => entry.success).length,
    failed: entries.filter((entry) => !entry.success).length,
    durationMs: entries.reduce((total, entry) => total + entry.durationMs, 0),
    tokens: { reportingExecutions: reported.length, unreportedExecutions: entries.length - reported.length, ...tokens },
    accountQuota: quotaStatus(provider),
  };
}

function aggregate(usages: TokenUsage[]): Omit<ProviderUsageReport["tokens"], "reportingExecutions" | "unreportedExecutions"> {
  const fields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costUsd"] as const;
  const result: Partial<Record<(typeof fields)[number], number>> = {};
  for (const field of fields) {
    const values = usages.map((usage) => usage[field]).filter((value): value is number => typeof value === "number");
    if (values.length) result[field] = values.reduce((total, value) => total + value, 0);
  }
  return result;
}

function quotaStatus(provider: ProviderId): ProviderUsageReport["accountQuota"] {
  if (provider === "ollama") return { status: "not-applicable", detail: "Local execution has no hosted account quota." };
  if (provider === "openrouter" || provider === "featherless") return { status: "not-exposed", detail: "DTR records response usage but does not query account balance." };
  return { status: "not-exposed", detail: "Authenticated CLI subscription quota is not exposed or scraped by DTR." };
}
