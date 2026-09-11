# Troubleshooting

If a CLI provider is unavailable, authenticate its host CLI and re-run
`dtr health`; the router will not print the host's auth output. If OpenRouter or Featherless
is unavailable, keep it disabled or make its credential available to the DTR
process—do not add it to configuration or the repository.

Provider timeouts and unavailable models fail the task with an error rather
than quietly choosing a different provider. `defaults.timeoutMs` in
`config/routing-policy.yaml` covers startup, queueing, tool use, and the final
response; the repository default is one hour. CLI runs print selection, start,
completion, and a 30-second elapsed heartbeat. DTR never prints model
chain-of-thought or partial private output. Refresh a stale optional catalog
with `dtr models refresh`; this affects only cached display metadata. For write
pipelines, start from a clean Git checkout and use a narrow scope. DTR retains
the isolated worktree and evidence for review; it never merges or deletes it
automatically.

For the terminal UI, launch `dtr` from an interactive terminal (or use `dtr tui`).
In non-TTY use, choose an explicit CLI command instead. If a crash leaves the
display unusual, start a fresh shell; DTR's alternate-screen cleanup is guarded
and idempotent. Narrow terminals stack the dashboard panels without changing
the command input.

Context is labelled unavailable unless a provider reports both current usage
and a context window. Claude and Codex subscription quota is intentionally
unavailable: DTR does not scrape private account pages or invent remaining
allowance. If an active run cannot be aborted, DTR reports that state honestly;
only processes owned by the current TUI session can receive cancellation.
## Provider diagnostics

Use the local, read-only diagnostic before changing configuration:

```sh
dtr doctor --verbose
```

It checks executable discovery, a successful version command, authentication
readiness, and the safety flags DTR requires. For Ollama it also checks only
the enabled models in `config/models.yaml`. It never sends a worker prompt,
reads a credential, or prints authentication command output.
