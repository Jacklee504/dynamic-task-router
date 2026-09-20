# Dynamic Task Router – Correctness Fixes Before Continuing Roadmap

Date: 2026-09-20

## Purpose

This document captures the fixes that should be made to the current `main` branch before continuing with the previously planned DTR changes 1–9.

The current `main` contains the recent changes:

- `Improve provider capabilities and model profiles`
- `Make DTR writes in-place by default`

The in-place write direction is broadly correct, but several correctness and architecture issues should be resolved first.

---

# Part A – Required Correctness Fixes

## Fix A1 – Make write-lock acquisition exception-safe

### Problem

`runStage()` currently acquires the in-place/branch write lock before entering the `try/finally` that releases it.

If one of these operations fails after the lock is created:

- clean-checkout validation
- branch preparation
- in-place preparation
- initial HEAD lookup
- future setup checks

the lock can remain behind indefinitely.

That can block later DTR write runs even though no worker is active.

### Required change

Move lock acquisition and write-target preparation into the same `try/finally` scope that guarantees lock release.

The rule should be:

```text
acquire lock
    ↓
prepare target
    ↓
run worker
    ↓
verify
    ↓
finally release lock
```

Any error after lock acquisition must release the lock.

### Tests

Add regression coverage for:

- dirty checkout after lock acquisition
- branch preparation failure
- worker failure
- verification failure
- successful execution

Every case must leave no active write lock after the run exits.

---

## Fix A2 – Make write-lock creation atomic and recover stale locks

### Problem

The current lock flow is effectively:

```text
if lock exists:
    fail

write lock file
```

Two DTR processes can race:

```text
process A checks → absent
process B checks → absent
process A writes
process B writes
```

The lock therefore does not reliably guarantee a single in-place writer.

A crashed process can also leave a stale lock permanently.

### Required change

Create the lock atomically using exclusive creation semantics, for example:

```text
writeFile(..., { flag: "wx" })
```

The lock metadata should include at minimum:

```text
runId
pid
acquiredAt
repo
```

When a lock already exists:

1. read it safely;
2. determine whether the recorded process is still alive;
3. reject if the owner is active;
4. recover/remove it if it is clearly stale;
5. fail safely if ownership cannot be established.

Never silently overwrite an active lock.

### Tests

Cover:

- first writer acquires lock;
- second concurrent writer is rejected;
- crashed/stale PID can be recovered;
- malformed lock file fails safely;
- release removes only the expected DTR lock.

---

## Fix A3 – Validate `--branch` correctly

### Problem

With the current generic flag parser:

```text
--branch
```

without a value becomes boolean `true`.

The pipeline code currently converts only string values into a branch name, so bare `--branch` can silently fall through to the normal in-place mode.

That is dangerous because the user explicitly requested branch mode.

### Required change

If `--branch` is present but is not a non-empty string, fail immediately.

Example error:

```text
dtr: --branch requires a branch name
```

Keep:

```text
--isolated
--branch <name>
```

mutually exclusive.

### Tests

Cover:

```text
--write --branch
→ fail

--write --branch feature/test
→ branch mode

--write --isolated --branch feature/test
→ fail
```

---

## Fix A4 – Define branch mode deliberately

### Problem

The current `--branch <name>` implementation checks out the new branch directly in the current checkout:

```text
git checkout -b <name>
```

This is different from the earlier intended model of a persistent branch with an isolated worktree.

### Preferred behavior

Use these execution modes:

```text
default
→ in-place on the current clean checkout

--isolated
→ temporary detached worktree

--branch <name>
→ persistent named branch in a separate worktree
```

This keeps the normal workflow simple while ensuring explicit branch mode does not unexpectedly switch the user's main checkout.

### Required behavior for `--branch`

- base the new branch on current `HEAD`;
- create a separate worktree;
- preserve it after the run;
- print its branch and worktree path;
- do not switch the original checkout;
- reject an existing/conflicting branch safely;
- retain worker commit restrictions unless explicitly changed in a future design.

### Tests

Verify the original checkout:

- stays on its original branch;
- stays clean;
- does not move HEAD;
- can inspect the persistent branch worktree separately.

---

## Fix A5 – Make isolated mode detached and branchless by default

### Problem

`--isolated` still creates:

