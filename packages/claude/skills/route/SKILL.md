---
description: Route an explicitly requested task through parent-led Claude Code subagents. Use only when the user asks to route or delegate bounded work.
disable-model-invocation: true
---

# Route

Read `../../references/routing-contract.md`. State objective, checks, safety
boundary, task class, routing level (`medium` if omitted), base tier, selected
tier, model effort, and fallback before dispatch. Apply low/high as a one-tier
lower/raise from the baseline; never lower a safety minimum. Create
subagents only for independent scopes whose benefit exceeds dispatch and
handoff overhead; one writer owns each shared contract.

When the user specifically asks to use the installed executable DTR CLI, first
run `dtr start` and follow its compact contract. Then use `dtr route --task
"…" --files "path1,path2"`; do not use `dtr run` unless the user deliberately
requests an explicit provider/model override. Do not narrate routing reasoning
or paste source, logs, or transcripts into that CLI task.

Select the model for the adjusted tier: Haiku for fast, Sonnet for standard or
deep, and Opus for critical. The supplied role profile (`read-only-reviewer`,
`test-runner`, `implementation-owner`, or `critical-reviewer`) inherits the
parent session's thinking configuration, which is selected by role and risk,
not the routing-level label. Do not silently downgrade an unavailable model or
an explicit routing-level request; retain the task with the parent or request a
user-approved fallback.

Use this exact subagent contract:

```text
GOAL: <outcome>
SCOPE: <paths>
CONTEXT: <paths/symbols and only essential facts>
DO NOT: <non-goals>
CHECK: <evidence>
RETURN: STATUS; PATHS; CHECK; RISK
```

Point to source rather than pasting it. Do not send parent/sibling transcripts,
model rationale, or raw logs. Keep returns to four lines and roughly 120
tokens; send follow-ups as deltas only and retain only normalized evidence in
the lead. Use agent-team mode only if the user explicitly asks and independent
subagents need direct coordination. Otherwise use subagents that report to the
parent.
