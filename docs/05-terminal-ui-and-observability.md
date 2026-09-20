# Phase 5 — Terminal UI, Interactive Commands, Usage/Context Visibility, and Run Observability

## Objective

Add a first-class terminal user interface (TUI) on top of the completed Dynamic Task Router.

At the end of this phase, a user should be able to run:

```bash
dtr
```

and use DTR as a practical daily interface for multi-model engineering work without opening separate Claude Code, Codex, OpenCode, or Ollama chat applications.

The TUI must provide:

- a full-screen interactive terminal dashboard
- normal task input and slash commands
- provider/model/effort visibility
- automatic and manual routing controls
- active worker/run status
- run history and detailed run inspection
- per-run token/context telemetry where providers expose it
- subscription/quota visibility only when it can be obtained authoritatively
- local Ollama runtime/memory visibility
- provider health/authentication status without exposing secrets
- model selection and temporary routing overrides
- abort/cancel controls
- keyboard navigation
- graceful non-interactive fallback
- zero direct provider calls from UI components

The TUI is a presentation/control layer only.

All execution, routing, policy, privacy, cost, safety, telemetry, worktree, and provider behavior must remain owned by the Phase 1–4 orchestrator.

---

## Required prerequisite

Phases 1–4 must be complete and passing before starting this phase.

Do not begin Phase 5 by rewriting routing/provider logic.

Before making changes, inspect the final interfaces produced by Phases 1–4 and adapt this specification to them while preserving the architectural requirements below.

Run and record the existing test suite before editing.

---

# Architecture rule

The most important invariant for Phase 5 is:

```text
TUI
  ↓
DTR application/service API
  ↓
Orchestrator
  ↓
Routing / strategies / telemetry / providers
```

Never implement:

```text
TUI → Claude CLI
TUI → Codex CLI
TUI → Ollama API
TUI → OpenRouter API
```

UI components must not know how providers are invoked.

The same routing engine must power all front ends:

```text
                    ┌── TUI: dtr
                    │
DTR orchestrator ───┼── CLI: dtr run ...
                    │
                    └── MCP: dtr-mcp
```

A task routed from the TUI must behave the same way as an equivalent task routed through the CLI or MCP.

---

# Package structure

Create a dedicated workspace package:

```text
packages/
├── orchestrator/
│   └── existing Phase 1–4 implementation
│
└── tui/
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.tsx
    │   ├── app.tsx
    │   │
    │   ├── screens/
    │   │   ├── dashboard.tsx
    │   │   ├── run-detail.tsx
    │   │   ├── runs.tsx
    │   │   ├── models.tsx
    │   │   ├── providers.tsx
    │   │   ├── config.tsx
    │   │   └── help.tsx
    │   │
    │   ├── components/
    │   │   ├── Header.tsx
    │   │   ├── ProviderPanel.tsx
    │   │   ├── ProviderRow.tsx
    │   │   ├── WorkerList.tsx
    │   │   ├── WorkerRow.tsx
    │   │   ├── RunLog.tsx
    │   │   ├── RunSummary.tsx
    │   │   ├── ContextBar.tsx
    │   │   ├── UsageBar.tsx
    │   │   ├── CommandBar.tsx
    │   │   ├── CommandSuggestions.tsx
    │   │   ├── StatusBar.tsx
    │   │   ├── ErrorBanner.tsx
    │   │   └── Modal.tsx
    │   │
    │   ├── commands/
    │   │   ├── registry.ts
    │   │   ├── parser.ts
    │   │   ├── route.ts
    │   │   ├── fanout.ts
    │   │   ├── pipeline.ts
    │   │   ├── models.ts
    │   │   ├── model.ts
    │   │   ├── providers.ts
    │   │   ├── provider.ts
    │   │   ├── effort.ts
    │   │   ├── mode.ts
    │   │   ├── usage.ts
    │   │   ├── context.ts
    │   │   ├── runs.ts
    │   │   ├── run.ts
    │   │   ├── workers.ts
    │   │   ├── status.ts
    │   │   ├── abort.ts
    │   │   ├── health.ts
    │   │   ├── config.ts
    │   │   ├── clear.ts
    │   │   ├── help.ts
    │   │   └── quit.ts
    │   │
    │   ├── state/
    │   │   ├── store.ts
    │   │   ├── reducer.ts
    │   │   ├── actions.ts
    │   │   └── selectors.ts
    │   │
    │   ├── hooks/
    │   │   ├── useDtr.ts
    │   │   ├── useKeyboard.ts
    │   │   ├── useTerminalSize.ts
    │   │   └── useCommandHistory.ts
    │   │
    │   ├── telemetry/
    │   │   ├── types.ts
    │   │   ├── service.ts
    │   │   ├── quota.ts
    │   │   └── ollama-runtime.ts
    │   │
    │   ├── terminal/
    │   │   ├── alternate-screen.ts
    │   │   ├── cleanup.ts
    │   │   └── tty.ts
    │   │
    │   └── format/
    │       ├── tokens.ts
    │       ├── duration.ts
    │       ├── memory.ts
    │       └── status.ts
    │
    └── tests/
        ├── app.test.tsx
        ├── commands.test.ts
        ├── dashboard.test.tsx
        ├── run-detail.test.tsx
        ├── telemetry.test.ts
        └── fixtures/
```

