# Dynamic Task Router – Implementation Record

Date: 2026-09-20

This document records exactly what was implemented for each correctness fix
(Part A, A1–A12) and roadmap step (Part B, steps 1–9) executed on top of the
`main` baseline `baba571` ("Make DTR writes in-place by default").

Everything below is shipped in the working tree and verified by the orchestrator
build, the orchestrator and TUI test suites, `dtr evaluate`, and the
`ollama-router` shell check. The commit trail for each item appears in the
"Commit trail" section at the end.

---

## Part A – Correctness fixes

### A1 – Exception-safe write-lock release

`runStage()` in `src/strategies/pipeline.ts` acquired the write lock *before*
entering the `try/finally` that releases it, so a failure between acquisition
and execution (clean-checkout validation, branch/in-place preparation, HEAD
lookup) could strand the lock and block all later write runs.

Changed, in order inside a single `try/finally`:

1. resolve the effective write mode (`options.writeMode ?? (options.branch ? "branch" : "in-place")`),
2. acquire the lock for in-place/branch modes,
3. prepare the target (in-place, branch, or detached isolated worktree),
4. run the worker against the target,
5. verify the write boundary,
6. release the lock in `finally`.

`releaseWriteLock` is now called with the owning `runId` (see A2). Regression
coverage lives in `tests/pipeline-mcp.test.ts` (dirty-checkout, branch-prep
failure, worker failure, verification failure, and success cases all leave no
lock).

### A2 – Atomic and self-healing write lock

`src/worktrees/manager.ts` previously used a "check then write" flow that could
race and could never recover a crashed process's stale lock.

Rewrote `acquireWriteLock()` to:

- create the lock atomically with `writeFile(..., { flag: "wx" })`;
- store `runId`, `pid`, `acquiredAt`, and `repo`;
- on `EEXIST`, read the existing lock, fail closed on malformed or
  structurally invalid lock files, and probe liveness with `process.kill(pid, 0)`;
- recover a visibly stale PID by unlinking and retrying `wx` acquisition, and
  fail safely if re-acquisition races;
- never silently overwrite an active lock.

`releaseWriteLock(cwd, runId)` now verifies the existing lock belongs to the
current run before unlinking. Tests in `tests/worktrees.test.ts` cover first
writer, concurrent rejection, stale-PID recovery, malformed-lock fail-closed,
and expected-run-id release.

### A3 – `--branch` value validation

The generic flag parser turned a bare `--branch` into boolean `true`, which the
pipeline silently ignored and fell back to in-place mode.

`src/cli.ts` (via the pipeline argument path) now fails immediately when
`--branch` is present without a non-empty
string, with `dtr: --branch requires a branch name`. `--isolated` and
`--branch <name>` remain mutually exclusive and validated. Tests in
`tests/cli.test.ts` cover bare `--branch` → fail, `--branch feature/test` →
branch mode, and combined `--isolated --branch` → fail.

Note: `cli.ts` in this batch also carries the later CLI refactor that routes all
commands through `DtrApplication` (see the commit-trail note); the file is
committed at its earliest changing step per the batching rule.

### A4 – Deliberate persistent branch mode

`--branch <name>` no longer runs `git checkout -b` in the current checkout.
`prepareBranchWrite()` in `src/worktrees/manager.ts` now:

- bases the new branch on current `HEAD`;
- creates a separate, persistent worktree;
- keeps the original checkout on its branch, clean, and ahead-of-HEAD untouched;
- rejects an existing/conflicting branch safely;
- preserves worker commit restrictions.

`tests/worktrees.test.ts` verifies the original checkout stays on its branch,
stays clean, does not move HEAD, and that the persistent branch worktree is
inspectable on its own.

### A5 – Detached, branchless isolated mode

`--isolated` previously created `dtr/<run>-<worker>` local branches. It now
creates a temporary detached worktree via `git worktree add --detach <path>
HEAD`, storing mode, worktree path, base HEAD, run ID, and worker ID without
creating any Git branch. `tests/worktrees.test.ts` verifies no new local branch
is created, the base checkout is untouched, write-boundary verification still
runs, and parallel isolated runs remain possible.

### A6 – Provider execution capabilities become authoritative

