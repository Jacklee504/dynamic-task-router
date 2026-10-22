import type { Effort, ProviderId, WorkerRole } from "@dynamic-task-router/orchestrator";
import type { CommandContext, CommandResult, Overrides } from "../types.js";

export type TuiCommand = { name: string; aliases?: string[]; description: string; usage: string; execute: (args: string[], context: CommandContext) => Promise<CommandResult> };
const efforts = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);
const providers = new Set<ProviderId>(["claude", "codex", "ollama", "openrouter", "featherless", "antigravity", "opencode"]);

function roleFor(task: string): WorkerRole {
  if (/\b(review|audit)\b/i.test(task)) return "reviewer";
  if (/\b(debug|why|fail|error|root cause)\b/i.test(task)) return "debugger";
  if (/\b(log|trace)\b/i.test(task)) return "log-analysis";
  if (/\b(implement|fix|change|add)\b/i.test(task)) return "implementer";
  if (/\b(architecture|design|plan)\b/i.test(task)) return "architect";
  return "researcher";
}
async function submit(task: string, context: CommandContext, mode = context.overrides.mode ?? "auto", files?: string[]): Promise<CommandResult> {
  if (!task.trim()) return { message: "Task text is required." };
  const request = { cwd: context.cwd, prompt: task, role: roleFor(task), provider: context.overrides.provider, modelId: context.overrides.modelId, effort: context.overrides.effort, files };
  if (mode === "fanout" || mode === "pipeline") {
    if (context.attachedRunId) return { message: `Detach with /detach before starting /${mode}.` };
    if (context.overrides.provider || context.overrides.modelId) return { message: `/${mode} cannot use a session-wide provider or model pin. Use /provider auto and /model auto first.` };
    const work = mode === "fanout" ? context.application.fanout(request) : context.application.pipeline({ ...request, template: "debug-review" });
    void work.catch((error: unknown) => context.reportBackgroundError?.(error));
    return { screen: "dashboard", message: `${mode === "fanout" ? "Fan-out" : "Pipeline"} starting. Use /workers, then /runs or /attach <id>.` };
  }
  const run = await context.application.dispatch({ ...request, conversation: context.attachedRunId ? { parentRunId: context.attachedRunId } : {} });
  return { runId: run.runId, attachRunId: run.runId, screen: "dashboard", message: `Run ${run.runId.slice(0, 8)} started. Follow up when it completes, or use /detach for a new conversation.` };
}
function submitCommand(args: string[], context: CommandContext, mode: "single" | "fanout" | "pipeline"): Promise<CommandResult> {
  const separator = args.indexOf("--files");
  if (separator === -1) return submit(args.join(" "), context, mode);
  if (separator === 0 || separator === args.length - 1) return Promise.resolve({ message: `Usage: /${mode === "single" ? "route" : mode} <task> --files path1,path2` });
  const files = args.slice(separator + 1).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  return submit(args.slice(0, separator).join(" "), context, mode, files);
}
function override(context: CommandContext, patch: Overrides): CommandResult { return { overrides: { ...context.overrides, ...patch }, message: "Session routing override updated." }; }
/** Describes the current session overrides so a reset can be confirmed at a glance. */
function describeOverrides(context: CommandContext): string {
  const parts = [`mode:${context.overrides.mode ?? "auto"}`, `provider:${context.overrides.provider ?? "any"}`, `model:${context.overrides.modelId ?? "auto"}`, `effort:${context.overrides.effort ?? "auto"}`];
  return parts.join(" · ");
}

