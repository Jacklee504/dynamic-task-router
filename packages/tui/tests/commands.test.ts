import { describe, expect, it, vi } from "vitest";
import type { DtrApplication } from "@dynamic-task-router/orchestrator";
import { commandRegistry, commandSuggestions, findCommand, submit } from "../src/commands/registry.js";
import { parseInput, tokenize } from "../src/commands/parser.js";

describe("terminal command parsing", () => {
  it("distinguishes normal tasks, slash commands, quotes, and empty input", () => {
    expect(parseInput("Investigate the reconnect failure")).toEqual({ kind: "task", task: "Investigate the reconnect failure" });
    expect(parseInput("/fanout \"reconnect test\" now")).toEqual({ kind: "command", name: "fanout", args: ["reconnect test", "now"] });
    expect(parseInput("   ")).toEqual({ kind: "empty" });
    expect(tokenize("one 'two three' four\\ five")).toEqual(["one", "two three", "four five"]);
  });

  it("exposes every required command from one registry", () => {
    const names = new Set(commandRegistry.map((command) => command.name));
    for (const name of ["route", "fanout", "pipeline", "models", "model", "providers", "provider", "effort", "mode", "usage", "context", "status", "workers", "runs", "chats", "run", "pick", "attach", "resume", "detach", "new", "reply", "history", "parent", "result", "abort", "health", "config", "clear", "help", "quit"]) expect(names.has(name)).toBe(true);
    expect(findCommand("m")?.name).toBe("models");
    expect(commandSuggestions("/fa").map((command) => command.name)).toEqual(["fanout"]);
    expect(commandSuggestions("/route task").map((command) => command.name)).toEqual(["route"]);
  });

  it("dispatches a route immediately with compact named-file context", async () => {
    const dispatch = vi.fn(async () => ({ runId: "12345678-0000-0000-0000-000000000000" }));
    const run = vi.fn();
    const context = { application: { dispatch, run } as unknown as DtrApplication, cwd: "/project", overrides: {} };
    const result = await findCommand("route")!.execute(["Review", "parser", "--files", "src/parser.ts,test/parser.test.ts"], context);
    expect(result.message).toContain("started");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Review parser", files: ["src/parser.ts", "test/parser.test.ts"], conversation: {} }));
    expect(result.attachRunId).toBe("12345678-0000-0000-0000-000000000000");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps fanout responsive and rejects incompatible session pins", async () => {
    const fanout = vi.fn(() => new Promise<never>(() => undefined));
    const context = { application: { fanout } as unknown as DtrApplication, cwd: "/project", overrides: {} };
    await expect(findCommand("fanout")!.execute(["Check", "routing"], context)).resolves.toMatchObject({ screen: "dashboard", message: expect.stringContaining("starting") });
    expect(fanout).toHaveBeenCalledOnce();
    const pinned = { ...context, overrides: { provider: "codex" as const } };
    await expect(findCommand("fanout")!.execute(["Check", "routing"], pinned)).resolves.toMatchObject({ message: expect.stringContaining("/provider auto") });
    expect(fanout).toHaveBeenCalledOnce();
    await expect(findCommand("fanout")!.execute(["Check", "routing"], { ...context, attachedRunId: "12345678" })).resolves.toMatchObject({ message: expect.stringContaining("/detach") });
    expect(fanout).toHaveBeenCalledOnce();
  });

  it("attaches to a DTR conversation and routes follow-ups through its handoff", async () => {
    const context = { application: {} as DtrApplication, cwd: "/project", overrides: {} };
    await expect(findCommand("attach")!.execute(["12345678"], context)).resolves.toMatchObject({ selectedRunId: "12345678", attachRunId: "12345678", screen: "run-detail" });
    await expect(findCommand("detach")!.execute([], context)).resolves.toMatchObject({ detach: true });
    await expect(findCommand("help")!.execute(["attach"], context)).resolves.toMatchObject({ message: expect.stringContaining("Resume a completed DTR conversation") });
    const dispatch = vi.fn(async () => ({ runId: "87654321" }));
    await expect(submit("What about tests?", { ...context, attachedRunId: "12345678", application: { dispatch } as unknown as DtrApplication })).resolves.toMatchObject({ attachRunId: "87654321" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ conversation: { parentRunId: "12345678" } }));
    await expect(findCommand("quit")!.execute([], { ...context, activeRunId: "12345678" })).resolves.toMatchObject({ message: expect.stringContaining("/abort") });
  });

  it("lists, resumes, and navigates conversations without changing the layout", async () => {
    const root = "11111111-1111-1111-1111-111111111111";
    const latest = "22222222-2222-2222-2222-222222222222";
    const listRuns = vi.fn(async () => [
      { id: latest, strategy: "single", state: "succeeded", conversation: { rootRunId: root, parentRunId: root, handoff: "Done" } },
      { id: root, strategy: "single", state: "succeeded", conversation: { rootRunId: root, handoff: "First" } },
    ]);
    const getRun = vi.fn(async (id: string) => id === latest ? { id, conversation: { rootRunId: root, parentRunId: root } } : null);
    const context = { application: { listRuns, getRun } as unknown as DtrApplication, cwd: "/project", overrides: {}, attachedRunId: latest };
    await expect(findCommand("chats")!.execute([], context)).resolves.toMatchObject({ screen: "chats" });
    await expect(findCommand("resume")!.execute([], context)).resolves.toMatchObject({ selectedRunId: latest, attachRunId: latest });
    await expect(findCommand("resume")!.execute([root], context)).resolves.toMatchObject({ selectedRunId: root, attachRunId: root });
    await expect(findCommand("history")!.execute([], context)).resolves.toMatchObject({ screen: "history", conversationRootId: root });
    await expect(findCommand("parent")!.execute([], context)).resolves.toMatchObject({ selectedRunId: root, attachRunId: root });
    await expect(findCommand("parent")!.execute([], { ...context, attachedRunId: undefined })).resolves.toMatchObject({ message: expect.stringContaining("No conversation attached") });
  });

  it("starts a fresh conversation or sends an explicit reply", async () => {
    const dispatch = vi.fn(async () => ({ runId: "33333333-3333-3333-3333-333333333333" }));
    const context = { application: { dispatch } as unknown as DtrApplication, cwd: "/project", overrides: {}, attachedRunId: "22222222-2222-2222-2222-222222222222" };
    await expect(findCommand("new")!.execute([], { ...context, overrides: { mode: "fanout" as const } })).resolves.toMatchObject({ detach: true, overrides: { mode: "single" } });
    await expect(findCommand("new")!.execute(["Review", "parser", "--files", "parser.ts"], context)).resolves.toMatchObject({ attachRunId: "33333333-3333-3333-3333-333333333333", overrides: { mode: "single" } });
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "Review parser", files: ["parser.ts"], conversation: {} }));
    await expect(findCommand("reply")!.execute(["Check", "tests"], context)).resolves.toMatchObject({ attachRunId: "33333333-3333-3333-3333-333333333333" });
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "Check tests", conversation: { parentRunId: context.attachedRunId } }));
    await expect(findCommand("reply")!.execute(["Check", "tests"], { ...context, attachedRunId: undefined })).resolves.toMatchObject({ message: expect.stringContaining("No conversation attached") });
  });

  it("opens the full result text for the latest run", async () => {
    const context = { application: {} as DtrApplication, cwd: "/project", overrides: {}, latestResult: { id: "12345678-0000-4000-8000-000000000000", output: "STATUS: done" } };
    await expect(findCommand("result")!.execute([], context)).resolves.toMatchObject({ screen: "result", selectedRunId: "12345678-0000-4000-8000-000000000000" });
    await expect(findCommand("result")!.execute(["abcd1234"], context)).resolves.toMatchObject({ screen: "result", selectedRunId: "abcd1234" });
    await expect(findCommand("result")!.execute([], { application: {} as DtrApplication, cwd: "/project", overrides: {} })).resolves.toMatchObject({ message: expect.stringContaining("No result yet") });
  });

  it("confirms a cleared model override with the remaining session state", async () => {
    const listModels = vi.fn(async () => [{ id: "codex-terra", available: true }]);
    const context = { application: { listModels } as unknown as DtrApplication, cwd: "/project", overrides: { modelId: "codex-terra", provider: "codex" as const } };
    await expect(findCommand("model")!.execute(["auto"], context)).resolves.toMatchObject({ overrides: { modelId: undefined, provider: "codex" }, message: expect.stringContaining("provider:codex") });
    await expect(findCommand("model")!.execute(["codex-terra"], context)).resolves.toMatchObject({ overrides: { modelId: "codex-terra" } });
  });

  it("reports every active run id so a caller can target one of several", async () => {
    const abort = vi.fn(async () => ({ runId: "abcdefgh", accepted: true, state: "aborting" as const }));
    const context = { application: { abort } as unknown as DtrApplication, cwd: "/project", overrides: {}, activeRunId: "abcdefgh", activeRunIds: ["abcdefgh", "12345678"] };
    await expect(findCommand("abort")!.execute([], context)).resolves.toMatchObject({ message: expect.stringContaining("abcdefgh") });
    expect(abort).toHaveBeenCalledWith("abcdefgh");
  });

  it("opens a run from the numbered list by position", async () => {
    const listRuns = vi.fn(async () => [
      { id: "22222222-2222-4222-8222-222222222222", strategy: "single", state: "succeeded" },
      { id: "11111111-1111-4111-8111-111111111111", strategy: "single", state: "succeeded" },
    ]);
    const context = { application: { listRuns } as unknown as DtrApplication, cwd: "/project", overrides: {} };
    await expect(findCommand("pick")!.execute(["1"], context)).resolves.toMatchObject({ screen: "run-detail", selectedRunId: "22222222-2222-4222-8222-222222222222" });
    await expect(findCommand("pick")!.execute(["2"], context)).resolves.toMatchObject({ selectedRunId: "11111111-1111-4111-8111-111111111111" });
    await expect(findCommand("pick")!.execute(["9"], context)).resolves.toMatchObject({ message: expect.stringContaining("No run at position 9") });
    await expect(findCommand("pick")!.execute(["zero"], context)).resolves.toMatchObject({ message: expect.stringContaining("Usage") });
  });
});
