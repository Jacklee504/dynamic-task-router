# Model routing policy

The Dynamic Task Router selects the smallest permitted model tier that
can safely satisfy a routed task. Cost is never the first rule: safety,
required repository or tool access, and the need for independent review take
precedence.

Starting a routing run remains explicit. Once a parent starts one, it classifies
each candidate task before choosing a host-native target, routing level, and
model effort.

## Task classes

| Class | Signals | Target tier |
| --- | --- | --- |
| Read-only triage | File inventory, narrow question, test-result triage, no edits | Fast |
| Isolated support | Documentation, tests, or a bounded implementation with no shared contract | Standard |
| Core or cross-cutting | Shared contract, multiple dependent paths, ambiguous implementation, or parent integration | Deep |
| Critical | Auth, secrets, financial/trading, destructive, production, or final review of such work | Critical |

Use a fresh read-only review after integration. Routine reviews use the fast
tier; a review of critical work uses the critical tier.

## Routing level

Every routed task has one routing level: `low`, `medium`, or `high`. Use
`medium` unless the user explicitly requests another level or the task signals
clearly justify it. This parameter chooses a model tier; it is not the selected
model's internal reasoning effort.

| Level | Use when | Model-selection effect |
| --- | --- | --- |
| Low | Mechanical, reversible, read-only, or tightly specified work | Select one cheaper eligible tier. |
| Medium | Ordinary bounded work; this is the default | Use the task class's baseline tier. |
| High | Ambiguity, non-obvious trade-offs, broad dependency analysis, or a user request for deeper reasoning | Select one stronger eligible tier. |

Apply the adjustment after classification and clamp it to `fast` through
`critical`: `fast → standard → deep → critical`. A task's safety boundary is a
minimum, not a preference: do not lower critical work or any task that would no
longer be safe, correct, or independently reviewable at the cheaper tier. If a
user asks for `low` but the minimum holds the tier, record that the request was
constrained rather than silently changing it.

## Selection rules

1. Keep planning, integration, and final decisions with the parent.
2. Do not dispatch a task that is trivial or tightly coupled to the parent.
3. Route a task only when its host can provide the required model tier and
   tool/isolation boundary.
4. Do not silently downgrade when the selected tier is unavailable. Report the
   unavailable target and its selected lower-tier fallback, or keep the task
   with the parent when no eligible fallback exists.
5. External providers are eligible only after the user enables them. They do
   not receive secret-bearing, production, destructive, or broad repository
   tasks by default.
6. A returned result is evidence for the parent, not final approval.
7. Treat an explicit user routing level as a model-tier request. The parent may
   raise it for a safety minimum, but must not lower it without explicit user
   approval.

## Model effort is independent

After selecting a model tier, choose the target model's internal reasoning
effort from the task's role and risk, not from the routing-level label. A lower
cost tier can still use high effort when a bounded change or independent review
needs careful reasoning. Conversely, a higher tier need not use high effort for
a narrow factual inventory.

| Effort | Use when |
| --- | --- |
| Low | Narrow factual inventory or mechanical read-only classification. |
| Medium | Small, specified support work where a quick check is sufficient. |
| High | Any code change, non-trivial diagnosis, independent review, or meaningful trade-off. |

For example, a `low` routing-level request may choose Luna with `high` effort
for a tightly bounded implementation task. The low label only means the tier
may move down if that remains safe.

## Host mappings

| Tier | Codex desktop | Claude Code | Qwen Code | Antigravity CLI |
| --- | --- | --- | --- | --- |
| Fast | Luna / effort by role | Haiku / effort by role | `fast` or configured `small` grade | Gemini Flash Low |
| Standard | Terra / effort by role | Sonnet / effort by role | configured `standard` grade, otherwise inherited parent model | Gemini Flash Medium |
| Deep | Terra / normally high effort | Sonnet / normally high effort | configured `deep` grade, otherwise inherited parent model | Gemini Flash High; Sonnet as an independent-family option |
| Critical | Sol / normally high effort | Opus / normally high effort | configured `critical` grade, otherwise a deliberately strong parent model | Gemini Pro High; Opus as an independent-family option |

Codex selects model and effort independently for the selected tier. Claude Code
selects the adjusted model per invocation; its thinking configuration remains
inherited from the parent session, so configure that session deliberately for
the role. Qwen Code does not expose a matching per-subagent reasoning-effort
field in agent frontmatter, so its adapter applies the routing level by
selecting the adjusted model grade.

Antigravity slugs already include their native thought level. DTR invokes the
selected slug directly and does not append its own effort flag. It only uses
models returned by `agy models` for the currently signed-in account.

## Decision record

Before dispatch, the parent records the decision in its routing manifest:

```text
TASK: <bounded outcome>
CLASS: <read-only-triage | isolated-support | core-or-cross-cutting | critical>
TARGET: <host-native subchat or subagent>
ROUTING LEVEL: <low | medium | high; medium if omitted>
BASE TIER: <fast | standard | deep | critical>
MODEL TIER: <fast | standard | deep | critical>
MODEL EFFORT: <low | medium | high; selected independently by role>
WHY: <scope, ambiguity, risk, tool, or isolation signals>
FALLBACK: <approved alternative or parent retains task>
```

Do not include provider credentials, full sibling transcripts, or unrelated
repository context in the record or delegated task.
