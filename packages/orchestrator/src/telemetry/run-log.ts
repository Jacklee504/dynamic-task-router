import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { RoutingMetadata, WorkerRequest, WorkerResult } from "../types.js";

export type RunLog = {
  provider: WorkerResult["provider"];
  model: string;
  role: WorkerRequest["role"];
  requestedEffort: WorkerResult["requestedEffort"];
  effectiveEffort?: WorkerResult["effectiveEffort"];
  routing?: Omit<RoutingMetadata, "profile"> & { profile: RoutingMetadata["profile"] };
  readOnly: boolean;
  success: boolean;
  durationMs: number;
  timestamp: string;
  error?: string;
  usage?: WorkerResult["usage"];
  providerMetadata?: WorkerResult["providerMetadata"];
};

export function makeRunLog(
  request: WorkerRequest,
  result: WorkerResult,
  timestamp = new Date().toISOString(),
  routing?: RoutingMetadata,
): RunLog {
  return {
    provider: result.provider,
    model: result.model,
    role: request.role,
    requestedEffort: result.requestedEffort,
    ...(result.effectiveEffort ? { effectiveEffort: result.effectiveEffort } : {}),
    readOnly: request.readOnly,
    success: result.success,
    durationMs: result.durationMs,
    timestamp,
    ...(result.error ? { error: result.error } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}),
    ...(routing ? { routing } : {}),
  };
}

export async function writeRunLog(
  stateRoot: string,
  request: WorkerRequest,
  result: WorkerResult,
  routing?: RoutingMetadata,
): Promise<string> {
  const directory = resolve(stateRoot, "runs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  const path = resolve(directory, filename);
  await writeFile(path, `${JSON.stringify(makeRunLog(request, result, undefined, routing), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}
