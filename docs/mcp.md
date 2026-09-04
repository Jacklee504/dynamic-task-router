# MCP server

Dynamic Task Router is host-neutral: Codex, Claude Code, or another MCP client
can lead and call the same local STDIO server.

Build first, then start it with:

```sh
npm run build
npm run dtr:mcp
```

The server exposes only typed router tools: `dtr_health`, `dtr_models`,
`dtr_start`, `dtr_usage`, `dtr_select`, `dtr_run`, `dtr_fanout`,
`dtr_pipeline`, and `dtr_status`.
There is no shell passthrough, executable override, environment-variable tool,
or raw provider command.

## Codex lead

Add the built local server as an STDIO MCP server:

```sh
codex mcp add dynamic-task-router -- npm --prefix /absolute/path/to/dynamic-task-router run dtr:mcp
```

Codex desktop and the CLI share local MCP configuration. You can alternatively
add a STDIO command from the desktop app’s MCP Servers settings. Use tool
approval that prompts for writes: `dtr_pipeline` only writes when both `write`
and a non-empty `scope` are supplied. See the [official Codex MCP guide](https://developers.openai.com/codex/mcp).

## Claude Code lead

Add the same STDIO command through Claude Code’s MCP configuration, with its
working directory set to this repository. The command is:

```sh
npm --prefix /absolute/path/to/dynamic-task-router run dtr:mcp
```

Keep the DTR server local. It relies on each installed provider CLI’s existing
authentication and never receives or stores provider API keys.

MCP callers should first use `dtr_start`, then pass a task of at most 100 words
to a routed tool. The schema validates that limit; the application constructs
the same compact task packet as the CLI and caps returned handoffs to 1,200
characters. `cwd` is the target repository for a run; it is not an executable
command. Prompts/results are not persisted by default; optional metadata-only
records are written in DTR's private temporary state directory, never into the
target repository.