`src/routing/selector.ts` (`SelectionOptions`) now accepts the provider set and
the requested `writeMode`, and `gateReasons()` derives execution capability
from the provider adapter first (`provider.capabilities()`), falling back to the
shared `getProviderCapabilities()` table in `src/providers/index.ts`.

`requiresTools` now requires `workspaceRead` at the provider level, and write
gating is mode-aware:

- `in-place` → requires model `writeSafe`;
- isolated/branch → allows `worktreeScopedWrite` providers only with an
  explicit non-root scope.

`src/strategies/single.ts` accepts `writeMode` and forwards providers to the
selector. Tests in `tests/routing.test.ts` pin the opted-in worktree
writer only for explicit non-root scope.

### A7 – Correct provider capability values

Every adapter previously claimed `nativeTextAttachments: true` with no
implemented transport. Corrected in `src/providers/`:

- `antigravity.ts`, `claude.ts`, `codex.ts`, `ollama.ts`: `nativeTextAttachments:
  false`; `claude.ts` also `nativeImageAttachments: false`;
- `opencode.ts`: attachments `false`, and the comment saying `--file` was never
  used is removed; the command builder now emits repeated `--file` arguments for
  explicitly selected attachments (delivered as part of roadmap step 3's
  transport; the capability table now matches the adapter).

`tests/providers.test.ts` asserts the corrected booleans and proves
`createOpenCodeCommand` wires `--file` per attachment.

### A8 – Remove execution capabilities from per-model YAML

`config/models.yaml` no longer repeats harness execution facts per model.
Deprecated model-level fields are retained only for configuration
compatibility, and routing ignores them in favor of provider capabilities
(A6). Reduced duplication plus no divergence between provider capabilities and
model records.

### A9 – Reusable model profiles

`src/config.ts` adds `modelProfileSchema`, a raw two-part input schema
(`profiles` + `models` with optional `profile` references), and
`expandModelsConfig()` which deterministically merges profile defaults with
entry overrides (roles, capabilities, limits, cost, privacy, efforts,
default_effort) before validating against the existing expanded `modelsConfigSchema`.

`parseConfig` now routes through `expandModelsConfig`, so effective
`RouterConfig` output is unchanged for fully expanded entries. The repetitive
Antigravity variants in `config/models.yaml` are migrated to a shared profile.
`tests/config.test.ts` pins deterministic expansion and rejects unknown profile
references.

### A10 – Persist and expose write-target metadata

`src/telemetry/run-registry.ts` extends `RunRecord` and stage records with
`writeMode`, `branch`, `cwd`, `baseHead`, `scope`, `changedPaths`, and `checks`.
`runStage()` in `pipeline.ts` populates these on both the stage and the run
record (writing them immediately after target preparation) and prints the
write-target header (`run`, `write mode`, `branch`, `base-head`, `cwd`,
`scope`) plus completion lines (`changed paths`, `checks`) for write stages.

`src/application.ts` returns `runLog` alongside routing and result, and MCP
`dtr_status`/`dtr_outcome` surface the structured record. `tests/
pipeline-mcp.test.ts` asserts persisted metadata for in-place writes, and
`tests/application.test.ts` covers the record lifecycle.

### A11 – Explicit no-op implementation handling

`runStage()` in `pipeline.ts` now fails a write stage when the requested role is
`implementer`, the run made zero changed paths, and `--allow-noop`/
`allowNoop` is not set, with the message "Write stage '…' produced no file
changes (use --allow-noop if no-op is expected)". `cli.ts` exposes
`--allow-noop` and MCP `dtr_pipeline` accepts `allowNoop`.
`tests/pipeline-mcp.test.ts` covers no-op failure, explicit allow-noop success,
and lock release in both paths.

### A12 – Stale documentation and skill contracts

Updated to match in-place-by-default + provider-capability rules:

- `docs/worktrees.md` – in-place / `--isolated` detached / `--branch <name>`
  persistent modes;
- `docs/mcp.md` – write-mode schema and defaults;
- `docs/providers.md` – accurate Antigravity and OpenCode capability sections;
- `docs/opencode.md` – OpenCode write-safety and models guidance;
- `docs/pipelines.md` – example uses `--write --isolated` plus an
  implementation provider;
- `docs/safety.md` – provider capabilities authoritative, no credentials in
  config;
- the `dtr_pipeline` MCP description and the Codex DTR skill
  (`packages/codex/skills/dynamic-task-router/SKILL.md`).

---

