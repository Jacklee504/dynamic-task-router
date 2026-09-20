import { truncateTaskResult } from "../contracts.js";
import type { Provider, ProviderCapabilities, WorkerRequest, WorkerResult } from "../types.js";

const endpoint = "https://api.featherless.ai/v1";

/** OpenAI-compatible, read-only Featherless adapter. Credentials stay outside the repository. */
export class FeatherlessProvider implements Provider {
  readonly id = "featherless" as const;
  constructor(private readonly apiKey = process.env.FEATHERLESS_API_KEY, private readonly fetcher: typeof fetch = fetch) {}
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
    if (!request.readOnly) return failed(request, "Featherless write workers are unsupported in this release.");
    if (!this.apiKey) return failed(request, "Featherless is unavailable because no process credential is configured.");
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? 600_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await this.fetcher(`${endpoint}/chat/completions`, {
        method: "POST", signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/Jacklee504/dynamic-task-router", "X-Title": "Dynamic Task Router" },
        body: JSON.stringify({ model: request.model, messages: [{ role: "user", content: request.prompt }], temperature: 0.2, max_tokens: 384 }),
      });
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
      if (!response.ok) return failed(request, `Featherless request failed with status ${response.status}`);
      const inputTokens = body.usage?.prompt_tokens; const outputTokens = body.usage?.completion_tokens; const totalTokens = body.usage?.total_tokens ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
      const usage = inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined ? { source: "provider-reported" as const, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}) } : undefined;
      return { provider: this.id, model: body.model ?? request.model, requestedEffort: request.effort, effectiveEffort: request.effort, output: truncateTaskResult(body.choices?.[0]?.message?.content ?? ""), success: true, durationMs: Date.now() - startedAt, ...(usage ? { usage } : {}), providerMetadata: { ...(body.model ? { returned_model: body.model } : {}), ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}) } };
    } catch { return failed(request, "Featherless request failed"); }
  }
}

function failed(request: WorkerRequest, error: string): WorkerResult { return { provider: "featherless", model: request.model, requestedEffort: request.effort, output: "", success: false, durationMs: 0, error }; }