```text
dtr/<uuid>-implement
```

branches.

That recreates the branch clutter that motivated the in-place redesign.

### Required change

Create temporary isolated worktrees with:

```bash
git worktree add --detach <path> HEAD
```

The isolated run should store:

```text
mode
worktree path
base HEAD
run ID
worker ID
```

but should not require a temporary Git branch.

### Cleanup

Provide explicit safe cleanup support later if useful, but never remove evidence automatically after a failed run unless policy explicitly allows it.

### Tests

Verify:

- no new local branch is created;
- the base checkout remains untouched;
- write-boundary verification still works;
- parallel isolated runs remain possible.

---

## Fix A6 – Make provider execution capabilities authoritative

### Problem

`ProviderCapabilities` now exists on every provider:

```text
workspaceRead
workspaceSearch
shellAccess
nativeTextAttachments
nativeImageAttachments
verifiedReadOnlyExecution
worktreeScopedWrite
```

However, routing still primarily gates tool/write behavior from model-level capabilities in `models.yaml`.

That means the new provider capability layer is not yet the source of truth.

### Required change

Execution/harness capabilities must come from the provider adapter.

Model configuration should contain model properties such as:

```text
tier
role scores
context size
model vision support
cost
privacy
effort support
```

Provider/harness configuration should determine:

```text
workspace access
repository search
shell access
native attachment transport
verified read-only execution
write isolation mode
```

Routing should combine:

```text
model suitability
+
provider execution capability
```

rather than duplicating provider facts into every model profile.

### Important write rule

`worktreeScopedWrite` must mean exactly what its name says.

A provider that is only approved for worktree-scoped writes must not automatically become eligible for direct in-place writes to `main`.

The routing decision must know the requested write mode:

```text
in-place
isolated
branch
```

and gate providers accordingly.

---

## Fix A7 – Correct inaccurate provider capability declarations

### Problem

Several capabilities currently claim functionality the DTR adapter does not actually expose.

Examples:

### OpenCode

The adapter reports:

```text
nativeTextAttachments: true
```

but the command builder explicitly does not use `--file`.

Until DTR actually passes attachments through OpenCode:

```text
nativeTextAttachments: false
```

for the implemented DTR adapter.

### Antigravity

Agy has useful workspace read/search access, but DTR currently does not implement a native attachment transport.

Therefore do not equate workspace inspection with native file attachment.

### Codex / Claude / Ollama

Apply the same rule:

> A capability is `true` only when the current DTR adapter can actually provide and safely use it.

Do not mark a feature true merely because the upstream product may support it in some other invocation mode.

### Tests

Provider capability tests should test adapter behavior, not only hard-coded expected booleans.

Where possible, command-construction tests should prove the feature is actually wired.

---

## Fix A8 – Remove provider execution facts from per-model YAML

### Problem

`models.yaml` currently repeats provider execution details such as:

```yaml
workspace_read:
workspace_search:
shell_access:
native_text_attachments:
native_image_attachments:
verified_read_only_execution:
worktree_scoped_write:
```

across many models.

This duplicates provider-level facts and creates drift between:

```text
provider.capabilities()
```

and:

```text
model.capabilities
```

### Required change

Remove execution/harness capabilities from individual model records.

Keep only true model-level properties there.

If a small compatibility transition is needed, retain deprecated fields temporarily but ensure routing ignores them and tests prevent divergence.

---

## Fix A9 – Complete reusable model-profile support

### Problem

The commit titled `Improve provider capabilities and model profiles` did not actually add reusable model profiles.

`models.yaml` remains a flat repeated model list.

### Required change

Add reusable model profile inheritance/templates so repeated properties do not need to be copied into every model entry.

A possible shape:

```yaml
profiles:
  antigravity-gemini-flash:
    provider: antigravity
    family: google
    local: false
    privacy:
      private_code_allowed: false
      training_opt_out_required: true
    limits:
      context_tokens: 128000

models:
  - id: antigravity-gemini-flash-low
    profile: antigravity-gemini-flash
    model: gemini-3.8-flash-low
    tier: fast
    roles: ...
    efforts: ...
```

The exact schema may differ, but the effective expanded `RouterConfig` must remain deterministic.

### Migration target

Start with the repetitive Antigravity model entries.