Adjust names where needed to match the actual Phase 1–4 APIs, but preserve the separation between UI, commands, state, telemetry/introspection, and the orchestrator.

---

# TUI framework

Use:

```text
Ink + React + TypeScript
```

Use current stable compatible package versions at implementation time.

Prefer a small dependency surface.

Expected dependencies will likely include:

```text
ink
react
ink-text-input
```

Testing may use an Ink-compatible testing library if it is current and maintained at implementation time.

Do not introduce a browser/Electron runtime.

Do not build the TUI with raw readline loops unless Ink proves incompatible with a required feature.

---

# Root command behavior

After Phase 5, command behavior should be:

```bash
dtr
```

If stdin/stdout are interactive TTYs:

```text
launch TUI
```

Explicit:

```bash
dtr tui
```

must also launch it.

Existing non-interactive commands must continue to work:

```bash
dtr run "inspect this repository"
dtr fanout "find the root cause"
dtr models
dtr health
dtr stats
dtr evaluate
```

When not attached to an interactive terminal, bare `dtr` must not hang trying to launch Ink.

Safe behavior:

```text
dtr
```

in non-TTY mode should print concise help and exit non-zero or require an explicit subcommand.

Do not break scripts, MCP, CI, or existing CLI usage.

---

# Package wiring

Add the TUI package to the root workspace configuration.

Prefer the final published/linked executable to continue being:

```text
dtr
```

rather than creating a completely separate product name.

The root CLI may dispatch into the TUI package when no subcommand is supplied.

Do not duplicate command implementations between the orchestrator CLI and TUI.

Shared operations should be exposed through an internal application/service API.

---

# Introduce a DTR application API

If Phases 1–4 currently expose functionality only through CLI handlers, extract a reusable application layer.

Create or formalize something conceptually equivalent to:

```ts
export interface DtrApplication {
  health(): Promise<HealthSnapshot>;
  listModels(): Promise<ModelView[]>;
  listProviders(): Promise<ProviderView[]>;

  select(input: SelectionRequest): Promise<SelectionResult>;

  run(input: RunRequest): Promise<RunResult>;
  fanout(input: FanoutRequest): Promise<RunResult>;
  pipeline(input: PipelineRequest): Promise<RunResult>;

  abort(runId: string): Promise<AbortResult>;

  listRuns(options?: ListRunsOptions): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunRecord | null>;

  stats(): Promise<StatsSnapshot>;
}
```

Names may differ.

The requirement is that:

```text
CLI handlers
TUI command handlers
MCP tools
```

all delegate to the same application/orchestrator methods rather than reimplementing behavior.

---

# Event/lifecycle API

The TUI needs live run state without polling the run-history directory aggressively.

Add an orchestrator lifecycle event stream if one does not already exist.

Use a typed event model such as:

```ts
export type DtrEvent =
  | {
      type: "run-created";
      runId: string;
      task: string;
      timestamp: string;
    }
  | {
      type: "route-selected";
      runId: string;
      selection: SelectionSummary;
    }
  | {
      type: "worker-started";
      runId: string;
      workerId: string;
      provider: string;
      model: string;
      role: string;
      effort: string;
      timestamp: string;
    }
  | {
      type: "worker-metrics";
      runId: string;
      workerId: string;
      metrics: WorkerMetrics;
    }
  | {
      type: "worker-completed";
      runId: string;
      workerId: string;
      result: WorkerResultSummary;
    }
  | {
      type: "worker-failed";
      runId: string;
      workerId: string;
      error: SafeErrorSummary;
    }
  | {
      type: "run-aborting";
      runId: string;
    }
  | {
      type: "run-completed";
      runId: string;
      outcome: string;
    }
  | {
      type: "run-failed";
      runId: string;
      error: SafeErrorSummary;
    };
```

Use Node `EventEmitter`, `EventTarget`, an async iterator, or an equivalent typed internal mechanism.

Do not make the event bus a network service.

Events are for local process/UI observability.

Persisted run telemetry remains the source of historical truth.

---

# Do not require provider streaming

The first TUI release must not require every provider to support token-by-token streaming.

Minimum live state:

```text
queued
routing
running
completed
failed
aborting
aborted
```

Provider adapters may expose richer metrics when available.

If Claude/Codex structured streaming is already available and stable after Phases 1–4, it may be surfaced, but do not make the architecture dependent on identical stream formats across providers.

Normalize provider-specific information before it reaches UI components.

---

# Normalized UI telemetry

Create a provider-neutral metrics type.

Example:

```ts
export interface WorkerMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;

  contextUsedTokens?: number;
  contextWindowTokens?: number;

  estimatedCostUsd?: number;

  durationMs?: number;

  authoritative: {
    tokens: boolean;
    context: boolean;
    cost: boolean;
  };
}
```

Never infer exact values and present them as authoritative.

If a provider gives only token usage but not current context occupancy, display the token usage and mark context as unavailable.

---

# Context visibility

The UI should show context where DTR can actually support it.

