# Terminal UI

Launch the local terminal control surface with `dtr` in an interactive terminal
or explicitly with `dtr tui`. Install the checkout once with `npm run link:local`
to make `dtr` available from any directory. The current directory is the target
repository; use `dtr tui --cwd /path/to/repository` to choose one explicitly.
In a script, CI runner, pipe, or MCP process,
bare `dtr` prints help and exits rather than attempting to start Ink.

The dashboard shows provider health, selected session overrides, active routed
tasks, the latest short result, and a command bar. Wide terminals show providers
and active runs side by side; narrow terminals stack them. The layout is capped
for wide VS Code terminals. Provider/model checks load separately from recent
runs, so a slow health check does not hold back the command bar. DTR restores its
alternate screen on normal quit, interrupt, termination, and render cleanup.

Normal text submits an AUTO-routed, read-only task. Slash commands are parsed
locally and deterministically:

```text
/route <task> [--files path1,path2]
/fanout <task> [--files path1,path2]
/pipeline <task> [--files path1,path2]
/models
/model <id|auto>
/providers
/provider <name|auto>
/effort <level|auto>
/mode <auto|single|fanout|pipeline>
/usage
/context
/status
/workers
/runs
/pick N
/run <id>
/result [id]
/attach <id>
/detach
/abort [id]
/chats
/resume [id]
/history
/parent
/new [task]
/reply <task> [--files path1,path2]
/health
/config
/clear
/help [command]
/quit
```

`/provider`, `/model`, `/effort`, and `/mode` are session-only overrides. They
are not written to YAML and still pass through normal model eligibility,
privacy, locality, cost, and read-only checks. Reset any one with `auto`.
Each of them confirms the resulting session state, for example
`Model override cleared - mode:auto - provider:codex - model:auto - effort:auto`.

Keyboard: `Ctrl+K` dashboard, `Ctrl+R` runs, `Ctrl+O` models, `Esc` back,
Up/Down session-history navigation, Tab slash-command completion, Left/Right
cursor editing, `Ctrl+A`/`Ctrl+E` line ends, and `Ctrl+U` clear input. `Ctrl+C`
aborts the current TUI-owned run or exits when none is active. Prompt history
is kept in memory only.

The numbered run list and the result screen are the two ways to move from a
summary to the underlying text without leaving the terminal.

If no configured provider is healthy, the dashboard shows a "NO ROUTE
AVAILABLE" panel that points at `dtr doctor --verbose` instead of leaving the
user to infer the problem from a list of unavailable providers. A failed run
shows its recorded error in the status line, so the reason is readable without
a second command.

`Ctrl+M` is intentionally not a shortcut: macOS terminals encode it as Return,
so it cannot be distinguished from submitting the command input. Use `Ctrl+O`
or `/models` instead.

The provider view reports configured status and health. The models view reports
registry metadata, availability, context windows, and private-code eligibility.
`/context` only shows current occupancy when a provider has actually reported
it; otherwise it shows the configured window and labels current usage unknown.
`/usage` aggregates persisted DTR execution telemetry for Claude, Codex, Ollama,
OpenRouter, and Featherless: run counts, outcomes, duration, and provider-reported token or
cost fields where a run supplied them. Claude and Codex use structured native
CLI output when available. It does not estimate tokens from text or scrape
subscription/account pages, so a missing field remains `unknown`; subscription
quota is intentionally `not-exposed`. Ollama has no hosted account quota, and
OpenRouter and Featherless account balances are not queried. Ollama availability/model installation comes through the orchestrator.
When its local runtime is reachable, DTR also shows loaded model name, reported
runtime size, context length, and expiry. These fields are Ollama runtime
metadata, not total macOS memory usage.

Single routes dispatch in the background, leaving the input usable while the
worker runs. Each TUI single route starts or continues a DTR conversation.
After it completes, ordinary text, `/route`, or `/reply` submits a follow-up
using the previous short handoff and inherited relevant file list. `/chats`
groups recent runs by conversation. `/resume` attaches to the latest completed
conversation; `/resume <id>` or `/attach <id>` selects a completed turn by full
ID or unique prefix, including after restarting the TUI. `/history` lists
recent turns in the attached conversation, and `/parent` returns to its
previous turn so the next follow-up branches from there. `/new` detaches and
starts a fresh conversation, while `/new <task>` also submits its first task.
`/new` selects single-route mode; resuming a conversation also switches out of
fan-out or pipeline mode so plain text can be used for follow-ups.
`/detach` remains an alias for starting fresh on the next task. `/runs` reads
temporary DTR status records and `/run <id>` inspects one without attaching.
A follow-up cannot start until the attached run has completed successfully.
Fan-out and pipeline routes require `/detach` or `/new` first.

This is DTR-level continuity, not a resumed Codex, Claude, or OpenCode session.
DTR reroutes each follow-up and sends at most 800 characters from the preceding
result, not the full transcript. Only TUI single routes opt in to saving this
handoff and their relative file list in the repository-specific temporary DTR
status store (private file mode `0600`), not in the repository. Results longer
than the handoff are shown in memory only for the current TUI session. Temporary
state may be cleared by the operating system. `/abort` requests cancellation
only for a process owned by the current TUI application; it first shows
`aborting` and does not claim `aborted` until the child process returns.
