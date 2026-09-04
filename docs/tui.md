# Terminal UI

Launch the local terminal control surface with `dtr` in an interactive terminal
or explicitly with `dtr tui`. Install the checkout once with `npm run link:local`
to make `dtr` available from any directory. The current directory is the target
repository; use `dtr tui --cwd /path/to/repository` to choose one explicitly.
In a script, CI runner, pipe, or MCP process,
bare `dtr` prints help and exits rather than attempting to start Ink.

The dashboard shows provider health, selected session overrides, active routed
tasks, and a command bar. Wide terminals show providers and active runs side by
side; narrow terminals stack them. DTR restores its alternate screen on normal
quit, interrupt, termination, and render cleanup.

Normal text submits an AUTO-routed, read-only task. Slash commands are parsed
locally and deterministically:

```text
/route <task>       /fanout <task>       /pipeline <task>
/models             /model <id|auto>     /providers
/provider <name|auto> /effort <level|auto> /mode <auto|single|fanout|pipeline>
/usage              /context             /status /workers
/runs               /run <id>            /abort [id]
/health             /config              /clear /help /quit
```

`/provider`, `/model`, `/effort`, and `/mode` are session-only overrides. They
are not written to YAML and still pass through normal model eligibility,
privacy, locality, cost, and read-only checks. Reset any one with `auto`.

Keyboard: `Ctrl+K` dashboard, `Ctrl+R` runs, `Ctrl+O` models, `Esc` back,
Up/Down session-history navigation, and `Ctrl+C` aborts the current TUI-owned
run or exits when none is active. Prompt history is kept in memory only.

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

`/runs` reads a bounded recent set of temporary DTR status records, and
`/run <id>` reads one record on demand. `/abort` requests cancellation only for
a process owned by the current TUI application; it first shows `aborting` and
does not claim `aborted` until the child process returns.