export const commandRegistry: TuiCommand[] = [
  { name: "route", description: "Route one bounded task; name relevant files.", usage: "/route <task> [--files path1,path2]", execute: (args, context) => submitCommand(args, context, "single") },
  { name: "fanout", description: "Run independent read-only analyses.", usage: "/fanout <task> [--files path1,path2]", execute: (args, context) => submitCommand(args, context, "fanout") },
  { name: "pipeline", description: "Run the default read-only review pipeline.", usage: "/pipeline <task> [--files path1,path2]", execute: (args, context) => submitCommand(args, context, "pipeline") },
  { name: "models", aliases: ["m"], description: "Show the configured model registry.", usage: "/models", execute: async () => ({ screen: "models" }) },
  { name: "model", description: "Temporarily select a registry model, or auto.", usage: "/model <id|auto>", execute: async (args, context) => {
    if (!args[0]) return { message: "Usage: /model <id|auto>" };
    if (args[0] === "auto") return { ...override(context, { modelId: undefined }), message: `Model override cleared · ${describeOverrides({ ...context, overrides: { ...context.overrides, modelId: undefined } })}` };
    const models = await context.application.listModels();
    const found = models.find((model) => model.id === args[0]);
    if (!found) return { message: `Unknown model id '${args[0]}'. Use /models to list the registry.` };
    const updated = override(context, { modelId: args[0] });
    return { ...updated, message: found.available ? updated.message : `Session routing override updated; note that ${args[0]} is currently unavailable.` };
  } },
  { name: "providers", description: "Show provider health and capabilities.", usage: "/providers", execute: async () => ({ screen: "providers" }) },
  { name: "provider", description: "Pin a provider for single routes, or auto.", usage: "/provider <provider|auto>", execute: async (args, context) => !args[0] || (args[0] !== "auto" && !providers.has(args[0] as ProviderId)) ? { message: "Usage: /provider <claude|codex|ollama|openrouter|featherless|antigravity|opencode|auto>" } : override(context, { provider: args[0] === "auto" ? undefined : args[0] as ProviderId }) },
  { name: "effort", description: "Temporarily request reasoning effort, or auto.", usage: "/effort <low|medium|high|xhigh|max|auto>", execute: async (args, context) => !args[0] || (args[0] !== "auto" && !efforts.has(args[0] as Effort)) ? { message: "Usage: /effort <low|medium|high|xhigh|max|auto>" } : override(context, { effort: args[0] === "auto" ? undefined : args[0] as Effort }) },
  { name: "mode", description: "Set session strategy, or auto.", usage: "/mode <auto|single|fanout|pipeline>", execute: async (args, context) => !args[0] || !["auto", "single", "fanout", "pipeline"].includes(args[0]) ? { message: "Usage: /mode <auto|single|fanout|pipeline>" } : override(context, { mode: args[0] === "auto" ? undefined : args[0] as Overrides["mode"] }) },
  { name: "usage", description: "Show authoritative usage and unknown quotas.", usage: "/usage", execute: async () => ({ screen: "usage" }) },
  { name: "context", description: "Show known model context data.", usage: "/context", execute: async () => ({ screen: "context" }) },
  { name: "status", description: "Return to the active-run dashboard.", usage: "/status", execute: async () => ({ screen: "dashboard" }) },
  { name: "workers", description: "Return to active routed tasks.", usage: "/workers", execute: async () => ({ screen: "dashboard" }) },
  { name: "runs", aliases: ["r"], description: "Show recent persisted runs.", usage: "/runs", execute: async () => ({ screen: "runs" }) },
  { name: "chats", description: "List recent DTR conversations and their resumable turns.", usage: "/chats", execute: async () => ({ screen: "chats" }) },
  { name: "run", description: "Inspect a saved run by ID or unique prefix.", usage: "/run <id>", execute: async (args) => args[0] ? ({ screen: "run-detail", selectedRunId: args[0] }) : ({ message: "Usage: /run <run-id or prefix>" }) },
  { name: "attach", description: "Resume a completed DTR conversation with compact follow-ups.", usage: "/attach <run-id>", execute: async (args) => args[0] ? ({ screen: "run-detail", selectedRunId: args[0], attachRunId: args[0] }) : ({ message: "Usage: /attach <run-id or prefix>" }) },
  { name: "resume", description: "Continue a run by ID, or the latest completed conversation.", usage: "/resume [run-id]", execute: async (args, context) => { const id = args[0] ?? (await context.application.listRuns(100)).find((run) => run.strategy === "single" && run.state === "succeeded" && run.conversation?.handoff)?.id; return id ? { screen: "run-detail", selectedRunId: id, attachRunId: id } : { message: "No completed DTR conversation to resume. Use /chats or start a new task." }; } },
  { name: "detach", description: "Start a new DTR conversation on the next task.", usage: "/detach", execute: async () => ({ detach: true, screen: "dashboard", message: "Detached. Your next task starts a new DTR conversation." }) },
  { name: "new", description: "Start a fresh conversation, optionally with its first task.", usage: "/new [task] [--files path1,path2]", execute: async (args, context) => { if (!args.length) return { detach: true, screen: "dashboard", overrides: { ...context.overrides, mode: "single" }, message: "New conversation ready. Type a task to begin." }; const result = await submitCommand(args, { ...context, attachedRunId: undefined }, "single"); return result.runId ? { ...result, overrides: { ...context.overrides, mode: "single" } } : result; } },
  { name: "reply", description: "Send an explicit follow-up to the attached conversation.", usage: "/reply <task> [--files path1,path2]", execute: (args, context) => context.attachedRunId ? submitCommand(args, context, "single") : Promise.resolve({ message: "No conversation attached. Use /resume, /attach <id>, or start a new task." }) },
  { name: "history", description: "Show turns in the attached conversation.", usage: "/history", execute: async (_args, context) => { if (!context.attachedRunId) return { message: "No conversation attached. Use /resume or /attach <id>." }; const run = await context.application.getRun(context.attachedRunId); return run?.conversation ? { screen: "history", conversationRootId: run.conversation.rootRunId } : { message: "Attached conversation history is unavailable." }; } },
  { name: "parent", description: "Return to the previous turn to branch from there.", usage: "/parent", execute: async (_args, context) => { if (!context.attachedRunId) return { message: "No conversation attached. Use /resume or /attach <id>." }; const run = await context.application.getRun(context.attachedRunId); const id = run?.conversation?.parentRunId; return id ? { screen: "run-detail", selectedRunId: id, attachRunId: id } : { message: "This is the first turn of the conversation." }; } },
  { name: "result", aliases: ["out"], description: "Show the full result text of the latest run.", usage: "/result [run-id]", execute: async (args, context) => { const id = args[0] ?? context.latestResult?.id; if (!id) return { message: "No result yet in this session. Use /runs to inspect a stored run." }; return { screen: "result", selectedRunId: id }; } },
  { name: "pick", description: "Open a run listed by /runs or /chats by its number.", usage: "/pick N", execute: async (args, context) => {
    const index = Number.parseInt(args[0] ?? "", 10);
    if (!Number.isInteger(index) || index < 1) return { message: "Usage: /pick N, where N is the number shown next to an entry in the run list." };
    const records = await context.application.listRuns(100);
    const target = records.slice(index - 1, index).at(0);
    if (!target) return { message: `No run at position ${index}. Use /runs to see the list.` };
    return { screen: "run-detail", selectedRunId: target.id };
  } },
  { name: "abort", description: "Request cancellation of an active run.", usage: "/abort [run-id]", execute: async (args, context) => { const runId = args[0] ?? context.activeRunId; if (!runId) return { message: "No active DTR run to abort." }; const result = await context.application.abort(runId); return { message: result.accepted ? `Abort requested for ${runId.slice(0, 8)}; awaiting process confirmation.` : "That run is not owned by this TUI session." }; } },
  { name: "health", description: "Refresh local provider health.", usage: "/health", execute: async () => ({ screen: "providers", message: "Provider health refreshed." }) },
  { name: "config", description: "Show read-only effective routing policy.", usage: "/config", execute: async () => ({ screen: "config" }) },
  { name: "clear", description: "Clear the current UI message.", usage: "/clear", execute: async () => ({ clear: true }) },
  { name: "help", aliases: ["?"], description: "Show commands or explain one command.", usage: "/help [command]", execute: async (args) => { if (!args[0]) return { screen: "help" }; const command = findCommand(args[0].replace(/^\//, "")); return { message: command ? `${command.usage}: ${command.description}` : `Unknown command '${args[0]}'. Use /help.` }; } },
  { name: "quit", aliases: ["q"], description: "Exit when no TUI-owned run is active.", usage: "/quit", execute: async (_args, context) => context.activeRunId ? ({ message: `Run ${context.activeRunId.slice(0, 8)} is active. Use /abort before quitting.` }) : ({ message: "__QUIT__" }) },
];

export function findCommand(name: string): TuiCommand | undefined { return commandRegistry.find((command) => command.name === name || command.aliases?.includes(name)); }
export function commandSuggestions(value: string): TuiCommand[] { const prefix = value.replace(/^\//, "").split(/\s/, 1)[0]!.toLowerCase(); return commandRegistry.filter((command) => command.name.startsWith(prefix) || command.aliases?.some((alias) => alias.startsWith(prefix))).slice(0, 5); }
export { roleFor, submit };
