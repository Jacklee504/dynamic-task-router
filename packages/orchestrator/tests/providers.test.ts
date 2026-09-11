import { describe, expect, it } from "vitest";

import { ClaudeProvider, createClaudeCommand } from "../src/providers/claude.js";
import { createCodexCommand } from "../src/providers/codex.js";
import { createOllamaCommand, OllamaProvider } from "../src/providers/ollama.js";
import { FeatherlessProvider } from "../src/providers/featherless.js";
import { AntigravityProvider, createAntigravityCommand } from "../src/providers/antigravity.js";
import { OpenCodeProvider, createOpenCodeCommand, parseOpenCodeModels } from "../src/providers/opencode.js";
import { OpenRouterProvider } from "../src/providers/openrouter.js";
import { resolveCodexCommand, resultFromProcess } from "../src/providers/shared.js";
import type { Command, ProcessResult, ProcessRunner, WorkerRequest } from "../src/types.js";

const request: WorkerRequest = {
  prompt: "Review src/index.ts. Do not modify anything.",
  cwd: "/workspace/project",
  role: "reviewer",
  model: "test-model",
  effort: "high",
  readOnly: true,
};

class FakeRunner implements ProcessRunner {
  calls: Command[] = [];
  constructor(private readonly responses: ProcessResult[] = []) {}

  async run(command: Command): Promise<ProcessResult> {
    this.calls.push(command);
    return this.responses.shift() ?? { stdout: "", stderr: "", exitCode: 0, timedOut: false };
  }
}

