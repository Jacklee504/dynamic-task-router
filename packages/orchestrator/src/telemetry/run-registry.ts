import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RunState } from "../types.js";

export interface RunRecord {
  id: string;
  state: RunState;
  strategy: "pipeline" | "single" | "fanout";
  template?: string;
  startedAt: string;
  endedAt?: string;
  stages: Array<{ id: string; state: RunState; model?: string; error?: string; changedPaths?: string[]; checks?: Array<{ command: string; success: boolean }> }>;
  error?: string;
  outcome?: { status: "accepted" | "rejected" | "partial" | "escalated"; reviewFindingsCount?: number; regressionDetected?: boolean; manualScore?: number };
}

export async function createRunRecord(stateRoot: string, strategy: RunRecord["strategy"], template?: string, id?: string): Promise<RunRecord> {
  const record: RunRecord = { id: id ?? randomUUID(), state: "queued", strategy, ...(template ? { template } : {}), startedAt: new Date().toISOString(), stages: [] };
  await writeRunRecord(stateRoot, record);
  return record;
}

export async function writeRunRecord(stateRoot: string, record: RunRecord): Promise<void> {
  const directory = resolve(stateRoot, "runs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, `${record.id}.status.json`), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readRunRecord(stateRoot: string, runId: string): Promise<RunRecord> {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error("Invalid run ID");
  return JSON.parse(await readFile(resolve(stateRoot, "runs", `${runId}.status.json`), "utf8")) as RunRecord;
}

export async function attachRunOutcome(stateRoot: string, runId: string, outcome: NonNullable<RunRecord["outcome"]>): Promise<RunRecord> {
  const record = await readRunRecord(stateRoot, runId); record.outcome = outcome; await writeRunRecord(stateRoot, record); return record;
}
