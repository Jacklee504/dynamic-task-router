import { describe, expect, it } from "vitest";

import { ClaudeProvider, createClaudeCommand } from "../src/providers/claude.js";
import { createCodexCommand } from "../src/providers/codex.js";
import { createOllamaCommand, OllamaProvider } from "../src/providers/ollama.js";
import { OpenRouterProvider } from "../src/providers/openrouter.js";
import { resolveCodexCommand } from "../src/providers/shared.js";
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
      "exec", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "model_reasoning_effort=high",
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

  it("rejects a write-capable request before process execution", () => {
    expect(() => createCodexCommand({ ...request, readOnly: false })).toThrow("read-only");
  });

  it("uses workspace-write only when a declared write boundary exists", () => {
    const command = createCodexCommand({ ...request, readOnly: false, writeBoundary: { allowedPaths: ["src"] } });
    expect(command.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
    expect(command.args).not.toContain("danger-full-access");
  });
});

describe("provider abort forwarding", () => {
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
});