### Tests

Verify that profile expansion produces the same effective routing model records as explicit configuration.

---

## Fix A10 – Persist and expose write-target metadata

### Problem

The CLI now prints useful information such as:

```text
write mode
branch
base HEAD
cwd
```

but this information is not fully persisted in `RunRecord` and therefore is not reliably available through MCP/status.

### Required change

Persist structured run/stage metadata:

```text
writeMode
branch
worktree/cwd
baseHead
scope
changedPaths
checks
```

For in-place mode:

```text
worktree/cwd = current checkout
branch = current branch
```

For isolated mode:

```text
branch = detached
worktree = temp path
```

For branch mode:

```text
branch = requested name
worktree = persistent path
```

### Output

A write run should print before execution:

```text
dtr: run=<id>
dtr: write mode=in-place
dtr: branch=main
dtr: base-head=<sha>
dtr: cwd=<path>
dtr: scope=<...>
```

At completion:

```text
dtr: changed paths=[...]
dtr: checks=[...]
```

MCP should return the same information structurally.

---

## Fix A11 – Handle write-pipeline no-op results explicitly

### Problem

A write-capable `implement-review` pipeline can succeed with:

```text
changedPaths: []
```

This previously resulted in a successful pipeline that did no implementation.

### Required change

Represent no-op implementation explicitly.

Preferred default:

```text
implementation stage requested
+
write=true
+
zero changed paths
→ state/result = no-op or failed implementation
```

Optionally allow:

```text
--allow-noop
```

for tasks where no change can legitimately be the correct result.

At minimum, never silently report ordinary success.

### Tests

Cover:

- expected implementation with edits;
- no-op implementation;
- explicit allow-noop;
- reviewer/verify behavior after a no-op.

---

## Fix A12 – Update stale documentation and skill contracts

The following are stale after the in-place change:

### `docs/worktrees.md`

It still describes isolated `dtr/...` worktrees as the normal write path.

Update it for:

```text
default → in-place
--isolated → temporary detached worktree
--branch <name> → persistent named branch/worktree
```

### `docs/mcp.md`

It still states write behavior that no longer matches current scope/default semantics.

Update write-mode schema and default behavior.

### Codex DTR skill

It currently explains OpenCode/Agy write safety in terms of DTR always creating an isolated worktree.

Update the skill after the provider capability/write-mode rules are corrected.

Do not describe `worktreeScopedWrite` providers as eligible for in-place mode unless that is explicitly supported and verified.

---

# Recommended Fix Order

Implement these before returning to the larger roadmap:

```text
A1  exception-safe lock release
A2  atomic/stale lock handling
A3  branch flag validation
A4  deliberate persistent branch mode
A5  detached isolated mode
A6  provider capabilities become authoritative
A7  correct capability values
A8  remove execution capabilities from model YAML
A9  reusable model profiles
A10 persist/report write metadata
A11 explicit no-op handling
A12 docs + skill synchronization
```

The most important dependency chain is:

```text
A1 → A2 → A3/A4/A5
              ↓
          write modes stable

A6 → A7 → A8 → A9
              ↓
      capability/config stable

then A10 → A11 → A12
```

Do not start the context/attachment redesign until A6–A8 are complete, because that redesign should use provider execution capabilities directly.

## Part A status (2026-09-20)

All of A1–A12 are implemented on `main` with the `dtr_correctness_fixes_and_roadmap` working tree:

```text
A1  write-lock acquisition moved inside the try/finally in runStage; every
    failure path after acquisition releases the lock (pipeline-mcp tests)
A2  wx-flag atomic lock, PID-liveness stale recovery, malformed-lock
    fail-closed, and expected-run-id release (worktrees tests)
A3  --branch requires a non-empty string; --isolated/--branch mutually exclusive
    (cli tests)
A4  --branch bases on HEAD and creates a persistent worktree; base checkout
    branch, HEAD, and cleanliness untouched (worktrees tests)
A5  --isolated uses git worktree add --detach; no dtr/<run>-<worker> branches
    (worktrees tests)
A6  selector gates tools/writes from provider capabilities; writeMode-aware
    (in-place requires writeSafe; isolated/branch allow worktreeScopedWrite
    providers with an explicit non-root scope) (routing tests)
A7  capability values corrected per adapter; OpenCode nativeTextAttachments
    false (providers tests)
A8  execution/harness capabilities removed from config/models.yaml; routing
    ignores the deprecated model-level worktree_scoped_write field
A9  reusable profiles with deterministic expansion; Antigravity variants
    migrated; profile test pins equivalence
A10 run/stage records persist writeMode, branch, cwd, baseHead, scope,
    changedPaths, checks; CLI prints the write-target header and completion
    lines (pipeline-mcp tests)
A11 zero-change implementation stages fail unless --allow-noop (pipeline-mcp
    tests)
A12 worktrees.md, mcp.md, providers.md, opencode.md, pipelines.md, safety.md,
    the Codex DTR skill, and the dtr_pipeline MCP description updated
```

