---
description: Route an explicitly requested task through bounded Qwen Code subagents.
---

Route this objective only when the user explicitly asks to delegate work:

{{args}}

The parent owns the objective, integration, and final report. Classify the task
as read-only triage, isolated support, core/cross-cutting, or critical. Set
routing level to `medium` unless the user specifies `low` or `high`; low requests
one cheaper eligible grade and high one stronger eligible grade. Never lower a
safety minimum. Record routing level, base tier, selected model tier, reason,
and fallback. Qwen Code's grade selection is not a per-subagent reasoning-effort
control. Create subagents only for independent scopes whose benefit exceeds
dispatch and handoff overhead; one writer owns each shared contract.

If the user specifically asks to invoke the installed executable DTR CLI, first
run `dtr start`. Build one compact task from that contract and call `dtr route
--task "…" --files "path1,path2"`. Do not pass routing rationale, source, logs,
or transcripts; use `dtr run` only for a deliberate explicit-model override.

Use Qwen Code's adjusted model grade at dispatch: `fast` for fast triage or
routine review; a configured `standard` or `deep` grade for isolated or core
work; and a configured `critical` grade or strong inherited parent model for
critical work. If the requested grade is unavailable, report it and retain the
task with the parent or request a user-approved fallback. Do not silently use
`fast` or lower an explicit routing-level request.

Use the available subagent tool with this exact payload:

```text
GOAL: <outcome>
SCOPE: <paths>
CONTEXT: <paths/symbols and only essential facts>
DO NOT: <non-goals>
CHECK: <evidence>
RETURN: STATUS; PATHS; CHECK; RISK
```

Point to source rather than pasting it. Do not send sibling work, a routing
plan, parent narrative, model rationale, or raw logs. Limit ordinary returns to
four lines and roughly 120 tokens; send follow-ups as deltas only and retain
only normalized evidence in the parent. Use `implementation-owner` for
implementation, `test-runner` for isolated test work, `read-only-reviewer` for
routine review, and `critical-reviewer` for critical review after integration.
