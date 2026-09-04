---
name: app-task-router
description: Route explicitly requested cross-cutting Codex work through visible, parent-owned subchats. Use when the user asks to route, delegate, inspect, continue, hand off, abort, or restart bounded implementation, test, documentation, or review work.
---

# App Task Router

The parent owns the objective, integration, and final report. A subchat is a
child task, never an independent owner. Read
[host compatibility](references/host-compatibility.md) before dispatch and fail
closed if a needed control is unavailable.

When the user specifically asks to use the installed executable DTR CLI, run
`dtr start` before preparing the task. Use the resulting compact contract with
`dtr route --task "…" --files "path1,path2"`; reserve `dtr run` for a
deliberate explicit provider/model override. Do not put routing rationale,
source, logs, or transcripts in the CLI task.

## Route

1. State the objective, minimum safe change, checks, and safety boundary.
   Classify the task, set routing level to `medium` unless explicitly specified,
   then adjust its eligible model tier through the shared policy: low lowers
   one tier, high raises one tier, and safety minima always win.
2. Allocate the next numeric run ID; title parent and children with it.
3. Select model effort independently from role and risk. Show a compact
   manifest: target; routing level; base/selected tier; model effort; write
   boundary; check; dependency.
4. Keep trivial work in the parent; dispatch only independent tasks whose
   benefit exceeds dispatch and handoff overhead. One writer owns each shared
   contract.
5. Use a managed worktree for each parallel writer when available.

Send each subchat only this task-local contract. Aim for 300 tokens or fewer:

```text
GOAL: <observable outcome>
SCOPE: <allowed paths>
CONTEXT: <paths/symbols and only essential facts>
DO NOT: <non-goals>
CHECK: <commands or evidence>
RETURN: STATUS; PATHS; CHECK; RISK
```

Point to files and symbols instead of pasting source. Do not send the manifest,
sibling work, model rationale, parent narrative, or raw logs. Limit normal
returns to four lines and roughly 120 tokens; use the return form in
[prompt templates](references/prompt-templates.md). Send follow-ups as deltas
only. Retain only normalized `status; paths; check; risk` evidence in the
parent, not child transcripts.

## Manage

- **Status:** read registered subchat state; report roster, blocker, next owner.
- **Continue:** send one narrow delta only when objective and scope match.
- **Handoff:** integrate returned evidence, run combined checks, and record the
  checkpoint in [prompt templates](references/prompt-templates.md).
- **Abort:** stop registered active subchats with the native control. If absent,
  tell the user how to stop them; do not claim success.
- **Restart:** abort first, then allocate a new run and dispatch fresh subchats.

## Review and safety

After integration, create a fresh read-only reviewer with the request, diff,
invariants, and actual checks. Repair real findings and rerun affected checks.

Never access secrets or configuration to route work. Require explicit approval,
named invariants, rollback/failure paths, and relevant verification for
destructive, production, financial, auth, or security-sensitive work.
