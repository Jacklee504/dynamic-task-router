# Architecture

## Executable runtime

`packages/orchestrator/` is a host-neutral local service layer. Codex or Claude
Code can lead through its STDIO MCP server; provider adapters remain behind the
router. The runtime performs deterministic selection, read-only fan-out,
metadata-only telemetry, explicit pipelines, and opt-in isolated worktrees.
Runtime state is outside the target repository in a private, per-target
operating-system temporary directory.

```text
TUI / CLI / Codex / Claude Code / MCP client
             │
             ▼
     Dynamic Task Router application API
             │
             ▼
      MCP and CLI adapters
       ├── Claude adapter
       ├── Codex adapter
       ├── local Ollama adapter
       ├── Antigravity CLI adapter (account-backed, optional)
       ├── OpenCode CLI adapter (configured-provider bridge, optional)
       ├── OpenRouter adapter (optional, disabled by default)
       └── Featherless adapter (optional process credential)
```

The lead retains planning, integration, and final approval. See
[MCP](mcp.md), [pipelines](pipelines.md), [worktrees](worktrees.md), and
[providers](providers.md).

The [sequential Ollama fallback](ollama.md) sits outside this runtime path. It
is for resource-constrained machines: the parent prepares a bounded packet,
the user pauses or closes the conflicting host, Ollama returns an advisory
result, and the parent later reviews it. It is never selected as a concurrent
adapter.

`core/` is the source of truth for behavior and model-tier selection. Platform
packages are adapters, not forks of the workflow:

```text
core contract
   ├── Codex: parent → visible subchat → parent
   ├── Claude: lead → subagent → lead
   └── Qwen: parent → subagent → parent
```

Keep adapter instructions host-specific and task-local. Keep common rules in
the core. Do not make subchat or subagent prompts carry the entire core
document: they receive only goal, scope, named paths/symbols, non-goals, check,
and return contract. The parent does not copy child transcripts into its own
context; it retains one compact decision record and structured evidence only.

The [model routing policy](../core/model-routing-policy.md) classifies routed
tasks as fast, standard, deep, or critical, then applies a low/medium/high
routing-level adjustment. Each adapter maps those abstract tiers to host-native
models and controls, and selects model effort independently by role where the
host permits it; it must report an unavailable tier instead of silently choosing
a cheaper one.

Claude agent teams are an explicit extension of the Claude adapter, not the
default. They are appropriate only when independent subagents need peer-to-peer
coordination.

Qwen's native adapter uses user-configured model grades or its `fast` selector.
It never ships a provider credential or hard-coded model ID. The parent owns
integration and retains tasks that require an unavailable deep or critical
grade.