## Part B – Roadmap steps

Steps 1 and 7 require no separate work: step 1 (harness vs model capability
split) is delivered by A6–A8, and step 7 (reusable profiles) by A9.

### Step 2 – Context planning replaces raw include-files

`src/context.ts` replaces `appendExplicitFileContext()` with `planContext()`,
a provider-aware planner returning a `ContextPlan`:

- providers with `workspaceRead`/`workspaceSearch` → `path-reference`
  transports only;
- otherwise providers with `nativeTextAttachments` → `attachment` transport;
- otherwise bounded `excerpt` transports within per-file (1,000 char) and total
  (3,000 char) bounds, plus an 8-file limit;
- preserves cwd containment (via `realpath`), traversal rejection, and binary
  detection; returns an empty plan for no files.

`src/types.ts` adds `attachments?: string[]` to `WorkerRequest`.
`src/strategies/single.ts` and `src/strategies/fanout.ts` accept `files`,
build the plan against the selected provider's capabilities, attach files, and
append the excerpt section. `src/application.ts` and `src/strategies/pipeline.ts`
forward `files` end to end. `tests/context.test.ts` pins the three transports,
bounds, traversal/binary rejection, missing files, and the empty-plan case.

### Step 3 – OpenCode attachment transport

`src/providers/opencode.ts` `createOpenCodeCommand()` now emits repeated
`--file <path>` arguments for `request.attachments`, and
`src/providers/index.ts` `DEFAULT_CAPABILITIES.opencode` is updated to
`nativeTextAttachments: true` to match the wired adapter. Ordinary repository
context still flows by workspace path reference (OpenCode has workspace tools),
so `--file` is used only for explicitly selected files. `tests/providers.test.ts`
gains a command-construction test proving `--file` per attachment, and
`docs/opencode.md`/`docs/providers.md` document the transport.

### Step 4 – `DtrApplication` is the single orchestration layer

Verified and completed within each surface's existing entry point:

- CLI (`src/cli.ts`) constructs one `DtrApplication` and routes health, doctor,
  models, opencode-models, run, select, route, fanout, pipeline, status, stats,
  usage, and outcome through it; the raw expert `dtr run` provider path remains
  intentionally isolated;
- MCP (`src/mcp.ts`) and TUI call the same application layer;
- `DtrApplication` is extended with `refreshCatalog()`/`readCatalog()` (moved
  from the CLI), and `config()`/`profile()` are exposed for reuse.

No routing or execution logic is duplicated in `cli.ts`/`mcp.ts`.

### Step 5 – MCP application lifetime and compact output

`src/mcp.ts` maintains a per-cwd `Map<string, DtrApplication>` (`appFor()`), so
active-run state and abort controls are shared across calls instead of creating
a fresh application per call. Added a typed `dtr_abort` tool (idempotent:
`accepted: false` for unknown or finished runs). Success responses return the
run ID, compact route, success/state, and bounded result (output truncated to
1,200 chars) rather than full profiles, rejection maps, and model configuration.

### Step 6 – Asynchronous MCP dispatch

`src/application.ts` splits `run()` into `prepareRun()` (validates, creates the
run record pre-marked `running`, registers an `AbortController`) and
`executeRun()` (routes, runs the worker, persists the outcome, emits lifecycle
events). New `dispatch()` returns `{ runId }` promptly after preparation and
runs the worker in the background. MCP gains `dtr_dispatch` (returns the run ID
plus a guide to poll `dtr_status`/call `dtr_abort`), and `dtr_abort` uses the
shared active-run map. `tests/application.test.ts` adds async tests for prompt
runId return with in-flight background work, and abort of a dispatched run.

### Step 8 – Deterministic classifier refinement

`src/routing/classifier.ts` replaces broad keyword lists with evidence-based
escalation:

- "why" alone → normal; "why" + failure language
  (`fail\w*|error\w*|regression|crash\w*|broken|throw\w*|incorrect|debug\w*`) → difficult;
- "architecture" alone → normal; "redesign"/"cross-cutting"/"all services"/
  "service-wide"/"root cause unknown"/"migration" → extreme;
- "trading"/"financial"/"payment" alone → low risk; paired with a financial
  action (`review|implement|debug|change|modify|fix|bug|incident|outage`) → medium;
- auth/secret/credential/token/password/permission/security/production/deploy/
  live/destructive/delete/migration/order-submission → high;
