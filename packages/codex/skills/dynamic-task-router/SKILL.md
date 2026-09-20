---
name: dynamic-task-router
description: Delegate explicitly requested bounded coding investigation, implementation, verification, or review through Dynamic Task Router MCP tools. Use when the user asks to route work with DTR, choose another configured model, or use a DTR pipeline. Do not use for ordinary single-model work.
---

# Dynamic Task Router

Use DTR as a bounded model dispatcher. The parent remains responsible for
understanding the request, approving writes, reviewing results, integrating a
diff, and reporting the final outcome. Do not delegate merely to avoid normal
implementation work.

## Before dispatch

This skill already contains the dispatch contract, so `dtr_start` is only for
humans or generic MCP clients that lack this skill. Check `dtr_doctor` when a
provider may be unavailable, unauthenticated, or newly configured. Do not
attempt to repair authentication, install tools, alter provider configuration,
or expose credentials unless the user explicitly asks.

Turn the parent objective into one compact task:

- State the observable goal, essential constraint, and required check.
- Name at most eight relevant relative paths. Point to symbols or paths rather
  than pasting source, logs, a transcript, or routing rationale.
- Keep the task under 100 words. Do not include private reasoning.
- `dtr_prepare` is optional. Use it for a route preview, calibration, or
  uncertain scope. Normal validation already happens inside `dtr_run`,
  `dtr_dispatch`, and `dtr_pipeline`; do not require a prepare round-trip
  before every run.

Use this shape when writing a task:

```text
Goal: <observable result>.
Constraint: <non-goal or invariant>.
Check: <targeted command or evidence>.
```

## Choose the narrowest strategy

- Use `dtr_run` for a single read-only investigation, focused review, or
  verification. Return its compact `STATUS`, `PATHS`, `CHECK`, and `RISK`
  handoff to the parent.
- Use `dtr_dispatch` for a long single read-only worker: it returns the run ID
  immediately, your own work can continue, then poll `dtr_status` and use
  `dtr_abort` if needed.
- Use `dtr_fanout` only when an independent comparison is materially useful.
  Do not fan out routine tasks.
- Use `dtr_pipeline` for a user-authorized, multi-stage workflow. Use
  `implement-review` for implementation that needs an independent review.
  Set `write: true` only when the user asked DTR to make changes. Supply
  `scope` only as a deliberate write allowlist. Never invent a write scope.
- Let DTR select models automatically by default. If the user asks to constrain
  a pipeline, use `implementationProvider` and `reviewProvider` separately.
  Never use a pipeline-wide provider pin or force the reviewer into the same
  model family as the implementer.

## Provider and safety constraints

`allowedProviders` and `allowedFamilies` are different filters. A provider is
the runtime bridge, such as `opencode` or `antigravity`. A family is the model
lineage, such as `featherless`, `google`, `anthropic`, or `openai`. To select
an OpenCode-backed model, use `allowedProviders: ["opencode"]`, never
`allowedFamilies: ["opencode"]`. Do the equivalent for Antigravity.

Antigravity and Codex provide `worktreeScopedWrite`. This is not
equivalent to `write_safe`: `worktreeScopedWrite` providers are eligible for
isolated worktree or persistent branch writes with an explicit non-root
`scope`, rejecting commits, deletes, renames, and out-of-scope changes, but are
not eligible for direct in-place writes to `main`. OpenCode does not expose
`worktreeScopedWrite` in this release. Use worktree-scoped write providers only in
a user-authorized `write: true` pipeline with named paths, never `scope: ["."]`.
Use a different-family provider, such as `claude` or `codex`, for review. Do not
weaken `write_safe: false`.

Do not combine a remote-provider request with `localOnly`, `allowRemote:
false`, or `privateCode: true`. Remote profiles remain ineligible for private
code unless the user has explicitly approved that provider's privacy terms and
updated its reviewed local profile. Before retrying a constrained route, use
`dtr_select` or `dtr_prepare` with the same role and provider filter; do not
guess from a truncated rejection summary.

The normal DTR task is intentionally not a full coding brief. Let the selected
host inspect the named files and direct dependencies inside the target
repository. Keep parent-only decisions, broad project history, and unrelated
context out of the worker packet.

## Results and follow-up

MCP returns the selected route and the bounded worker handoff for `dtr_run`.
For a dispatched or pipeline run, retain the returned run ID and stage summary;
use `dtr_status` to inspect completion metadata and `dtr_abort` to stop an
in-flight worker when the parent resolves the question early. Treat a
successful worker as evidence, not as an integration decision. Review the
relevant diff and run the targeted checks before declaring the user request
complete.

Record the parent decision with `dtr_outcome` after reviewing a substantial
DTR result. Use `accepted`, `rejected`, `partial`, or `escalated` truthfully.
Do not record an outcome before the parent has examined the result.

## Safety boundary

Never send secrets, environment-file contents, credentials, unredacted logs,
or unrelated repository context. Do not use DTR to bypass host approvals,
sandboxing, repository rules, or user authority. If DTR reports a provider,
scope, safety, or write-boundary failure, surface it concisely and stop rather
than retrying through a weaker path.
