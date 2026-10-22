# Release-readiness and user-experience improvements

Date: 2026-10-21

Branch: `feat/release-readiness-ux`

This document records the changes made to move DTR toward a releasable state.
Every item is a user-visible improvement to discoverability, error reporting,
or continuity across the CLI, TUI, and MCP surfaces. None of them change the
routing decision, the safety boundary, or the write-isolation rules.

## 1. Grouped, discoverable CLI help

`dtr --help` now prints a grouped command summary instead of a dense list of
one-line fragments:

```text
Getting started:
  dtr doctor [--verbose]     Check provider availability and authentication
  ...
Running work:
  dtr route --task <text>    Route one bounded read-only task
  ...
```

`dtr <command> --help` prints the summary, usage, every accepted option, and
worked examples for that one command. The help text is generated from a single
declarative spec in `packages/orchestrator/src/cli-help.ts`, so the command
surface, the option list, and the unknown-flag check cannot drift apart.

Files: `packages/orchestrator/src/cli-help.ts` (new),
`packages/orchestrator/src/cli.ts`.

## 2. Unknown options are rejected instead of ignored

Previously an unrecognized flag was silently dropped and the command still
ran, so `--risk hig` or `--filess a.ts` looked like it had been applied. DTR
now fails with a message naming the option and pointing at the per-command
help:

```text
dtr: Unknown option --filess for 'dtr route'. Run 'dtr route --help' to see the accepted options.
```

Files: `packages/orchestrator/src/cli.ts` (`rejectUnknownFlags`),
`packages/orchestrator/src/cli-help.ts` (`knownFlagsFor`).

## 3. `dtr runs` lists recent runs

There was no CLI way to find a run id, which made `dtr status` and
`dtr outcome` hard to use. `dtr runs` now prints the recent runs for the
target repository, newest first, with the run id prefix, strategy, state,
start time, and a short detail column. `--limit` bounds the list and `--json`
emits the raw records.

```text
RUN       STRATEGY  STATE      STARTED               DETAIL
4595f5e5   single    failed     2026-10-21T08:17:19.156Z  WARNING: proceeding...
```

Files: `packages/orchestrator/src/cli.ts`, `packages/orchestrator/src/cli-help.ts`.

## 4. `dtr status` prints a readable summary

`dtr status` returned raw JSON. It now prints a labelled summary (state,
timings, write mode, branch, scope, stage results, conversation link, review
outcome) and, for a completed single route, the DTR handoff text. `--json`
restores the full machine-readable record.

Files: `packages/orchestrator/src/cli.ts`.

## 5. A run id is reported as soon as the run exists

`dtr route` never printed its run id, so a caller could not follow up with
`dtr status`, `dtr outcome`, or the TUI. A new `onRunCreated` lifecycle hook
reports the run id the moment the record exists, and the CLI prints it:

```text
dtr: run=1a2b3c4d-...
```

Files: `packages/orchestrator/src/types.ts` (`WorkerLifecycle.onRunCreated`),
`packages/orchestrator/src/application.ts`,
`packages/orchestrator/src/cli.ts` (`cliProgress`).

## 6. `--task` is accepted everywhere, `--prompt` stays an alias

`dtr route` accepted only `--task`, while `dtr fanout` and `dtr pipeline`
accepted only `--prompt`. Scripts had to remember which verb took which flag.
Both verbs now accept `--task`, and `--prompt` remains accepted as an alias
so existing scripts keep working. `dtr route` still rejects `--prompt` and
`--include-files` with its specific guidance, because those two flags carry
different safety meaning on that path.

Files: `packages/orchestrator/src/cli.ts` (`taskFlag`, `filesFlag`).

## 7. MCP: list runs and continue a conversation

The MCP surface had no way to enumerate runs, and no way to continue a DTR
conversation. Two additions:

- `dtr_runs` lists recent runs for the target repository, newest first, with
  the strategy, state, timings, write mode, and whether the run is a resumable
  conversation.
- `dtr_run` and `dtr_dispatch` accept `continueRunId`, the run id of a
  completed single route. DTR sends the previous short handoff and inherits
  the previous relevant file list. This is DTR-level continuity, not a
  resumed provider session.

`dtr_status` now also returns the `handoff` and the `continueRunId` to use for
a follow-up, so a caller can chain turns without a second lookup.

Files: `packages/orchestrator/src/mcp.ts`,
`packages/orchestrator/src/application.ts` (unchanged contract, already
supported `conversation.parentRunId`).

## 8. TUI: the full result text is reachable

The dashboard showed a 360-character preview with no way to see the rest. The
new `/result` command (alias `/out`) opens the complete result text for the
latest run, or for a run id. `Esc` returns from it.

Files: `packages/tui/src/app.tsx` (`ResultScreen`),
`packages/tui/src/commands/registry.ts`, `packages/tui/src/types.ts`.

## 9. TUI: `/pick N` opens a run from a list

`/runs` and `/chats` were read-only lists with no way to act on an entry.
Both now number their entries, and `/pick N` opens the numbered run.

Files: `packages/tui/src/app.tsx`, `packages/tui/src/commands/registry.ts`.

## 10. TUI: a first-run hint when no provider is ready

If every configured provider is unhealthy or disabled, the dashboard now shows
a "NO ROUTE AVAILABLE" panel naming the next step (`dtr doctor --verbose`)
instead of a list of unavailable providers and no explanation.

Files: `packages/tui/src/app.tsx`.

## 11. TUI: failures show the reason

A failed run reported only "Run X failed. Use /run X to inspect." The status
line now shows the recorded error directly, so a failed provider call is
readable without a second command.

Files: `packages/tui/src/app.tsx`.

## 12. TUI: override confirmations show the whole session state

`/model`, `/provider`, `/effort`, and `/mode` all answered "Session routing
override updated." That made it impossible to confirm what the session was
actually pinned to, and a reset looked identical to a set. Each command now
reports the resulting state, for example:

```text
Model override cleared · mode:auto · provider:codex · model:auto · effort:auto
```

Files: `packages/tui/src/commands/registry.ts` (`describeOverrides`).

## 13. TUI: the result screen and run list are reachable from `Esc`

`Esc` on the run-detail screen returns to the run list. The new result screen
follows the same rule.

Files: `packages/tui/src/app.tsx`.

## 14. A flaky timing assertion was made semantic

`tests/application.test.ts` asserted that `dispatch` returned in under 50 ms.
On a loaded machine that failed intermittently even though the behaviour was
correct. The test now asserts the property that actually matters: the run is
readable as `running` while its provider call is still in flight.

Files: `packages/orchestrator/tests/application.test.ts`.

## Verification

```text
npm run build   (orchestrator + TUI)
npm test        (orchestrator 158, TUI 13, ollama-router shell check)
dtr evaluate    (12/12 routing cases)
```

The orchestrator suite was run four consecutive times to confirm the timing
assertion no longer flakes.