Example:

```text
Claude Opus
Context  ████████░░░░░░░░  48%
96K / 200K
```

But only show a percentage if both are known:

```text
contextUsedTokens
contextWindowTokens
```

If only the model context window is known:

```text
Context: window 200K · current usage unknown
```

If neither is known:

```text
Context: unavailable
```

Never calculate a false "remaining context" from unrelated subscription usage.

---

# Subscription/account usage

Implement this conservatively.

The TUI may show provider account/quota information only through a normalized introspection layer.

Create something conceptually equivalent to:

```ts
export interface QuotaSnapshot {
  provider: string;

  used?: number;
  remaining?: number;
  limit?: number;

  unit?: "requests" | "tokens" | "percent" | "credits" | "unknown";

  resetsAt?: string;

  authoritative: boolean;
  source?: string;

  unavailableReason?: string;
}
```

Do not treat account quotas as part of the core `Provider.run()` interface.

Use a separate optional introspection service so provider execution remains simple.

Example:

```ts
export interface ProviderIntrospection {
  provider: string;

  getQuota?(): Promise<QuotaSnapshot>;
  getRuntime?(): Promise<RuntimeSnapshot>;
}
```

Provider support may vary.

---

# Critical quota rule

Do not scrape Claude/ChatGPT account webpages.

Do not reverse engineer private endpoints.

Do not estimate "remaining subscription usage" from observed run tokens and present it as real quota.

If Claude Code or Codex exposes a stable documented machine-readable quota source during implementation, support it behind the introspection interface.

Otherwise display:

```text
Claude
Subscription usage: unavailable

Codex
Subscription usage: unavailable
```

This is correct behavior.

The TUI can still display:

```text
current run tokens
context
run count
duration
historical DTR usage
```

without claiming to know subscription limits.

---

# OpenRouter usage

If Phase 4 OpenRouter is configured, quota/cost information is more appropriate because it is API-credit based.

Show when available:

```text
OpenRouter
credits / budget
estimated current run cost
configured DTR task cap
```

Never display API keys.

Respect Phase 4 cost-policy settings.

Do not allow the TUI to silently increase a configured cost cap.

---

# Ollama runtime telemetry

Ollama should receive richer local-runtime UI because it is controlled locally.

Create:

```text
packages/tui/src/telemetry/ollama-runtime.ts
```

Use a documented local Ollama runtime endpoint/command available at implementation time.

Collect only safe runtime metadata, for example when available:

```text
server reachable
loaded models
model name
model size
VRAM/unified-memory-related runtime size
expiry/unload time
configured context
```

Do not claim this is total macOS RAM usage unless the source actually provides that number.

Label accurately.

For example:

```text
Qwen 3.5 9B
loaded: yes
runtime model size: 7.1 GB
context: 12K / 32K
```

is preferable to:

```text
RAM: 7.1 GB
```

if the source does not represent total resident memory.

---

# Optional local model controls

Support read-only runtime visibility in the initial implementation.

Commands such as:

```text
/local
/local status
```

may be included.

Do not make model load/unload management a Phase 5 acceptance requirement unless it is trivial and uses documented Ollama controls.

If implemented later, require explicit user action for:

```text
/local load <model>
/local unload <model>
```

Never automatically unload an active model belonging to another process.

---

# Main dashboard

Target a layout conceptually similar to:

```text
┌─ Dynamic Task Router ───────────────────────────────────────────────┐
│ repo: trading-system   branch: dev   mode: AUTO   privacy: private │
├───────────────────────┬────────────────────────────────────────────┤
│ PROVIDERS             │ ACTIVE RUN                                 │
│                       │                                            │
│ ● Claude              │ #38 Investigate why orders aren't firing  │
│   Opus                │                                            │
│   ctx  96K/200K       │ Route: pipeline · risk: high              │
│   quota unavailable   │                                            │
│                       │ ✓ Claude/Opus  architect                   │
│ ● Codex               │ ● Codex/Sol    debugger                   │
│   Sol                 │ ✓ Qwen 9B      log-analysis               │
│   ctx  61K/272K       │ ○ Terra         final-review              │
│   quota unavailable   │                                            │
│                       │ Latest: state-sync issue identified         │
│ ● Ollama              │                                            │
│   qwen3.5:9b          │                                            │
│   loaded              │                                            │
│   local               │                                            │
├───────────────────────┴────────────────────────────────────────────┤
│ /route /fanout /pipeline /models /usage /context /runs /help      │
│ > _                                                               │
└────────────────────────────────────────────────────────────────────┘
```

Do not hard-code this exact width.

The application must degrade cleanly on smaller terminals.

---

# Responsive terminal behavior

Implement at least three layout tiers.

## Wide

Example:

```text
>= 120 columns
```

Use side-by-side provider and run panels.

## Medium

Example:

```text
80–119 columns
```

Reduce metadata and use narrower columns.

## Narrow

Example:

```text
< 80 columns
```

Stack:

```text
header
active run
providers
command bar
```

Do not truncate command input.

Use ellipsis for long task/model names where necessary.

Never crash because terminal dimensions change.

---

# Terminal resize handling

Listen for terminal resize and update layout immediately.

