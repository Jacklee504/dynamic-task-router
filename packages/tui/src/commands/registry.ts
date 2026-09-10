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
async function submit(task: string, context: CommandContext, mode = context.overrides.mode ?? "auto"): Promise<CommandResult> {
  if (!task.trim()) return { message: "Task text is required." };
  const request = { cwd: context.cwd, prompt: task, role: roleFor(task), provider: context.overrides.provider, modelId: context.overrides.modelId, effort: context.overrides.effort };
  if (mode === "fanout") { const runs = await context.application.fanout(request); return { runId: runs[0]?.runId, message: `Fan-out started with ${runs.length} routed task(s).` }; }
  if (mode === "pipeline") { const run = await context.application.pipeline({ ...request, template: "debug-review" }); return { runId: run.record.id, message: `Pipeline ${run.record.id.slice(0, 8)} completed.` }; }
  const run = await context.application.run(request); return { runId: run.runId, message: run.result.success ? `Run ${run.runId.slice(0, 8)} completed.` : `Run ${run.runId.slice(0, 8)} failed.` };
}
function override(context: CommandContext, patch: Overrides): CommandResult { return { overrides: { ...context.overrides, ...patch }, message: "Session routing override updated." }; }

export const commandRegistry: TuiCommand[] = [
  { name: "route", description: "Route one bounded task.", usage: "/route <task>", execute: (args, context) => submit(args.join(" "), context, "single") },
  { name: "fanout", description: "Run independent read-only analyses.", usage: "/fanout <task>", execute: (args, context) => submit(args.join(" "), context, "fanout") },
  { name: "pipeline", description: "Run the default safe review pipeline.", usage: "/pipeline <task>", execute: (args, context) => submit(args.join(" "), context, "pipeline") },
  { name: "models", aliases: ["m"], description: "Show the configured model registry.", usage: "/models", execute: async () => ({ screen: "models" }) },
  { name: "model", description: "Temporarily select a registry model, or auto.", usage: "/model <id|auto>", execute: async (args, context) => {
    if (!args[0]) return { message: "Usage: /model <id|auto>" };
    if (args[0] === "auto") return override(context, { modelId: undefined });
    const models = await context.application.listModels();
    const found = models.find((model) => model.id === args[0]);
    if (!found) return { message: `Unknown model id '${args[0]}'. Use /models to list the registry.` };
    return { ...override(context, { modelId: args[0] }), message: found.available ? override(context, { modelId: args[0] }).message : `Session routing override updated; note that ${args[0]} is currently unavailable.` };
  } },
  { name: "providers", description: "Show provider health and capabilities.", usage: "/providers", execute: async () => ({ screen: "providers" }) },
  { name: "provider", description: "Temporarily prefer a provider, or auto.", usage: "/provider <provider|auto>", execute: async (args, context) => !args[0] || (args[0] !== "auto" && !providers.has(args[0] as ProviderId)) ? { message: "Usage: /provider <claude|codex|ollama|openrouter|featherless|antigravity|opencode|auto>" } : override(context, { provider: args[0] === "auto" ? undefined : args[0] as ProviderId }) },
  { name: "effort", description: "Temporarily request reasoning effort, or auto.", usage: "/effort <low|medium|high|xhigh|max|auto>", execute: async (args, context) => !args[0] || (args[0] !== "auto" && !efforts.has(args[0] as Effort)) ? { message: "Usage: /effort <low|medium|high|xhigh|max|auto>" } : override(context, { effort: args[0] === "auto" ? undefined : args[0] as Effort }) },
  { name: "mode", description: "Set session strategy, or auto.", usage: "/mode <auto|single|fanout|pipeline>", execute: async (args, context) => !args[0] || !["auto", "single", "fanout", "pipeline"].includes(args[0]) ? { message: "Usage: /mode <auto|single|fanout|pipeline>" } : override(context, { mode: args[0] === "auto" ? undefined : args[0] as Overrides["mode"] }) },
  { name: "usage", description: "Show authoritative usage and unknown quotas.", usage: "/usage", execute: async () => ({ screen: "usage" }) },
  { name: "context", description: "Show known model context data.", usage: "/context", execute: async () => ({ screen: "context" }) },
  { name: "status", description: "Return to the active-run dashboard.", usage: "/status", execute: async () => ({ screen: "dashboard" }) },
  { name: "workers", description: "Return to active routed tasks.", usage: "/workers", execute: async () => ({ screen: "dashboard" }) },
  { name: "runs", aliases: ["r"], description: "Show recent persisted runs.", usage: "/runs", execute: async () => ({ screen: "runs" }) },
  { name: "run", description: "Open a persisted run by UUID or unambiguous prefix.", usage: "/run <id>", execute: async (args) => args[0] ? ({ screen: "run-detail", selectedRunId: args[0] }) : ({ message: "Usage: /run <run-id or prefix>" }) },
  { name: "abort", description: "Request cancellation of the active run.", usage: "/abort [run-id]", execute: async (args, context) => { const runId = args[0] ?? context.activeRunId; if (!runId) return { message: "No active DTR run to abort." }; const result = await context.application.abort(runId); return { message: result.accepted ? `Abort requested for ${runId.slice(0, 8)}; awaiting process confirmation.` : "That run is not owned by this TUI session." }; } },
  { name: "health", description: "Refresh local provider health.", usage: "/health", execute: async () => ({ screen: "providers", message: "Provider health refreshed." }) },
  { name: "config", description: "Show read-only effective routing policy.", usage: "/config", execute: async () => ({ screen: "config" }) },
  { name: "clear", description: "Clear the current UI message.", usage: "/clear", execute: async () => ({ clear: true }) },
  { name: "help", aliases: ["?"], description: "Show commands and shortcuts.", usage: "/help", execute: async () => ({ screen: "help" }) },
  { name: "quit", aliases: ["q"], description: "Exit the TUI safely.", usage: "/quit", execute: async () => ({ message: "__QUIT__" }) },
];

export function findCommand(name: string): TuiCommand | undefined { return commandRegistry.find((command) => command.name === name || command.aliases?.includes(name)); }
export function commandSuggestions(value: string): TuiCommand[] { const prefix = value.replace(/^\//, "").toLowerCase(); return commandRegistry.filter((command) => command.name.startsWith(prefix) || command.aliases?.some((alias) => alias.startsWith(prefix))).slice(0, 5); }
export { roleFor, submit };
