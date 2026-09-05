# Orchestrator runtime

Phase 2 adds deterministic model selection and read-only fan-out to the
runtime at `packages/orchestrator/`. The existing Codex, Claude Code, and Qwen
packages remain host adapters.

## Setup

```bash
npm install
npm run build
npm test
```

The runtime uses the installed, authenticated `claude`, `codex`, and optional
account-backed `agy` (Google Antigravity) CLIs. Its
health check uses their auth-status commands without printing their output. It
does not read environment files. Local Ollama tasks run via Codex OSS mode and
never pull a missing model. The optional OpenRouter adapter reads a process
credential only when the user has explicitly enabled an OpenRouter model; see
[providers](providers.md).

## Commands

```bash
npm run dtr -- health
npm run dtr -- doctor --verbose
npm run dtr -- models
npm run dtr -- models refresh
npm run dtr -- select --role reviewer --complexity difficult --risk high
npm run dtr -- start
npm run dtr -- route --task "Find why valid signals never reach order submission; identify the failing handoff and check its focused test." --files "src/signals.ts,src/orders.ts,test/orders.test.ts"
npm run dtr -- fanout --families 2 --role debugger --risk high --prompt "Find why valid signals never reach order submission"
npm run dtr -- run --allow-raw-prompt --provider ollama --model qwen-local --role reviewer --cwd /path/to/repo --prompt "Inspect the README. Do not modify anything."
npm run dtr -- evaluate
npm run dtr -- stats
npm run dtr -- usage --cwd /path/to/repo
```

`dtr start` prints the compact dispatch contract without a model call. `dtr route`
accepts a 100-word `--task` and optional `--files` path list, then selects one
target. `dtr select` is dry-run only. `dtr fanout`
selects independent families. `--model` accepts a configured model ID
(recommended) or configured model name for an explicit direct run. Executions
are read-only where the host provides a verified read-only mode. Antigravity is
advisory-only: it runs sandboxed but has no verified read-only mode, so use a
trusted checkout or worktree. Each execution writes metadata only—never the
prompt or response—to DTR's private, per-target operating-system temporary
directory; the target repository is not modified by DTR itself.

## Configuration

Personal enablement and model-profile changes belong in the key-free
[personal configuration overlay](user-config.md), not in a target repository.

## Readiness and fallback

`dtr doctor --verbose` is the full no-inference diagnostic: use it after a
login, installation, subscription change, or provider configuration change.
Each routed task then performs a lightweight preflight only for the selected
provider/model. Successful checks are cached for two minutes in DTR's
operating-system temporary state; failed checks are never cached.

If an automatically selected model fails preflight, DTR tries the next eligible
configured model and records `selected-model preflight failed` plus
`fallbackFrom` in the route metadata. An explicitly pinned model never silently
falls back. DTR does not send automatic “reply yes” probes because those consume
quota and may wake local inference.

Two provider failures within five minutes open a temporary two-minute circuit.
While open, the provider is rejected before selection and the reason appears in
route metadata. No prompt, output, or error text is stored; a successful run
clears its reliability record.

Edit `config/models.yaml` to declare enabled models, model families, quality
tiers, role-score priors, capabilities, and supported effort values. Edit
`config/routing-policy.yaml` for effort, diversity, timeout, and safety policy.
`defaults.timeoutMs` is the total allowed worker runtime—not merely response
generation—and defaults to 10 minutes. Health checks remain short (5 seconds).
This configuration contains selectors and priors, not credentials. See
[`docs/model-selection.md`](model-selection.md) for the scoring contract.

`limits`, `cost`, and `privacy` are eligibility metadata. They are maintained
manually and never rewritten by a routing run, catalog refresh, evaluation, or
stats command. Record a reviewed outcome with `dtr outcome`; `dtr stats` may
recommend inspecting priors after 20 manual outcomes, but it never changes
configuration.

`dtr usage` summarizes DTR's persisted execution metadata for every provider,
including run counts and real token/cost figures only when the provider returned
them. It is not an account-balance command: DTR does not scrape Codex or Claude
subscription pages, nor query hosted-provider balances.

## Compatibility behavior

The runtime checks CLI help before every execution and refuses a provider when
required read-only flags are absent. Current Codex releases do not expose the
historical `--ask-for-approval never` flag on `codex exec`; the runtime relies
on its supported `--sandbox read-only` mode and does not silently remove that
safety constraint. Claude runs use non-interactive print mode with plan
permissions and no session persistence.
