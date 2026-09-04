import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readRunRecord, type RunRecord } from "./telemetry/run-registry.js";

export async function summarizeRuns(stateRoot: string): Promise<{ runs: number; states: Record<string, number>; outcomes: Record<string, number>; suggestion?: string }> {
  let files: string[] = []; try { files = (await readdir(resolve(stateRoot, "runs"))).filter((name) => name.endsWith(".status.json")); } catch { return { runs: 0, states: {}, outcomes: {} }; }
  const records = await Promise.all(files.map((file) => readRunRecord(stateRoot, file.replace(".status.json", "")))); const states: Record<string, number> = {}; const outcomes: Record<string, number> = {};
  for (const record of records) { states[record.state] = (states[record.state] ?? 0) + 1; if (record.outcome) outcomes[record.outcome.status] = (outcomes[record.outcome.status] ?? 0) + 1; }
  const observed = Object.values(outcomes).reduce((sum, value) => sum + value, 0);
  return { runs: records.length, states, outcomes, ...(observed >= 20 ? { suggestion: "Enough manually reviewed outcomes exist to inspect routing priors; no config was modified." } : {}) };
}