The TUI must survive:

```text
large terminal
→ narrow split pane
→ large terminal
```

without restarting or losing command input.

---

# Alternate screen

Prefer a proper full-screen terminal experience.

Implement a small guarded alternate-screen helper if compatible with Ink.

Only activate when:

```text
stdout.isTTY === true
```

Ensure terminal restoration occurs on:

```text
normal quit
Ctrl+C
SIGINT
SIGTERM
uncaught exception
render failure
```

Do not leave the user's terminal in alternate-screen/raw-input mode after a crash.

If alternate-screen behavior creates compatibility problems, fall back safely to normal Ink rendering rather than blocking Phase 5.

---

# Command bar

The bottom command bar must accept two categories of input:

## Normal task

Example:

```text
> Investigate why the trading engine is not submitting orders
```

Default behavior:

```text
use configured AUTO routing mode
```

Equivalent to a normal routed task.

Do not require `/route` for ordinary use.

## Slash command

Example:

```text
> /fanout Why does this reconnect test intermittently fail?
```

Commands must be parsed locally and deterministically.

Do not ask an LLM to interpret slash command syntax.

---

# Slash command registry

Create a typed registry.

Conceptually:

```ts
export interface TuiCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;

  execute(
    args: string[],
    context: CommandContext
  ): Promise<CommandResult>;
}
```

The command palette/help UI should derive from this registry.

Do not maintain a separate manually duplicated help list.

---

# Required slash commands

Implement at minimum:

```text
/route <task>
/fanout <task>
/pipeline <task>

/models
/model <model-or-registry-id>

/providers
/provider <provider>

/effort <low|medium|high|xhigh|max>
/mode <auto|single|fanout|pipeline>

/usage
/context

/status
/workers

/runs
/run <id>

/abort [run-id]

/health
/config
/clear
/help
/quit
```

Aliases may include:

```text
/q        /quit
/m        /models
/r        /runs
```

Avoid too many ambiguous aliases.

---

# Temporary overrides

Commands such as:

```text
/model ...
/provider ...
/effort ...
/mode ...
```

must modify TUI-session routing overrides by default, not silently rewrite global configuration files.

Display active overrides in the header/status bar.

Example:

```text
mode:AUTO · provider:any · model:auto · effort:auto
```

After:

```text
/provider codex
/effort high
```

show:

```text
mode:AUTO · provider:codex · model:auto · effort:high
```

Provide a deterministic reset:

```text
/provider auto
/model auto
/effort auto
/mode auto
```

or:

```text
/reset
```

if added.

Do not silently persist overrides across future shells unless the user explicitly changes configuration through `/config`.

---

# Direct-provider convenience commands

Optionally support:

```text
/claude <task>
/codex <task>
/local <task>
```

These are convenience aliases for temporary explicit routing.

They must still pass through the orchestrator and normal policy validation.

Example:

```text
/codex review this diff
```

must not bypass:

```text
privacy rules
read-only requirements
budget rules
worktree policy
telemetry
```

If an explicit provider conflicts with a hard safety/privacy rule, reject it with an explanation.

---

# Command suggestions

When the command bar starts with `/`, show matching commands.

Example:

```text
/f
  /fanout <task>     Send independent copies to multiple model families
```

Support keyboard selection where practical.

At minimum:

```text
Up/Down
Tab or Enter
Esc
```

Do not let autocomplete execute a destructive command by itself.

---

# Command history

Maintain in-memory command/task history for the current TUI session.

Support:

```text
Up
Down
```

when the command bar is focused.

Do not persist raw prompt history globally by default because tasks may contain sensitive repository information.

If persistent history is added later, it must be opt-in.

---

# Keyboard controls

Implement predictable keyboard behavior.

Recommended baseline:

```text
Tab          next focusable panel
Shift+Tab    previous panel

Up/Down      move selection / command history depending on focus
Enter        open selected run/worker or submit input
Esc          close modal / return to previous screen

Ctrl+K       focus command bar / command palette
Ctrl+R       open runs screen
Ctrl+M       open models screen
Ctrl+P       open providers screen

Ctrl+C       first press aborts active foreground interaction or asks for quit
             second press exits safely if appropriate
```

Do not overload common terminal shortcuts unnecessarily.

All shortcuts must be documented in `/help`.

---

# Screen model

Use explicit screens/navigation state rather than rendering every panel at once.

Required screens:

```text
dashboard
runs
run-detail
models
providers
config
help
```

The dashboard is the default.

Use a simple navigation stack:

```text
dashboard
→ runs
→ run-detail
→ Esc
→ runs
→ Esc
→ dashboard
```

Do not bring in a web-style routing framework.

---

# Dashboard provider panel

Each configured provider should show:

```text
health
enabled/disabled
currently selected/default model where applicable
active worker count
last failure if recent and safe
quota if authoritative
local runtime details where relevant
```

Examples:

```text
● Claude
  Opus
  healthy
  quota: unavailable

● Codex
  Sol
  healthy
  quota: unavailable

● Ollama
  qwen3.5:9b
  loaded
  local

○ OpenRouter
  disabled
```

Use consistent status semantics:

