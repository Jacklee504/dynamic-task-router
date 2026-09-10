# AGENTS.md

This repository is a TypeScript npm workspaces monorepo: a provider-agnostic
multi-model engineering orchestrator ("DTR") plus installable host adapters.

## Layout

- `packages/orchestrator/` - deterministic routing, execution, telemetry, the
  `dtr` CLI, and the `dtr-mcp` STDIO MCP server. Most work happens here.
  - `src/providers/` - one provider per configured model backend
    (`codex`, `claude`, `ollama`, `openrouter`, `featherless`, `antigravity`
    via the `agy` CLI, `opencode`).
  - `src/routing/` - classifier, effort selection, model selector, diversity.
  - `src/strategies/` - `single`, `fanout`, `pipeline` execution strategies.
  - `src/telemetry/` - run registry, run logs, usage summaries.
- `packages/tui/` - interactive terminal UI (React/Ink); calls the same
  application layer, never provider CLIs directly.
- `packages/{codex,claude,qwen}/` - installable host adapters (no cross-package
  imports).
- `packages/ollama/` - optional sequential shell fallback for local inference.
- `config/` - user-editable `models.yaml`, `routing-policy.yaml`, pipeline
  templates. No credentials ever belong here.
- `evals/cases/` - routing-policy evaluation cases. Changes that alter routing
  decisions must update these and are run via `dtr evaluate`.
- `core/` and `docs/` - host-neutral contract and design/architecture guides.

## Build, test, and validation

Run these from the repository root; prefer the workspace-scoped variants.

```bash
npm install
npm run build --workspace=packages/orchestrator
npm run test --workspace=@dynamic-task-router/orchestrator
npm run test --workspace=@dynamic-task-router/tui
sh -n packages/ollama/bin/ollama-router && sh packages/ollama/bin/ollama-router help >/dev/null
```

The full dashboard command is `npm test` (orchestrator tests + TUI tests + shell
checks). All code is strictly typed; the build (`tsc -p tsconfig.json` per
package) must pass before running tests.

## Invariants

- Deterministic selection: `selectModel` (in `src/routing/selector.ts`) is the
  single decision point; adding model-scoring logic elsewhere creates drift.
- Read-only by default. Writes require an explicit scope and an isolated
  worktree; never relax this without a pipeline-level `write` gate.
- No credentials in config or the repository. Account-backed providers reuse
  the host CLI's existing authentication; OpenRouter/Featherless read API keys
  from the environment only at dispatch time.
- Safe diagnostics: provider help/version/metadata reads are read-only; a
  missing CLI flag must fail closed, never silently assume safety.
- Provider invocation happens through `ProcessRunner` so tests can fake
  providers; avoid importing real providers into routing tests.

## Conventions

- TypeScript, strict mode, `import type` for type-only imports, one-line
  function bodies in the existing terse style. No new comments beyond what the
  surrounding file already does.
- Tests live next to their subject under `packages/*/tests/` and use vitest.
  Prefer regression tests that pin the behavior being fixed.
- The `phase4.test.ts` quirks: it resolves `config` relative to
  `process.cwd()`, so run the workspace test script rather than running vitest
  from the repository root.

## Claude Code

Claude Code agents should read `CLAUDE.md` in this directory for the global
rules and safety boundaries that apply here.