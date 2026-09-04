import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { truncateTaskResult } from "../contracts.js";
import type { Provider, WorkerRequest, WorkerResult } from "../types.js";

const endpoint = "https://openrouter.ai/api/v1";

export class OpenRouterProvider implements Provider {
  readonly id = "openrouter" as const;
  constructor(private readonly apiKey = process.env.OPENROUTER_API_KEY, private readonly fetcher: typeof fetch = fetch) {}
  async health(): Promise<boolean> { return Boolean(this.apiKey); }
  async run(request: WorkerRequest): Promise<WorkerResult> {
    if (!request.readOnly) return failed(request, "OpenRouter write workers are unsupported in this release.");
    if (!this.apiKey) return failed(request, "OpenRouter is disabled because no credential is available.");
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? 120_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await this.fetcher(`${endpoint}/chat/completions`, {
        method: "POST", signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: request.model, messages: [{ role: "user", content: request.prompt }], reasoning: { effort: request.effort }, max_tokens: 700 }),
      });
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; model?: string; error?: { message?: string }; usage?: { total_tokens?: number } };
      if (!response.ok) return failed(request, `OpenRouter request failed with status ${response.status}`);
      return { provider: this.id, model: body.model ?? request.model, requestedEffort: request.effort, effectiveEffort: request.effort, output: truncateTaskResult(body.choices?.[0]?.message?.content ?? ""), success: true, durationMs: Date.now() - startedAt, providerMetadata: { ...(body.model ? { returned_model: body.model } : {}), ...(body.usage?.total_tokens !== undefined ? { total_tokens: body.usage.total_tokens } : {}) } };
    } catch { return failed(request, "OpenRouter request failed"); }
  }
}

export type OpenRouterCatalogCache = { fetchedAt: string; models: Array<{ id: string; context_length?: number; pricing?: Record<string, string> }> };
export async function refreshOpenRouterCatalog(root: string, apiKey = process.env.OPENROUTER_API_KEY, fetcher: typeof fetch = fetch): Promise<OpenRouterCatalogCache> {
  if (!apiKey) throw new Error("OpenRouter is disabled because no credential is available.");
  const response = await fetcher(`${endpoint}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`OpenRouter catalog refresh failed (${response.status})`);
  const payload = await response.json() as { data?: OpenRouterCatalogCache["models"] }; const cache = { fetchedAt: new Date().toISOString(), models: payload.data ?? [] };
  const directory = resolve(root, ".dtr", "cache"); await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, "openrouter-models.json"), `${JSON.stringify(cache, null, 2)}\n`, "utf8"); return cache;
}
export async function readOpenRouterCatalog(root: string): Promise<{ cache?: OpenRouterCatalogCache; stale: boolean }> {
  try { const cache = JSON.parse(await readFile(resolve(root, ".dtr", "cache", "openrouter-models.json"), "utf8")) as OpenRouterCatalogCache; return { cache, stale: Date.now() - Date.parse(cache.fetchedAt) > 86_400_000 }; }
  catch { return { stale: true }; }
}
function failed(request: WorkerRequest, error: string): WorkerResult { return { provider: "openrouter", model: request.model, requestedEffort: request.effort, output: "", success: false, durationMs: 0, error }; }