```text
● healthy/available
◐ degraded/unknown
○ disabled
× unavailable/error
```

Do not rely on color alone.

---

# Active run panel

Show:

```text
run ID
task summary
strategy
risk
privacy classification
current stage
elapsed duration
worker roster
latest completed result summary
```

Worker states:

```text
○ queued
◐ running
✓ completed
× failed
! blocked
↯ aborted
```

Again, do not rely only on color.

---

# Worker details

A worker row should be able to display:

```text
role
provider
model
model family
reasoning effort
read-only/write mode
worktree if any
duration
token/context metrics where known
outcome
```

Do not display full prompts by default.

A detail view may show the bounded worker contract when requested.

Never display secrets or raw environment values.

---

# Run history

`/runs` should open a screen backed by the existing `.dtr/runs` telemetry.

Example:

```text
ID    Task                           Strategy   Models             Result
38    Order execution bug            pipeline   Opus/Sol/Qwen      PASS
37    Signal-filter refactor          single     Luna               PASS
36    Analyse paper-trading logs      single     Qwen               PASS
35    Websocket reconnect failure     fanout     Sol/Opus           FAIL
```

Support:

```text
Up/Down
Enter
Esc
```

Optional filters:

```text
/runs failed
/runs today
/runs provider=codex
```

Do not require filters for Phase 5 completion unless the underlying telemetry makes them trivial.

---

# Run detail

`/run <id>` or Enter from the run list should display:

```text
RUN #38
────────────────────────────────────

Task
Investigate why orders aren't firing

Routing
strategy: pipeline
complexity: difficult
risk: financial/high
diversity: high

Workers
✓ Claude / Opus / high
  architect
  duration 2m14s
  tokens 84K
  context 96K/200K

✓ Qwen / qwen3.5:9b / medium
  log-analysis
  duration 41s

✓ Codex / Sol / high
  debugger
  duration 3m02s

✓ Codex / Terra / high
  reviewer
  duration 1m33s

Outcome
accepted

Checks
27 passed
0 failed
```

Use actual Phase 1–4 telemetry fields.

If an item is unknown, omit it or label it unavailable.

Do not fabricate test counts, review results, context, or cost.

---

# Context command

`/context` should show a normalized view.

Example:

```text
ACTIVE CONTEXT

Claude / Opus
96K / 200K
48%
authoritative: yes

Codex / Sol
61K / 272K
22%
authoritative: yes

Qwen / qwen3.5:9b
configured window: 32K
current occupancy: unavailable
```

The exact context windows come from the current model registry or provider result metadata.

Do not hard-code context windows in TUI components.

---

# Usage command

`/usage` should combine three clearly distinguished categories.

Example:

```text
USAGE

Provider quota
Claude       unavailable
Codex        unavailable
OpenRouter   $8.42 remaining      authoritative

Current run
input tokens       132K
output tokens       18K
estimated API cost $0.04

DTR history
runs today          9
Claude workers      4
Codex workers       6
local workers       11
```

Never combine these into one misleading percentage.

Clearly distinguish:

```text
provider/account quota
current-run consumption
historical DTR activity
```

---

# Models screen

`/models` should show the Phase 1–4 model registry, not a second registry.

Fields:

```text
registry ID
provider
model ID
family
enabled
local/remote
role strengths
supported effort levels
context limit if known
privacy eligibility
cost metadata if available
health/availability
```

Example compact view:

```text
MODEL               PROVIDER     FAMILY        LOCAL   STATUS
claude-opus         claude       anthropic     no      ready
codex-sol           codex        openai        no      ready
codex-terra         codex        openai        no      ready
qwen-local          ollama       qwen          yes     loaded
gpt-oss-local       ollama       openai-open   yes     available
nemotron-free       openrouter   nvidia        no      ready
```

Allow selecting a row and opening details.

---

# Provider screen

`/providers` should show provider capabilities and health.

Example:

```text
Claude
execution       yes
write workers   configured
quota           unavailable
reasoning       low..max
status          healthy

Codex
execution       yes
write workers   configured
quota           unavailable
reasoning       configured levels
status          healthy

Ollama
execution       yes
local           yes
runtime info    yes
status          healthy
```

This should derive from provider/capability metadata.

Do not encode provider assumptions directly in the React component.

---

# Config screen

`/config` initially provides a safe read-only view of:

```text
effective repo config
global config
routing policy
privacy policy
budget mode
enabled providers
default strategy
default model/effort behavior
```

Do not expose secrets.

If Phase 5 adds config editing, restrict it to safe settings and require explicit confirmation before writing.

A read-only config screen is sufficient for Phase 5 completion.

---

# Health screen/command

`/health` should run the same checks as the existing CLI health command.

Show concurrently where practical:

```text
Claude CLI/auth
Codex CLI/auth
Ollama server
OpenRouter key/API if enabled
model registry
telemetry directory
worktree directory
```

Use timeout-bounded checks.

Do not freeze the TUI waiting indefinitely for a provider.

---

# Error handling

Errors should appear in the TUI without destroying the session.

Use:

```text
ErrorBanner
modal
run failure state
```

depending on severity.

Examples:

