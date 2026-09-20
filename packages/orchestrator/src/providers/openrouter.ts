import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { truncateTaskResult } from "../contracts.js";
import type { Provider, ProviderCapabilities, WorkerRequest, WorkerResult } from "../types.js";

const endpoint = "https://openrouter.ai/api/v1";

export class OpenRouterProvider implements Provider {
  readonly id = "openrouter" as const;
  constructor(private readonly apiKey = process.env.OPENROUTER_API_KEY, private readonly fetcher: typeof fetch = fetch) {}
  async health(): Promise<boolean> { return Boolean(this.apiKey); }

  capabilities(): ProviderCapabilities {
    return {
      workspaceRead: false,
      workspaceSearch: false,
      shellAccess: false,
      nativeTextAttachments: false,
      nativeImageAttachments: false,
      verifiedReadOnlyExecution: true,
      worktreeScopedWrite: false,
    };
  }

  async run(request: WorkerRequest): Promise<WorkerResult> {
    if (!request.readOnly) return failed(request, "OpenRouter write workers are unsupported in this release.");
    if (!this.apiKey) return failed(request, "OpenRouter is disabled because no credential is available.");
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? 600_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await this.fetcher(`${endpoint}/chat/completions`, {
        method: "POST", signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: request.model, messages: [{ role: "user", content: request.prompt }], reasoning: { effort: request.effort }, max_tokens: 700 }),
      });
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; model?: string; error?: { message?: string }; usage?: { input_tokens?: number; prompt_tokens?: number; output_tokens?: number; completion_tokens?: number; reasoning_tokens?: number; total_tokens?: number; cost?: number; total_cost?: number } };
      if (!response.ok) return failed(request, `OpenRouter request failed with status ${response.status}`);
      const inputTokens = body.usage?.input_tokens ?? body.usage?.prompt_tokens; const outputTokens = body.usage?.output_tokens ?? body.usage?.completion_tokens; const totalTokens = body.usage?.total_tokens ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined); const costUsd = body.usage?.cost ?? body.usage?.total_cost;
      const usage = inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined || body.usage?.reasoning_tokens !== undefined || costUsd !== undefined
        ? { source: "provider-reported" as const, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(body.usage?.reasoning_tokens !== undefined ? { reasoningTokens: body.usage.reasoning_tokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) }
        : undefined;
      return { provider: this.id, model: body.model ?? request.model, requestedEffort: request.effort, effectiveEffort: request.effort, output: truncateTaskResult(body.choices?.[0]?.message?.content ?? ""), success: true, durationMs: Date.now() - startedAt, ...(usage ? { usage } : {}), providerMetadata: { ...(body.model ? { returned_model: body.model } : {}), ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}) } };
    } catch { return failed(request, "OpenRouter request failed"); }
  }
}

export type OpenRouterCatalogCache = { fetchedAt: string; models: Array<{ id: string; context_length?: number; pricing?: Record<string, string> }> };
export async function refreshOpenRouterCatalog(root: string, apiKey = process.env.OPENROUTER_API_KEY, fetcher: typeof fetch = fetch): Promise<OpenRouterCatalogCache> {
  if (!apiKey) throw new Error("OpenRouter is disabled because no credential is available.");
  const response = await fetcher(`${endpoint}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`OpenRouter catalog refresh failed (${response.status})`);
  const payload = await response.json() as { data?: OpenRouterCatalogCache["models"] }; const cache = { fetchedAt: new Date().toISOString(), models: payload.data ?? [] };
  const directory = resolve(root, "cache"); await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(resolve(directory, "openrouter-models.json"), `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); return cache;
}
export async function readOpenRouterCatalog(root: string): Promise<{ cache?: OpenRouterCatalogCache; stale: boolean }> {
  try { const cache = JSON.parse(await readFile(resolve(root, "cache", "openrouter-models.json"), "utf8")) as OpenRouterCatalogCache; return { cache, stale: Date.now() - Date.parse(cache.fetchedAt) > 86_400_000 }; }
  catch { return { stale: true }; }
}
function failed(request: WorkerRequest, error: string): WorkerResult { return { provider: "openrouter", model: request.model, requestedEffort: request.effort, output: "", success: false, durationMs: 0, error }; }
