# MCP server

Dynamic Task Router is host-neutral: Codex, Claude Code, or another MCP client
can lead and call the same local STDIO server.

Build first, then start it with:

```sh
npm run build
npm run dtr:mcp
```

The server exposes only typed router tools: `dtr_health`, `dtr_models`,
`dtr_start`, `dtr_doctor`, `dtr_usage`, `dtr_select`, `dtr_prepare`,
`dtr_run`, `dtr_dispatch`, `dtr_fanout`, `dtr_pipeline`, `dtr_status`,
`dtr_abort`, and `dtr_outcome`. There is no shell passthrough, executable
override, environment-variable tool, or raw provider command.

## Codex lead

Add the built local server as an STDIO MCP server:

```sh
codex mcp add dynamic-task-router -- npm --prefix /absolute/path/to/dynamic-task-router run dtr:mcp
```

Codex desktop and the CLI share local MCP configuration. You can alternatively
add a STDIO command from the desktop app’s MCP Servers settings. Use tool
approval that prompts for writes: `dtr_pipeline` defaults to in-place write on the current checkout when `write: true`. Use `writeMode: "isolated"` for a temporary detached worktree or `branch: "<name>"` for a separate persistent branch worktree. See the [official Codex MCP guide](https://developers.openai.com/codex/mcp).

## Claude Code lead

Add the same STDIO command through Claude Code’s MCP configuration, with its
working directory set to this repository. The command is:

```sh
npm --prefix /absolute/path/to/dynamic-task-router run dtr:mcp
```

Keep the DTR server local. It relies on each installed provider CLI’s existing
authentication and never receives or stores provider API keys.

MCP callers should use this progression: `dtr_start` once for the compact
contract when the caller lacks the DTR skill (installed skill hosts already
carry it); `dtr_doctor` when availability/auth needs checking; `dtr_prepare`
when the caller wants a route preview or an uncertain scope corrected. Then
`dtr_run` (or deliberately `dtr_dispatch` for long background work, `dtr_fanout`
for independent comparison, or a pipeline). After parent review, use
`dtr_outcome` to record whether the result was accepted, rejected, partial, or
escalated.

`dtr_dispatch` returns the run ID immediately and executes the single
read-only worker in the background; `dtr_status` polls it and `dtr_abort`
attempts to stop an in-flight run and is idempotent for unknown or finished
runs.

`dtr_prepare`, `dtr_run`, `dtr_fanout`, and `dtr_pipeline` accept an optional
`files` array of at most eight relative paths. It is a path list, never source
content. The schema validates the 100-word task limit and path boundary; the
application constructs the same compact task packet as the CLI and caps
returned handoffs to 1,200 characters. `cwd` is the target repository for a
run; it is not an executable command. Prompts/results are not persisted by
default; structured metadata records (including write mode, branch, cwd, and base HEAD) are written to DTR's private state directory.