```text
Codex authentication expired
Ollama unavailable at localhost
model not found
OpenRouter rate limited
invalid slash command
run not found
worktree creation failed
```

The TUI must never render raw exception objects containing:

```text
environment variables
authorization headers
API keys
full secret-bearing command lines
```

Use Phase 4 redaction utilities.

---

# Safe command errors

Invalid commands should produce concise help.

Example:

```text
> /effort huge

Invalid effort "huge".
Allowed: auto, low, medium, high, xhigh, max
```

Do not invoke a model to correct command syntax.

Unknown command:

```text
Unknown command "/fnaout".
Did you mean "/fanout"?
```

A simple deterministic edit-distance suggestion is acceptable.

---

# Abort behavior

`/abort` must call the Phase 1–4 cancellation/abort mechanism.

If multiple runs are active:

```text
/abort
```

should target the foreground/current run or present a run choice.

Explicit:

```text
/abort 38
```

targets run 38.

Display lifecycle honestly:

```text
aborting
aborted
could not stop child process
```

Never immediately label a run `aborted` before the orchestrator confirms it.

---

# Concurrency

The TUI may show multiple active runs if the orchestrator supports them.

Do not introduce new concurrency semantics merely for the UI.

If Phase 1–4 intentionally permits only one foreground run, preserve that.

The UI should reflect actual runtime capability.

---

# Interaction while a run is active

Do not lock the entire UI during execution.

Users should still be able to:

```text
inspect providers
inspect models
view usage/context
view previous runs
open help
abort
```

Whether a second run may be started depends on existing orchestrator concurrency policy.

---

# Focus model

Implement explicit focus state for:

```text
navigation/sidebar
main content
command bar
modal
```

Typing normal text should only affect the command bar when it has focus.

Keystrokes intended for list navigation must not accidentally modify the prompt.

---

# Rendering performance

Avoid rerendering the full history log for every minor event.

Keep:

```text
active run state
provider state
UI state
historical run list
```

separate where practical.

Limit in-memory visible log lines.

Historical detail should be read from persisted telemetry on demand.

Do not load every historical run file at startup.

---

# Startup sequence

Recommended startup:

```text
1. verify TTY
2. initialize terminal cleanup handlers
3. load effective DTR config
4. construct DtrApplication
5. render shell immediately
6. perform provider health/introspection concurrently
7. read latest small batch of run history
8. subscribe to DTR lifecycle events
```

Do not make the user stare at a blank terminal while all providers are health-checked.

Display:

```text
Claude      checking...
Codex       checking...
Ollama      checking...
```

and update asynchronously.

---

# Shutdown sequence

On `/quit` or clean Ctrl+C:

```text
1. determine whether foreground runs are active
2. do not silently kill them unless existing DTR policy says they are process-owned
3. if needed, show concise confirmation/options
4. unsubscribe event listeners
5. flush safe UI state if any
6. restore terminal screen/input mode
7. exit
```

Do not leave orphaned processes unintentionally.

Do not auto-abort unrelated background runs merely because the TUI closes.

---

# TUI state

Keep UI-specific state in memory.

Example:

```ts
interface TuiState {
  screen: ScreenId;
  selectedRunId?: string;
  selectedProvider?: string;
  selectedModel?: string;

  commandInput: string;
  commandHistory: string[];

  overrides: {
    provider?: string;
    model?: string;
    effort?: string;
    mode?: string;
  };

  activeRuns: Record<string, ActiveRunView>;
  providers: ProviderView[];
  models: ModelView[];

  banner?: UiMessage;
}
```

Do not mix the canonical routing config into mutable React state.

Overrides are just an input to the orchestrator.

---

# Sensitive data

The TUI must inherit all Phase 4 privacy/security behavior.

Additionally:

- do not show full environment variables
- do not display authentication tokens
- do not log raw clipboard contents
- do not persist prompt history by default
- do not write command input to telemetry unless it is already part of the canonical run record
- redact provider error text before display
- do not expose private worker prompts in provider/status panels
- do not add analytics/telemetry sent to an external service

All TUI telemetry remains local unless an existing provider call is intentionally made through the orchestrator.

---

# Repository/project information

The header should show safe local context where available:

```text
repo name
current branch
dirty/clean indicator
DTR mode
privacy classification
active override summary
```

Do not run expensive Git commands every render.

Cache and refresh on meaningful lifecycle events or a bounded interval.

---

# Suggested header

Example:

```text
DTR  trading-system  branch:dev*  AUTO  private  effort:auto
```

Where:

```text
*
```

means working tree dirty.

Do not make this status itself mutate Git.

---

# Status bar

The status bar can show:

```text
active run
focused screen
keyboard hints
last safe status message
```

Example:

```text
RUN #38 · 3/4 workers complete     Tab panels · Ctrl+K commands · Esc back
```

Keep it short.

---

# TUI colors

Use restrained terminal colors if implemented.

Requirements:

- functionality must remain understandable without color
- honor `NO_COLOR` where practical
- do not hard-code assumptions about light/dark terminal backgrounds
- status symbols/text must carry meaning in addition to color

Do not make theming a Phase 5 priority.

---

# Accessibility/usability

