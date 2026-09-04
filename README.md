# Dynamic Task Router

An open-source, provider-agnostic multi-model engineering orchestrator with
optional host-specific skills and plugins. It turns cross-cutting work into
bounded routed tasks with explicit ownership, verification, handoff, and
review.

This repository is deliberately easy to fork: each platform package is
self-contained, while `core/` defines the portable behavior they share.

## Executable orchestrator

`packages/orchestrator/` is an explicit, read-only runtime alongside the host
adapters. It uses existing Claude Code, Codex, and Google Antigravity CLI
authentication—never API keys for those account-backed routes—and can invoke
local Ollama models through Codex OSS mode. It selects a model and internal
effort independently, can fan out read-only analysis to independent model
families, and supports optional OpenRouter and Featherless API adapters.
Repository writing stays opt-in and isolated.

```bash
npm install
npm run link:local # once: installs the `dtr` and `dtr-mcp` commands for this checkout
npm run dtr -- health
npm run dtr -- models
npm run dtr -- usage --cwd /path/to/repository
npm run dtr -- models refresh
npm run dtr -- select --role reviewer --complexity difficult --risk high
npm run dtr -- start
npm run dtr -- route --task "Find why valid signals never reach order submission; identify the failing handoff and check its focused test." --files "src/signals.ts,src/orders.ts,test/orders.test.ts"
npm run dtr -- run --allow-raw-prompt --provider codex --model codex-terra --effort high --role reviewer --cwd /path/to/repo --prompt "Review the execution pipeline. Do not modify anything."
```

After `npm run link:local`, run DTR from any repository instead of returning to
this checkout:

```bash
cd /path/to/target-repository
dtr                 # interactive TUI for the current repository
dtr tui --cwd "$PWD" # explicit equivalent
dtr start
dtr route --task "Review the changed execution files for state-sync regressions; run the focused test if available." --files "src/execution.ts,test/execution.test.ts"
```

The router remains installed in this checkout. `--cwd` chooses the target
repository to inspect or run against; DTR does not create `.dtr/` files there.
Optional run metadata and isolated worktrees live under an operating-system
temporary directory instead.
Run `npm unlink -g dynamic-task-router` from this checkout to remove the local
command later.

See [the orchestrator guide](docs/orchestrator.md) and
[routing guide](docs/routing.md). Model inventory and read-only defaults are
user-editable in `config/`; no credentials belong there. See [providers](docs/providers.md),
[free cloud options](docs/free-cloud.md), [privacy](docs/privacy.md), and [cost routing](docs/cost-routing.md) before
enabling a remote provider.

Use [`dtr start`](docs/prompt-policy.md#two-step-compact-dispatch) before a
normal CLI route. It gives a caller the compact dispatch contract; `dtr route`
then enforces its 100-word task limit and accepts file paths only. Use the
[prompt policy](docs/prompt-policy.md) only for small, token-budgeted
provider-specific instructions.

If a local Ollama model cannot coexist with the parent host, use the separate
[sequential Ollama fallback](docs/ollama.md). It is an explicit offline
handoff—never a concurrent route—and unloads the model after the pass by
default.

## Choose an interface

Use DTR in one of three ways: an interactive terminal UI (`dtr` or `dtr tui`
from a TTY), the scriptable CLI (`dtr route ...`), or its local STDIO MCP
server. All three use the same application/routing layer; the terminal UI does
not call provider CLIs or APIs directly. See [TUI guide](docs/tui.md).

## Choose your host

| Host | Package | Routed task type | Guide |
| --- | --- | --- | --- |
| Codex desktop app | `packages/codex/` | Visible subchats | [Codex guide](docs/codex.md) |
| Claude Code | `packages/claude/` | Subagents; optional agent teams | [Claude Code guide](docs/claude-code.md) |
| Qwen Code | `packages/qwen/dynamic-task-router/` | Subagents; routine subagents use the configured fast model | [Qwen Code guide](docs/qwen-code.md) |

Install only the package for the host you use. No package reads or changes
another package.

## Dynamic model routing

When a routing run begins, the parent classifies each candidate task, assumes
`medium` routing level unless specified otherwise, and selects the smallest
permitted tier that can safely complete it: fast, standard, deep, or critical.
`low` may select one cheaper eligible tier; `high` may select one stronger tier.
The host adapter maps that tier to its native subchat or subagent controls. See the shared
[model routing policy](core/model-routing-policy.md) for the decision rules and
host mappings.

### Codex at medium routing level

Medium is the default routing level; it preserves the task-class baseline rather
than forcing every subchat onto one model. Select the model's internal effort
separately from the role and risk. In Codex, that means:

| Task shape | Codex selection |
| --- | --- |
| Narrow read-only triage | Luna / low effort |
| Tightly bounded implementation or review | Luna / high effort |
| Ordinary isolated task | Terra / effort by role |
| Core or cross-cutting task | Terra / normally high effort |
| Critical task or review | Sol / normally high effort |

When Antigravity is available, the same tiers map to its account-visible
catalogue: Flash Low, Flash Medium, Flash High, then Gemini Pro High. Its
Claude models remain deep/critical alternatives rather than defaults. DTR
discovers the models the signed-in account can actually use with `agy models`.
See [providers](docs/providers.md) for the isolation boundary and setup.

Use `low` only when a cheaper tier remains safe, and `high` when a stronger tier
is justified by ambiguity or dependency analysis. Those routing labels do not
set internal effort: a low-level route can use Luna/high for a bounded code
change. Critical tasks never reduce below Sol.

## Shared contract

Every adapter follows the [routing contract](core/routing-contract.md):

1. The parent/lead owns the objective and final decision.
2. Each routed target gets a bounded outcome, non-overlapping write boundary,
   and only the paths/symbols needed to do its work.
3. Returned evidence—not activity or optimism—drives integration.
4. A fresh, read-only reviewer checks the integrated result.
5. Stop and restart actions are honest about what the host actually did.

## Why separate adapters?

The workflow is portable, but host controls are not. Codex uses app-owned
subchats; Claude Code uses subagents and, when explicitly enabled, agent teams;
Qwen Code uses extension commands and subagents. Keeping their instructions
separate lets each be concise, accurate, and safe.

## Repository layout

```text
core/                 Host-neutral contract and scenarios
packages/codex/       Installable Codex plugin
packages/claude/      Installable Claude Code plugin
packages/qwen/        Native Qwen Code extension
packages/ollama/      Optional sequential local-inference fallback
docs/                 Installation and architecture guides
```

## Contributing

Fork freely, make focused changes, validate the relevant package, and open a
pull request. See [CONTRIBUTING.md](CONTRIBUTING.md). The most useful changes
preserve parent ownership, explicit dispatch, and small task I/O contracts.

## License

[MIT](LICENSE)