- explicit user profile overrides remain authoritative.

`tests/classifier.test.ts` pins the regression matrix, and `src/evals.ts` gains
optional `prompt` support with `expect.inferred_complexity`/`inferred_risk` so
the deterministic classifier is exercised end to end. Five new regression cases
added under `evals/cases/` (`isolated-keyword-why`, `small-architecture-review`,
`trading-code-review`, `destructive-operations`, `live-order-submission`);
`dtr evaluate` reports 12/12 pass.

### Step 9 – Simplified skill workflow

`packages/codex/skills/dynamic-task-router/SKILL.md` no longer requires
`dtr_start` before normal dispatch (the installed skill already embeds the
dispatch contract; `dtr_start` remains for humans and skill-less MCP clients),
and it treats `dtr_prepare` as optional (route preview, diagnostics, or
uncertain scope) because ordinary validation runs inside `dtr_run`,
`dtr_dispatch`, and `dtr_pipeline`. It documents `dtr_dispatch`/`dtr_abort` for
long work. `docs/mcp.md` and `docs/prompt-policy.md` describe the shorter
skill-driven workflow and the optional start/prepare round-trips.

---

## Verification

```text
npm run build --workspace=packages/orchestrator   passing
npm run build --workspace=packages/tui            passing
npm test (root run)                               orchestrator 139 + TUI 4, passing
npm run dtr -- evaluate                           12/12 passing
sh -n packages/ollama/bin/ollama-router
sh packages/ollama/bin/ollama-router help          passing
```

## Commit trail

The working tree was committed in batches by step. Batching rule: when multiple
steps changed the same file, the file is committed at the earliest step that
changed it, so later-step changes to that file ride in the earlier commit.

Base: `baba571` ("Make DTR writes in-place by default").

| Step | Commit | Carries also |
| --- | --- | --- |
| Plan | `968828f` | roadmap plan doc + `.gitignore` (env hygiene) |
| A1 | `7774e2f` | later pipeline metadata/no-op/context changes to `pipeline.ts` |
| A2 | `43d463c` | A4 and A5 worktree-mode work in `manager.ts` + `worktrees.test.ts` |
| A3 | `13924b2` | step 4 CLI delegation and A10/A11 CLI behavior in `cli.ts` + `cli.test.ts` |
| A4 | `43d463c` | folded into the A2 batch (first change to `manager.ts`) |
| A5 | `43d463c` | folded into the A2 batch (first change to `manager.ts`) |
| A6 | `a8b3fb0` | step 2 `single.ts` wiring and step 3 `DEFAULT_CAPABILITIES` table |
| A7 | `bc40645` | step 3 OpenCode `--file` transport and capability/caps tests |
| A8 | `a6a4d24` | |
| A9 | `08d1e35` | step 7 (reusable profiles) |
| A10 | `8c2cece` | step 6 `dispatch()` in `application.ts` + `application.test.ts` |
| A11 | `e6e4b1a` | steps 5/6 `mcp.ts` (per-cwd app pool, `dtr_dispatch`, `dtr_abort`) and step 9 tool descriptions |
| A12 | `53f9e59` | step 3 context-transport docs and step 9 skill/docs text |
| B1 | — | satisfied by A6–A8 |
| B2 | `9b4ef2e` | |
| B3 | `bc40645` | OpenCode transport in A7; caps table in `a8b3fb0`; docs in `53f9e59` |
| B4 | `13924b2` | CLI delegation in A3; application extensions in `8c2cece`; `mcp.ts` in `e6e4b1a` |
| B5 | `e6e4b1a` | compact MCP output in A11; skill text in `53f9e59` |
| B6 | `8c2cece` | async dispatch in A10; MCP tools in `e6e4b1a` |
| B7 | `08d1e35` | delivered by A9 |
| B8 | `07b0802` | |
| B9 | `54cbc0c` | `docs/prompt-policy.md`; skill + `docs/mcp.md` text in `53f9e59` |

Because a file is committed at its earliest changing step, some intermediate
commits reference symbols that land in later batches (for example, `single.ts`
in `a8b3fb0` calls `planContext`, which arrives with the B2 batch `9b4ef2e`).
The head-of-branch tree is the fully verified state; intermediate commits are a
canonicalized record of the per-step work, not isolated build checkpoints.