At minimum:

- no color-only states
- keyboard-only operation
- clear focus indication
- stable screen layout
- readable error messages
- no continuously animated spinners that cause excessive rerendering
- preserve terminal scrollback if alternate-screen mode is disabled

---

# Tests

All existing Phase 1–4 tests must continue to pass.

Add Phase 5 tests for at least the following.

## Command parser

Test:

```text
normal task
/route
/fanout
/pipeline
/models
/model
/providers
/provider
/effort
/mode
/usage
/context
/runs
/run
/abort
/help
/quit
unknown command
quoted arguments
empty task
```

Slash command parsing must be deterministic.

---

## Override behavior

Test:

```text
provider override
model override
effort override
mode override
reset to auto
overrides not persisted unintentionally
hard policy still wins over unsafe override
```

---

## Dashboard rendering

Mock the DTR application and render:

```text
healthy providers
unavailable provider
active run
no active run
unknown quota
known quota
known context
unknown context
narrow terminal
wide terminal
```

Use text/snapshot assertions conservatively.

Do not make tests brittle around whitespace that can change harmlessly.

---

## Run lifecycle

Mock event sequences:

```text
run-created
route-selected
worker-started
worker-completed
run-completed
```

and:

```text
worker-failed
run-failed
```

Verify UI state updates correctly.

---

## Abort

Test:

```text
abort current run
abort explicit run
abort failure
aborting state before confirmed aborted state
```

---

## Telemetry normalization

Test:

```text
exact token counts
unknown context
known context
authoritative false
OpenRouter cost
unavailable Claude quota
unavailable Codex quota
Ollama runtime reachable
Ollama runtime unavailable
```

No test should require live paid-provider access.

---

## Secret redaction

Inject errors containing fake:

```text
ANTHROPIC_API_KEY
OPENAI_API_KEY
OPENROUTER_API_KEY
Authorization: Bearer ...
```

and verify they do not appear in rendered output or TUI logs.

---

## TTY behavior

Test where practical:

```text
interactive TTY → TUI allowed
non-TTY → TUI not auto-launched
```

Do not make CI require a real interactive terminal.

---

## Terminal cleanup

Unit-test cleanup registration logic where possible.

At minimum verify cleanup is idempotent.

Calling cleanup twice must not corrupt output.

---

# Integration tests

Add mocked integration tests around:

```text
TUI command
→ DtrApplication call
→ lifecycle events
→ rendered state
```

Examples:

```text
type normal task
→ application.run called with AUTO strategy
→ worker-started event
→ worker completed
→ run shows PASS
```

and:

```text
/fanout investigate bug
→ application.fanout called
→ independent workers appear
```

No paid inference is required for default CI.

---

# Manual acceptance scenarios

Document and run these manually before declaring Phase 5 complete.

## Scenario 1 — startup

Run:

```bash
dtr
```

Expected:

- TUI starts
- current repository shown
- providers begin health checks
- command bar accepts input
- terminal is restored after exit

---

## Scenario 2 — normal routed task

Enter:

```text
Inspect this repository and identify the main runtime entry point. Do not modify anything.
```

Expected:

- AUTO routing is used
- route decision appears
- worker state transitions are visible
- final run state appears
- telemetry is persisted normally

---

## Scenario 3 — explicit fanout

Enter:

```text
/fanout Independently identify likely causes of the failing reconnect test. Read-only.
```

Expected:

- fanout strategy used
- multiple eligible model families shown if policy permits
- each worker's provider/model/effort visible
- results return through normal orchestrator

---

## Scenario 4 — model override

Enter:

```text
/provider codex
/effort high
```

Then submit a task.

Expected:

- overrides shown in UI
- router receives explicit preference
- hard safety/privacy rules remain enforced
- reset returns to auto

---

## Scenario 5 — context/usage

Run:

```text
/context
/usage
```

Expected:

- known metrics are displayed
- unavailable account quota says unavailable
- no invented remaining percentages

---

## Scenario 6 — Ollama

With Ollama running:

```text
/health
/providers
```

Expected:

- Ollama shown as available
- local model status shown where discoverable
- local runtime information accurately labelled

Stop Ollama and refresh/re-run health.

Expected:

- provider becomes unavailable/degraded
- TUI remains usable
- no crash

---

## Scenario 7 — run history

Run:

```text
/runs
```

Select a prior run.

Expected:

- summary list opens
- detail view loads on demand
- Esc returns correctly
- no entire telemetry corpus loaded at startup

---

## Scenario 8 — abort

Start a long mocked/local run and execute:

```text
/abort
```

Expected:

- state becomes `aborting`
- orchestrator cancellation is invoked
- final state reflects actual result
- TUI does not claim cancellation before confirmation

---

## Scenario 9 — terminal resize

Resize from wide to narrow and back.

Expected:

- no crash
- command input preserved
- active run remains visible
- layout adapts

---

## Scenario 10 — crash/exit cleanup

Exit normally and via Ctrl+C.

Expected:

- terminal echo/input restored
- cursor usable
- no broken alternate screen
- no visible secret output

---

# Documentation

Add:

```text
docs/tui.md
```

Document:

