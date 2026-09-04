import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeRunLog } from "../src/telemetry/run-log.js";
import { summarizeUsage } from "../src/telemetry/usage.js";
import type { WorkerRequest, WorkerResult } from "../src/types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("usage telemetry", () => {
  it("reports every provider while aggregating only recorded token fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "dtr-usage-")); directories.push(root);
    const request: WorkerRequest = { prompt: "not persisted", cwd: root, role: "reviewer", model: "model", effort: "high", readOnly: true };
    const result: WorkerResult = { provider: "codex", model: "model", requestedEffort: "high", output: "not persisted", success: true, durationMs: 25, usage: { source: "provider-reported", inputTokens: 13, outputTokens: 7, totalTokens: 20 } };
    await writeRunLog(root, request, result);
    const report = await summarizeUsage(root);
    expect(report.scope).toBe("DTR execution telemetry");
    expect(report.providers.map((item) => item.provider)).toEqual(["claude", "codex", "ollama", "openrouter", "featherless", "antigravity"]);
    expect(report.providers.find((item) => item.provider === "codex")).toMatchObject({ executions: 1, succeeded: 1, tokens: { reportingExecutions: 1, totalTokens: 20 } });
    expect(report.providers.find((item) => item.provider === "claude")).toMatchObject({ executions: 0, accountQuota: { status: "not-exposed" } });
  });
});
