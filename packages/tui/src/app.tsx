import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { commandRegistry, commandSuggestions, findCommand, submit } from "./commands/registry.js";
import { parseInput } from "./commands/parser.js";
import { Header, Panel, ProviderPanel, RunLine, StatusBar, WorkerList, ContextLine } from "./components.js";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import type { DtrApplication, OllamaRuntime, RunRecord, UsageReport } from "@dynamic-task-router/orchestrator";
import type { ActiveRun, Overrides, ScreenId } from "./types.js";

export function App({ application, cwd }: { application: DtrApplication; cwd: string }) {
  const { exit } = useApp(); const { columns } = useTerminalSize(); const [screen, setScreen] = useState<ScreenId>("dashboard"); const [providers, setProviders] = useState<Awaited<ReturnType<DtrApplication["listProviders"]>>>([]); const [models, setModels] = useState<Awaited<ReturnType<DtrApplication["listModels"]>>>([]); const [ollama, setOllama] = useState<OllamaRuntime>(); const [usage, setUsage] = useState<UsageReport>(); const [runs, setRuns] = useState<RunRecord[]>([]); const [active, setActive] = useState<Record<string, ActiveRun>>({}); const [input, setInput] = useState(""); const [history, setHistory] = useState<string[]>([]); const [historyIndex, setHistoryIndex] = useState<number>(); const [message, setMessage] = useState<string>(); const [overrides, setOverrides] = useState<Overrides>({}); const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const refresh = async () => { const [nextProviders, nextModels, nextRuns, runtime, nextUsage] = await Promise.all([application.listProviders(), application.listModels(), application.listRuns(30), application.ollamaRuntime(), application.usage()]); setProviders(nextProviders); setModels(nextModels); setRuns(nextRuns); setOllama(runtime); setUsage(nextUsage); };
  useEffect(() => { void refresh(); const unsubscribe = application.onEvent((event) => { setActive((previous) => updateActive(previous, event)); if (event.type === "run-completed" || event.type === "run-failed") void refresh(); }); return unsubscribe; }, [application]);
  const submitInput = async (value: string) => { const parsed = parseInput(value); if (parsed.kind === "empty") return; setHistory((items) => [...items.slice(-49), value]); setHistoryIndex(undefined); setInput(""); try { if (parsed.kind === "task") { const result = await submit(parsed.task, { application, cwd, overrides, activeRunId: Object.keys(active)[0] }); setMessage(result.message); if (result.runId) setScreen("dashboard"); return; } const command = findCommand(parsed.name); if (!command) { setMessage(`Unknown command '/${parsed.name}'. Try /help.`); return; } const result = await command.execute(parsed.args, { application, cwd, overrides, activeRunId: Object.keys(active)[0] }); if (result.message === "__QUIT__") { exit(); return; } if (result.overrides) setOverrides(result.overrides); if (result.clear) setMessage(undefined); else if (result.message) setMessage(result.message); if (result.selectedRunId) { setSelectedRun(await application.getRun(result.selectedRunId)); setScreen("run-detail"); } else if (result.screen) { if (result.screen === "runs") setRuns(await application.listRuns(30)); if (result.screen === "providers" || result.screen === "models" || result.screen === "usage") await refresh(); setScreen(result.screen); } } catch (error) { setMessage(safeUiError(error)); } };
  useInput((character, key) => {
    if (key.ctrl && character === "c") { if (Object.keys(active)[0]) void application.abort(Object.keys(active)[0]!); else exit(); return; }
    if (key.ctrl && character === "k") { setScreen("dashboard"); return; }
    if (key.ctrl && character === "r") { setScreen("runs"); return; }
    if (key.ctrl && character === "o") { setScreen("models"); return; }
    if (key.escape) { if (screen === "run-detail") setScreen("runs"); else setScreen("dashboard"); return; }
    if (key.return) { void submitInput(input); return; }
    if (key.upArrow && history.length) { const index = Math.max(0, (historyIndex ?? history.length) - 1); setHistoryIndex(index); setInput(history[index] ?? ""); return; }
    if (key.downArrow && history.length) { const index = Math.min(history.length, (historyIndex ?? history.length) + 1); setHistoryIndex(index); setInput(index === history.length ? "" : history[index] ?? ""); return; }
    if (key.backspace || key.delete) { setInput((value) => value.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && !key.tab && character) setInput((value) => value + character);
  });
  const suggestions = useMemo(() => input.startsWith("/") ? commandSuggestions(input) : [], [input]); const activeRuns = Object.values(active); const wide = columns >= 120;
  const screenContent = screen === "dashboard" ? <><Box width={wide ? "40%" : undefined}><ProviderPanel providers={providers} ollama={ollama}/></Box><Box width={wide ? "60%" : undefined}><WorkerList runs={activeRuns}/></Box></>
    : screen === "runs" ? <RunsScreen runs={runs}/>
      : screen === "run-detail" ? <RunDetail run={selectedRun}/>
        : screen === "models" ? <ModelsScreen models={models}/>
          : screen === "providers" ? <ProviderPanel providers={providers} ollama={ollama}/>
            : screen === "config" ? <ConfigScreen models={models}/>
              : screen === "help" ? <HelpScreen/>
                : screen === "usage" ? <UsageScreen usage={usage}/>
                  : <ContextScreen models={models}/>;
  return <Box flexDirection="column"><Header cwd={cwd} overrides={overrides}/><Box flexDirection={wide ? "row" : "column"}>{screenContent}</Box>{suggestions.length > 0 && <Panel title="COMMANDS">{suggestions.map((command) => <Text key={command.name}>{command.usage} · {command.description}</Text>)}</Panel>}<CommandInput value={input}/><StatusBar message={message}/></Box>;
}
function CommandInput({ value }: { value: string }) { return <Box borderStyle="single" paddingX={1}><Text>{`> ${value}▋`}</Text></Box>; }
function RunsScreen({ runs }: { runs: RunRecord[] }) { return <Panel title="RECENT RUNS">{runs.length ? runs.map((run) => <RunLine key={run.id} {...run}/>) : <Text>No persisted status records.</Text>}</Panel>; }
function RunDetail({ run }: { run: RunRecord | null }) { return <Panel title="RUN DETAIL">{run ? <><Text>{run.id}</Text><Text>strategy: {run.strategy} · state: {run.state}</Text>{run.stages.map((stage) => <Text key={stage.id}>{stage.state === "succeeded" ? "✓" : "○"} {stage.id} · {stage.model ?? "unassigned"}</Text>)}<Text>outcome: {run.outcome?.status ?? "unreviewed"}</Text>{run.error && <Text>error: {safeUiError(run.error)}</Text>}</> : <Text>Run not found in this repository.</Text>}</Panel>; }
function ModelsScreen({ models }: { models: Awaited<ReturnType<DtrApplication["listModels"]>> }) { return <Panel title="MODEL REGISTRY">{models.map((model) => <Text key={model.id}>{model.available ? "●" : model.enabled ? "×" : "○"} {model.id} · {model.provider}/{model.family} · {model.local ? "local" : "remote"} · ctx {model.limits.contextTokens} · private:{model.privacy.privateCodeAllowed ? "allowed" : "no"}</Text>)}</Panel>; }
function ConfigScreen({ models }: { models: Awaited<ReturnType<DtrApplication["listModels"]>> }) { return <Panel title="READ-ONLY CONFIG"><Text>enabled models: {models.filter((model) => model.enabled).length}</Text><Text>Configuration remains file-managed; session overrides are not persisted.</Text></Panel>; }
function HelpScreen() { return <Panel title="COMMANDS">{commandRegistry.map((command) => <Text key={command.name}>{command.usage} · {command.description}</Text>)}<Text>Keyboard: Ctrl+K dashboard · Ctrl+R runs · Ctrl+O models · Esc back · Ctrl+C abort active/exit.</Text></Panel>; }
function UsageScreen({ usage }: { usage: UsageReport | undefined }) { return <Panel title="USAGE">{!usage ? <Text>Loading DTR execution telemetry…</Text> : usage.providers.map((provider) => <Box key={provider.provider} flexDirection="column"><Text>{provider.provider} · {provider.executions} run(s) · {provider.succeeded} succeeded · {provider.failed} failed · {Math.round(provider.durationMs / 1000)}s</Text><Text>  tokens: {provider.tokens.totalTokens ?? "unknown"} total · {provider.tokens.inputTokens ?? "unknown"} input · {provider.tokens.outputTokens ?? "unknown"} output · reported {provider.tokens.reportingExecutions}/{provider.executions}</Text>{provider.tokens.costUsd !== undefined && <Text>  reported cost: ${provider.tokens.costUsd.toFixed(4)}</Text>}<Text>  account quota: {provider.accountQuota.status} · {provider.accountQuota.detail}</Text></Box>)}</Panel>; }
function ContextScreen({ models }: { models: Awaited<ReturnType<DtrApplication["listModels"]>> }) { return <Panel title="CONTEXT">{models.map((model) => <ContextLine key={model.id} model={model.id} contextTokens={model.limits.contextTokens}/>)}</Panel>; }
function updateActive(previous: Record<string, ActiveRun>, event: import("@dynamic-task-router/orchestrator").DtrEvent): Record<string, ActiveRun> {
  if (event.type === "run-created") return { ...previous, [event.runId]: { id: event.runId, task: event.task, state: "queued", startedAt: event.timestamp } };
  const current = previous[event.runId]; if (!current) return previous;
  if (event.type === "route-selected") return { ...previous, [event.runId]: { ...current, state: "routing", model: event.model, provider: event.provider, effort: event.effort } };
  if (event.type === "worker-started") return { ...previous, [event.runId]: { ...current, state: "running", model: event.model, provider: event.provider, effort: event.effort } };
  if (event.type === "worker-completed") return { ...previous, [event.runId]: { ...current, state: "succeeded", latest: event.result.success ? "completed" : "failed" } };
  if (event.type === "run-completed") return { ...previous, [event.runId]: { ...current, state: event.outcome === "aborted" ? "aborted" : "succeeded", latest: event.outcome } };
  if (event.type === "run-aborting") return { ...previous, [event.runId]: { ...current, state: "aborting" } };
  if (event.type === "run-failed") return { ...previous, [event.runId]: { ...current, state: "failed", latest: safeUiError(event.error) } };
  return previous;
}
function safeUiError(error: unknown): string { return String(error instanceof Error ? error.message : error).replace(/(?:ANTHROPIC|OPENAI|OPENROUTER)_API_KEY\s*=\s*\S+/gi, "[redacted]").replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: [redacted]").slice(0, 300); }