describe("provider command construction", () => {
  it("uses Claude plan mode and disables project slash commands", () => {
    const command = createClaudeCommand(request);
    expect(command.command).toBe("claude");
    expect(command.args).toContain("--permission-mode");
    expect(command.args).toContain("plan");
    expect(command.args).toContain("--disable-slash-commands");
    expect(command.args).toContain("--no-session-persistence");
  });

  it("uses Codex read-only, ephemeral, isolated execution", () => {
    const command = createCodexCommand(request);
    expect(command.args).toEqual(expect.arrayContaining([
      "exec", "--sandbox", "read-only", "--ephemeral",
      "--json", "model_reasoning_effort=high",
    ]));
    expect(command.args).not.toContain("--ask-for-approval");
  });

  it("uses Codex OSS mode for Ollama without a paid-provider option", () => {
    const command = createOllamaCommand(request);
    expect(command.args).toEqual(expect.arrayContaining([
      "exec", "--oss", "--local-provider", "ollama", "--sandbox", "read-only", "--ephemeral",
    ]));
    expect(command.args).not.toContain("--ask-for-approval");
  });

  it("uses the account-backed Antigravity CLI without an API key or duplicated effort flag", () => {
    const command = createAntigravityCommand(request);
    expect(command.command).toBe("agy");
    expect(command.args).toEqual(expect.arrayContaining(["-p", "--model", "test-model", "--output-format", "json", "--sandbox"]));
    expect(command.args).not.toContain("--effort");
    expect(command.args.join(" ")).toContain("Read-only advisory task");
  });

  it("uses OpenCode's configured provider/model catalog without auto approval", () => {
    const command = createOpenCodeCommand({ ...request, model: "featherless/Qwen/Qwen3-32B" });
    expect(command.command).toBe("opencode");
    expect(command.args).toEqual(expect.arrayContaining(["run", "--model", "featherless/Qwen/Qwen3-32B", "--format", "json", "--dir", request.cwd]));
    expect(command.args).not.toContain("--auto");
    expect(command.args.join(" ")).toContain("Read-only advisory task");
  });

  it("rejects a write-capable request before process execution", () => {
    expect(() => createCodexCommand({ ...request, readOnly: false })).toThrow("read-only");
  });

  it("uses workspace-write only when a declared write boundary exists", () => {
    const command = createCodexCommand({ ...request, readOnly: false, writeBoundary: { allowedPaths: ["src"] } });
    expect(command.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
    expect(command.args).not.toContain("danger-full-access");
  });
});

describe("provider usage normalization", () => {
  it("uses Featherless's OpenAI-compatible endpoint without exposing the credential", async () => {
    let url = ""; let headers: HeadersInit | undefined; let body = "";
    const provider = new FeatherlessProvider("test-key", async (input, init) => {
      url = String(input); headers = init?.headers; body = String(init?.body);
      return new Response(JSON.stringify({ model: "Qwen/Qwen3-32B", choices: [{ message: { content: "STATUS: done" } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }), { status: 200 });
    });
    const result = await provider.run(request);
    expect(url).toBe("https://api.featherless.ai/v1/chat/completions");
    expect(headers).toMatchObject({ Authorization: "Bearer test-key", "X-Title": "Dynamic Task Router" });
    expect(body).toContain("test-model");
    expect(result).toMatchObject({ provider: "featherless", success: true, output: "STATUS: done", usage: { totalTokens: 16 } });
    expect(JSON.stringify(result)).not.toContain("test-key");
  });
  it("forwards the caller's abort signal to the Featherless fetch", async () => {
    let received: AbortSignal | null | undefined;
    const provider = new FeatherlessProvider("test-key", async (_input, init) => {
      received = init?.signal;
      await new Promise<void>((_, reject) => received?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return new Response("unreachable", { status: 200 });
    });
    const controller = new AbortController();
    const promise = provider.run({ ...request, signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(received).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({ provider: "featherless", success: false });
  });

  it("forwards the caller's abort signal to the OpenRouter fetch", async () => {
    let received: AbortSignal | null | undefined;
    const provider = new OpenRouterProvider("test-key", async (_input, init) => {
      received = init?.signal;
      await new Promise<void>((_, reject) => received?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return new Response("unreachable", { status: 200 });
    });
    const controller = new AbortController();
    const promise = provider.run({ ...request, signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(received).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({ provider: "openrouter", success: false });
  });

  it("extracts Claude result text and reported usage from JSON output", () => {
    const result = resultFromProcess("claude", request, Date.now(), { stdout: JSON.stringify({ result: "compact finding", usage: { input_tokens: 12, output_tokens: 5 }, total_cost_usd: 0.004 }), stderr: "", exitCode: 0, timedOut: false });
    expect(result).toMatchObject({ output: "compact finding", usage: { source: "provider-reported", inputTokens: 12, outputTokens: 5, totalTokens: 17, costUsd: 0.004 } });
  });

  it("reports failure when Claude flags is_error with a zero exit code", () => {
    const result = resultFromProcess("claude", request, Date.now(), { stdout: JSON.stringify({ result: "Permission denied during execution", is_error: true }), stderr: "", exitCode: 0, timedOut: false });
    expect(result).toMatchObject({ success: false, error: "Permission denied during execution" });
  });

  it("extracts a final Codex message and token usage from JSONL", () => {
    const result = resultFromProcess("codex", request, Date.now(), { stdout: `${JSON.stringify({ type: "thread.started" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "compact finding" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 4, output_tokens: 8 } })}`, stderr: "", exitCode: 0, timedOut: false });
    expect(result).toMatchObject({ output: "compact finding", usage: { source: "provider-reported", inputTokens: 20, cachedInputTokens: 4, outputTokens: 8, totalTokens: 28 } });
  });

  it("captures Codex reasoning tokens reported as reasoning_output_tokens", () => {
    const result = resultFromProcess("codex", request, Date.now(), { stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "compact finding" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 8, reasoning_output_tokens: 6 } })}`, stderr: "", exitCode: 0, timedOut: false });
    expect(result).toMatchObject({ usage: { reasoningTokens: 6 } });
  });

  it("extracts OpenCode message text and step-finish token usage from part payloads", () => {
    const result = resultFromProcess("opencode", request, Date.now(), { stdout: `${JSON.stringify({ type: "message.part", part: { type: "text", text: "compact finding" } })}\n${JSON.stringify({ type: "step-finish", part: { type: "step-finish", tokens: { input: 30, output: 10, reasoning: 5, total: 45, cost: 0.002 } } })}`, stderr: "", exitCode: 0, timedOut: false });
    expect(result).toMatchObject({ output: "compact finding", usage: { source: "provider-reported", inputTokens: 30, outputTokens: 10, reasoningTokens: 5, totalTokens: 45, costUsd: 0.002 } });
  });

  it("extracts OpenCode token usage when tokens are reported at the event top level", () => {
    const result = resultFromProcess("opencode", request, Date.now(), { stdout: `${JSON.stringify({ type: "step-finish", tokens: { input: 7, output: 3, total: 10 } })}`, stderr: "", exitCode: 0, timedOut: false });
    expect(result).toMatchObject({ usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
  });
});

describe("provider health and safety fallback", () => {
  it("finds an authenticated bundled Codex CLI when PATH has no codex command", async () => {
    const runner = new FakeRunner([
      { stdout: "", stderr: "not found", exitCode: null, timedOut: false, error: "ENOENT" },
      { stdout: "Codex CLI", stderr: "", exitCode: 0, timedOut: false },
      { stdout: "Logged in", stderr: "", exitCode: 0, timedOut: false },
    ]);
    await expect(resolveCodexCommand(runner, "/workspace/project", ["codex", "/Applications/ChatGPT.app/Contents/Resources/codex"], true)).resolves.toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
  });

  it("reports Claude unavailable when the executable cannot run", async () => {
    const provider = new ClaudeProvider(new FakeRunner([{ stdout: "", stderr: "not found", exitCode: null, timedOut: false, error: "ENOENT" }]));
    await expect(provider.health()).resolves.toBe(false);
  });

  it("refuses Claude execution when plan mode is unsupported", async () => {
    const provider = new ClaudeProvider(new FakeRunner([{ stdout: "no useful flags", stderr: "", exitCode: 0, timedOut: false }]));
    const result = await provider.run(request);
    expect(result.success).toBe(false);
    expect(result.error).toContain("read-only enforcement");
  });

  it("does not pull an unavailable Ollama model", async () => {
    const runner = new FakeRunner([{ stdout: "NAME ID SIZE\nother:latest abc 1GB\n", stderr: "", exitCode: 0, timedOut: false }]);
    const provider = new OllamaProvider(runner);
    const result = await provider.run(request);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No model was pulled");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual({ command: "ollama", args: ["list"] });
  });

  it("discovers only models exposed by the signed-in Antigravity account", async () => {
    const provider = new AntigravityProvider(new FakeRunner([
      { stdout: "Antigravity CLI", stderr: "", exitCode: 0, timedOut: false },
      { stdout: "gemini-3.8-flash-medium Gemini 3.8 Flash (Medium)\n", stderr: "", exitCode: 0, timedOut: false },
    ]));
    await expect(provider.availableModels("/workspace/project")).resolves.toEqual(new Set(["gemini-3.8-flash-medium"]));
  });

  it("discovers only provider/model names exposed by OpenCode", async () => {
    const provider = new OpenCodeProvider(new FakeRunner([
      { stdout: "OpenCode 1.18", stderr: "", exitCode: 0, timedOut: false },
      { stdout: "\u001b[32mfeatherless/Qwen/Qwen3-32B\u001b[0m Qwen\nollama-local/qwen3.5:9b Local\n", stderr: "", exitCode: 0, timedOut: false },
    ]));
    await expect(provider.availableModels("/workspace/project")).resolves.toEqual(new Set(["featherless/Qwen/Qwen3-32B", "ollama-local/qwen3.5:9b"]));
    expect(parseOpenCodeModels("heading\nnot/a model name\n")).toEqual(new Set(["not/a"]));
  });
});