- installation
- launching
- screen layout
- all slash commands
- keyboard shortcuts
- routing overrides
- provider/model views
- context semantics
- usage/quota semantics
- Ollama runtime semantics
- run history
- abort behavior
- troubleshooting

Update:

```text
README.md
docs/architecture.md
docs/troubleshooting.md
```

---

# README positioning

After Phase 5, the README should make it clear that DTR can be used in three ways:

```text
1. Interactive terminal UI
2. Scriptable CLI
3. MCP server for Claude/Codex/other hosts
```

Example architecture:

```text
                       ┌── TUI
                       │
User / agent ── DTR ───┼── CLI
                       │
                       └── MCP
                            │
                      Orchestrator
                     /     |      \
                Claude   Codex   Ollama
                           |
                      OpenRouter etc.
```

Do not reposition the TUI as a separate orchestration engine.

---

# Troubleshooting documentation

Include at least:

```text
TUI does not launch
terminal appears corrupted after crash
provider says unavailable
Claude/Codex auth expired
Ollama not detected
context unavailable
subscription quota unavailable
OpenRouter budget unavailable
model missing from registry
run appears stuck
abort failed
narrow terminal rendering issue
```

For "subscription quota unavailable", explicitly explain that DTR refuses to scrape private account pages or fabricate a remaining allowance.

---

# Performance constraints

The idle TUI should not create continuous provider requests.

Requirements:

- no constant Claude/Codex health polling
- no constant remote quota polling
- bounded provider refresh interval if one is used
- refresh on explicit `/health` or meaningful lifecycle events
- no tight polling loop over `.dtr/runs`
- no repeated Git process every render
- no repeated Ollama request every render

Prefer event-driven state with occasional bounded refreshes.

---

# Suggested refresh policy

A reasonable default:

```text
provider health:
  startup
  explicit /health
  after provider failure
  optional slow refresh

quota:
  startup only if supported
  explicit /usage
  after a completed API-billed run if useful

Ollama runtime:
  startup
  explicit /providers or /local
  when starting/completing a local worker

Git status:
  startup
  after a DTR writer completes
  explicit refresh
```

Do not treat these timings as hard protocol requirements if a cleaner event-driven design exists.

---

# Do not add yet

Do not expand Phase 5 into unrelated product work.

Specifically do not implement unless already trivial:

- browser/web UI
- Electron desktop app
- mobile UI
- remote multi-user server
- cloud account system
- external analytics
- collaboration features
- provider billing purchases
- automatic API-key creation
- scraping Claude/ChatGPT quota pages
- voice interface
- persistent chat-history cloud sync
- autonomous routing-policy self-modification
- new model providers solely for the TUI
- terminal image rendering
- advanced theming/plugin marketplace

Keep Phase 5 focused on making the existing orchestrator usable as a high-quality terminal application.

---

# Acceptance criteria

Phase 5 is complete only when:

- all Phase 1–4 tests still pass
- `dtr` launches the TUI in an interactive terminal
- `dtr tui` explicitly launches it
- non-TTY/script usage remains safe
- TUI components never invoke providers directly
- CLI, MCP, and TUI use the same DTR application/orchestrator
- normal text submits an AUTO-routed task
- required slash commands work
- model/provider/effort/mode overrides work without bypassing hard policy
- active run/worker lifecycle is visible
- run history and detail views work
- provider health is visible
- per-run token/context metrics are shown only when known
- unknown context is labelled unknown
- account quota is shown only when authoritative
- Claude/Codex quota is allowed to remain `unavailable`
- Ollama local runtime status is visible when available
- abort reflects actual orchestrator state
- terminal resizing does not crash the UI
- terminal state is restored on normal and interrupted exit
- secrets are redacted from UI errors
- prompt/command history is not persisted by default
- no paid-provider access is required in CI
- `docs/tui.md` fully documents behavior and commands

---

# Definition of done

At the end of Phase 5, a normal engineering session should be possible from one terminal:

```text
$ dtr

DTR
────────────────────────────────────

> Find why orders are not being submitted.

Routing:
Claude / Opus / high          architect
Codex / Sol / high            debugger
Qwen / local / medium         log-analysis
Codex / Terra / high          reviewer

...

> /context
> /usage
> /runs
> /run 42
> /models
> /effort high
> /fanout Check the execution-state hypothesis independently.
```

The TUI should feel like a control surface for the multi-model router, not like a skin over one provider.

The user must be able to understand:

```text
what is running
why it was routed
which provider/model was selected
which effort level was selected
which workers completed/failed
how much known context was used
what usage information is authoritative
what remains unknown
what happened in previous runs
```

without opening three separate coding-agent applications.

---

# Final Codex report

When Phase 5 is complete, return:

1. changed files
2. final TUI package/file structure
3. exact launch commands
4. slash commands implemented
5. keyboard controls implemented
6. provider/context/usage telemetry implemented
7. which quota fields remain unavailable and why
8. Ollama runtime information implemented
9. run-history/detail behavior
10. exact build/test commands and results
11. manual acceptance scenarios completed
12. any remaining known limitations

Do not proceed into a Phase 6 or unrelated feature work unless separately requested.