Verification: `npm run build` (orchestrator + TUI), `npm test` (orchestrator 121, TUI 4), and the `ollama-router` shell check all pass.

## Part B status (2026-09-20)

Resumed in the order below (steps 1 and 7 were satisfied by Part A):

```text
2  context planner            DONE  context.ts path-reference / attachment /
                                       excerpt planning; tests/context.test.ts
3  OpenCode/Agy transport     DONE  OpenCode nativeTextAttachments true with
                                       repeated --file; providers tests pin
                                       capability and command construction;
                                       docs/providers.md + docs/opencode.md
4  DtrApplication             DONE  CLI, TUI, and MCP orchestrate through
     consolidation                  DtrApplication; raw dtr run kept isolated
                                       (mcp.ts appFor(cwd) pool)
5  MCP lifetime + output      DONE  per-cwd application pool, dtr_abort,
                                       compact success responses; SKILL.md updated
6  async MCP dispatch         DONE  application.dispatch returns { runId }
                                       promptly, background executeRun;
                                       dtr_dispatch/dtr_status/dtr_abort;
                                       dispatch + abort tests green
8  classifier refinement      DONE  evidence-based escalation in
                                       routing/classifier.ts; classifer tests
                                       + 5 inference eval regression cases
9  skill simplification       DONE  SKILL.md, docs/mcp.md, docs/prompt-policy.md
                                       treat dtr_start/dtr_prepare as optional
```

Verification at completion: orchestrator build + 139 tests, TUI 4 tests,
`dtr evaluate` 12/12 (7 prior cases + 5 new inference regressions), and the
`ollama-router` shell check all pass.

---

# Part B – Original DTR Roadmap 1–9

The following is the previously planned larger implementation sequence. Resume this only after Part A is complete.

## 1. Separate harness capabilities from model capabilities

Provider/harness execution capabilities should be represented separately from model intelligence metadata.

Conceptual split:

```text
Model
├─ intelligence/tier
├─ role scores
├─ context limit
├─ model-level vision/modal support
└─ privacy/cost

Provider/harness
├─ workspace read
├─ workspace search
├─ shell
├─ attachments
├─ read-only isolation
└─ write isolation
```

Original DTR command:

```bash
dtr pipeline \
  --template implement-review \
  --write \
  --scope packages/orchestrator/src/types.ts,packages/orchestrator/src/providers,packages/orchestrator/tests/providers.test.ts \
  --implementation-provider opencode \
  --review-provider antigravity \
  --role implementer \
  --prompt "Add explicit provider execution capabilities separate from model quality metadata. Cover workspace read, workspace search, shell access, native text attachments, native image attachments, verified read-only execution, and worktree-scoped writing. Expose capabilities through Provider and set accurate values for every existing adapter. Preserve current routing behaviour. Add focused regression tests."
```

Note: Part A supersedes the partially completed implementation of this step. Do not rerun blindly; complete A6–A8 instead.

---

## 2. Replace `include-files` with context planning

Implement provider-aware context planning for named repository files.

Desired behavior:

```text
workspace tools available
    → paths only

no workspace tools + native attachment useful
    → attachment

no workspace tools/attachments
    → bounded relevant excerpts
```

Do not inject complete files by default.

Original DTR command:

