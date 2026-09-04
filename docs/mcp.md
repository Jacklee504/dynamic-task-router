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
`dtr_run`, `dtr_fanout`, `dtr_pipeline`, `dtr_status`, and `dtr_outcome`.
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

MCP callers should use this progression: `dtr_start` once for the compact
contract; `dtr_doctor` when availability/auth needs checking; `dtr_prepare`
for every candidate task; then `dtr_run` (or deliberately `dtr_fanout` / a
pipeline). After parent review, use `dtr_outcome` to record whether the result
was accepted, rejected, partial, or escalated.

`dtr_prepare`, `dtr_run`, `dtr_fanout`, and `dtr_pipeline` accept an optional
`files` array of at most eight relative paths. It is a path list, never source
content. The schema validates the 100-word task limit and path boundary; the
application constructs the same compact task packet as the CLI and caps
returned handoffs to 1,200 characters. `cwd` is the target repository for a
run; it is not an executable command. Prompts/results are not persisted by
default; optional metadata-only records are written in DTR's private temporary
state directory, never into the target repository.
