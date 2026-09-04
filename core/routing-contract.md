# Routing contract

## Invariants

1. The lead owns the user objective, integration, and final report.
2. Create task targets only after an explicit request to route or delegate.
3. Give each shared contract and implementation path one writer.
4. Require an observable result, allowed paths, checks, and return format.
5. Treat task targets as evidence producers; the lead validates their claims.
6. Review with a fresh, read-only target after integration.
7. Never claim a stop, merge, approval, or deployment that the host did not do.
8. Select a routing level (medium if omitted), model tier, and independent
   model effort through the [model routing policy](model-routing-policy.md)
   before dispatch; do not silently downgrade an unavailable tier or
   user-selected routing level.
9. Minimize context in both directions: task targets receive only task-local
   references and the lead retains only decision-relevant evidence.
10. Treat provider, model, and effort as orchestration metadata. Do not put
    them or their routing rationale in the task prompt unless execution
    requires a value.
11. Record the requested and effective provider, model, and effort for every
    routed task. Make every fallback explicit and logged.
12. Use read-only execution for cross-provider tasks by default. Parallel
    writers require isolated worktrees and explicit write ownership.
13. For high-diversity work, choose independent model families. Select models
    from declared policy and measured outcomes, not a global ranking.

## Compact task contract

For native host subchats and subagents, use this default packet. Aim for 300
tokens or fewer, excluding an unavoidable literal diff or failing-output
excerpt. Point to paths and symbols instead of pasting file contents; include
an excerpt only when the target cannot obtain the fact by reading the named
file. The executable DTR CLI is stricter: use `dtr start`, then send a single
100-word `--task` and an optional `--files` path list.

```text
GOAL: <observable outcome>
SCOPE: <allowed paths>
CONTEXT: <paths/symbols and only essential facts>
DO NOT: <non-goals>
CHECK: <commands or evidence>
RETURN: STATUS; PATHS; CHECK; RISK
```

Require a normal implementation or test return to be four lines or fewer and
roughly 120 tokens or fewer:

```text
STATUS: done | blocked | needs-decision
PATHS: <changed paths, or none>
CHECK: <command/result, or not run + why>
RISK: <blocker, follow-up, or none>
```

For review, return `FINDINGS: none` or at most three `path:line — failure —
correction` items. Do not receive or return the full routing plan, sibling or
parent transcript, model rationale, restated goal, prose preamble, or raw logs.
Return an exact diff only when that route explicitly needs a proposed diff.

## Lead context discipline

Do not route work when reading or answering it in the lead costs less than the
dispatch and handoff. Keep one compact decision record per target (class,
routing level, base tier, selected tier, model effort, scope, fallback), send
follow-ups as deltas only, and aggregate child results once into `status;
paths; checks; risk`. Let the lead inspect named files or native child state
directly instead of copying their content into its context. Trim command output
to the decisive pass/fail line or error excerpt.

## Lifecycle

| Intent | Lead action |
| --- | --- |
| Route | Define outcome and checks; dispatch only independent task targets. |
| Status | Report registered task-target state and blockers; do not change work. |
| Continue | Send one task-local follow-up to the same task target. |
| Handoff | Integrate returned evidence and run combined checks. |
| Abort | Stop registered task targets through the native host control when available. |
| Restart | Abort first; create fresh task targets from the corrected objective. |

## Escalate only when needed

Use more task targets, larger context, or stronger models only for a real shared
contract, ambiguity, conflicting evidence, or material safety boundary.