```bash
dtr pipeline \
  --template implement-review \
  --write \
  --scope packages/orchestrator/src/context.ts,packages/orchestrator/src/contracts.ts,packages/orchestrator/src/types.ts,packages/orchestrator/src/application.ts,packages/orchestrator/src/strategies,packages/orchestrator/tests/context.test.ts,packages/orchestrator/tests/application.test.ts \
  --implementation-provider opencode \
  --review-provider antigravity \
  --role implementer \
  --prompt "Implement provider-aware context planning for named repository files. Prefer workspace path references when the selected provider can read or search the workspace. Use native text attachments only when appropriate and supported. Otherwise build bounded relevant excerpts within an explicit token budget. Never inject complete files by default. Preserve cwd containment, traversal and binary protections, and the compact worker contract."
```

---

## 3. Wire OpenCode attachments and Agy workspace retrieval

OpenCode should use native text attachments only when the context planner deliberately selects attachment transport.

Agy should normally use workspace search/read rather than source injection.

Original DTR command:

```bash
dtr pipeline \
  --template implement-review \
  --write \
  --scope packages/orchestrator/src/providers/opencode.ts,packages/orchestrator/src/providers/antigravity.ts,packages/orchestrator/src/providers/shared.ts,packages/orchestrator/tests/providers.test.ts \
  --implementation-provider opencode \
  --review-provider antigravity \
  --role implementer \
  --prompt "Wire the new context plan into OpenCode and Antigravity. For OpenCode, pass explicitly selected native text attachments using repeated --file arguments while keeping ordinary repository context as workspace path references. For Antigravity, do not inline repository files when workspace access is available; let its workspace tools inspect named paths. Preserve sandboxing, permission restrictions, compact output, and current write boundaries. Add command-construction and regression tests."
```

---

## 4. Make `DtrApplication` the single orchestration layer

CLI, TUI and MCP should delegate through `DtrApplication` instead of maintaining parallel orchestration paths.

Target:

```text
CLI ─┐
TUI ─┼─→ DtrApplication → router → strategy → provider
MCP ─┘
```

Original DTR command:

```bash
dtr pipeline \
  --template implement-review \
  --write \
  --scope packages/orchestrator/src/cli.ts,packages/orchestrator/src/application.ts,packages/orchestrator/tests/cli.test.ts,packages/orchestrator/tests/application.test.ts \
  --implementation-provider opencode \
  --review-provider antigravity \
  --role implementer \
  --prompt "Refactor normal CLI operations to delegate through DtrApplication instead of directly invoking routing strategies and providers. Cover route, fanout, pipeline, select, health, models, status, stats, usage, outcome, and abort where applicable. Keep raw expert provider invocation isolated if necessary. Preserve CLI output and behaviour. Do not duplicate routing or execution logic in cli.ts."
```

---

## 5. Fix MCP application lifetime and simplify LLM-facing output

The MCP server should reuse DTR application state rather than creating unrelated application instances for each call.

It should also return compact route information instead of large rejection/config payloads by default.

Original DTR command:

```bash
dtr pipeline \
  --template implement-review \
  --write \
  --scope packages/orchestrator/src/mcp.ts,packages/orchestrator/src/application.ts,packages/orchestrator/tests/pipeline-mcp.test.ts,packages/orchestrator/tests/application.test.ts,packages/codex/skills/dynamic-task-router \
  --implementation-provider opencode \
  --review-provider antigravity \
  --role implementer \
  --prompt "Make the MCP server reuse DtrApplication instances per target cwd so active-run state and abort controls are shared across calls. Add a typed dtr_abort tool. Simplify successful model-facing responses: return run ID, compact selected route, success/state, and bounded result rather than full profiles, rejection maps, and model configuration. Keep detailed routing diagnostics available through select/prepare. Update the Codex DTR skill accordingly."
```

---

## 6. Add asynchronous MCP dispatch

Long-running DTR work should not require an MCP call to remain blocked until completion.

Desired flow:

```text
dispatch
   ↓
runId
   ↓
continue useful parent work
   ↓
status/result/abort
```

Original DTR command:

```bash
dtr pipeline \
  --template implement-review \
  --write \
  --scope packages/orchestrator/src/application.ts,packages/orchestrator/src/mcp.ts,packages/orchestrator/src/telemetry,packages/orchestrator/tests/application.test.ts,packages/orchestrator/tests/pipeline-mcp.test.ts,packages/codex/skills/dynamic-task-router \
  --implementation-provider opencode \
  --review-provider antigravity \
  --role implementer \
  --prompt "Add an asynchronous MCP dispatch path for long workers. A dispatch call should validate and start work, return a run ID promptly, and allow later status, result, and abort calls. Keep completed model output bounded and in memory rather than persisting prompts or responses. Existing synchronous dtr_run may remain for simple calls. Ensure failures, aborts, server lifetime, and duplicate result reads are handled predictably."
```

---

## 7. Deduplicate the model registry with reusable profiles

Add reusable profile inheritance so repetitive provider/model properties are not copied across many entries.

Target concept:

```yaml
profiles:
  antigravity-flash:
    provider: antigravity
    family: google
    ...

models:
  - model: gemini-3.8-flash-low
    profile: antigravity-flash
    tier: fast
```

Original DTR command:

```bash
dtr pipeline \
  --template implement-review \
  --write \
  --scope config/models.yaml,packages/orchestrator/src/config.ts,packages/orchestrator/tests/config.test.ts,packages/orchestrator/tests/routing.test.ts \
  --implementation-provider opencode \
  --review-provider antigravity \
  --role implementer \
  --prompt "Add reusable model profile inheritance to models.yaml so repeated provider/model properties do not need to be copied across many variants. Preserve support for existing fully expanded model entries. Migrate the repetitive Antigravity variants first while preserving the exact effective tiers, role scores, effort values, capabilities, costs, privacy settings, and RouterConfig output. Add configuration regression tests. Do not alter routing decisions."
```

Note: this step remains incomplete and is explicitly addressed by A9.

---

## 8. Refine deterministic task classification

Keep classification deterministic, but stop isolated keywords from over-escalating task complexity/risk.

Examples:

```text
"why" alone
→ should not automatically imply difficult

"architecture" alone
→ should not automatically imply extreme

"trading" alone
→ should not automatically imply high-risk live financial action
```

Original DTR command:

```bash
dtr pipeline \
  --template implement-review \
  --write \
  --scope packages/orchestrator/src/routing/classifier.ts,packages/orchestrator/tests/routing.test.ts,evals/cases \
  --implementation-provider opencode \
  --review-provider antigravity \
  --role implementer \
  --prompt "Refine deterministic task classification so isolated words do not over-escalate model tier or risk. Words such as why, architecture, financial, and trading should require supporting task signals before implying difficult, extreme, or high-risk work. Keep explicit user profile overrides authoritative and keep classification deterministic. Add regression cases for simple debugging, small architecture review, trading-code review, destructive operations, and live order-submission changes."
```

---

## 9. Simplify the skill workflow now that `dtr_start` is no longer required for installed skill users

The installed DTR skill already communicates the dispatch contract.

Desired distinction:

```text
skill installed
→ normal task can use prepare/run directly

generic MCP client / human discovery
→ dtr_start remains available
```

`dtr_prepare` should become optional for explicit route preview/diagnostics rather than mandatory before every dispatch once normal run validation is sufficient.

Original DTR command:

```bash
dtr pipeline \
  --template implement-review \
  --write \
  --scope packages/codex/skills/dynamic-task-router/SKILL.md,packages/orchestrator/src/mcp.ts,docs/mcp.md,docs/prompt-policy.md \
  --implementation-provider opencode \
  --review-provider antigravity \
  --role implementer \
  --prompt "Simplify skill-driven DTR usage. The installed skill already contains the dispatch contract, so do not require dtr_start before normal Codex delegation. Keep dtr_start for humans and generic MCP clients. Make dtr_prepare optional for route preview, diagnostics, or uncertain scope rather than mandatory before every run. Keep normal dispatch validation inside dtr_run itself and document the shorter workflow."
```

---

# Completion

All Part A fixes (A1–A12) and Part B roadmap steps (1–9) are implemented and
committed on `main`; see the Part A status and Part B status sections above and
the per-step details in `docs/dtr_implementation_record.md`.

```text
2  context planner
3  OpenCode/Agy context transport

4  DtrApplication consolidation
5  MCP lifetime + compact output
6  async MCP dispatch

8  classifier refinement
9  skill simplification
```

Steps 1 and 7 were satisfied by Part A: step 1 by the provider-capability fixes
(A6–A8), step 7 by the reusable-profile fix (A9).
