# OpenCode provider bridge

Use this bridge when OpenCode already owns the provider configuration and
credentials you want DTR to route through. It is useful for Featherless and
custom OpenAI-compatible providers because DTR calls the `opencode` CLI instead
of reading, duplicating, or storing their credentials.

## Verify discovery

From the same Terminal that will start DTR:

```sh
opencode models
dtr opencode-models
dtr doctor --verbose
```

The first two commands should list the same `provider/model` identifiers. If
OpenCode is callable in Terminal but unavailable to DTR, set this non-secret
path before starting DTR:

```sh
export DTR_OPENCODE_COMMAND="/absolute/path/to/opencode"
```

## Add explicit routing profiles

OpenCode tells DTR what models are configured, but it does not supply DTR's
role score, quality tier, privacy approval, or reliable cost. Do not infer
these from a model name. Instead, create the key-free personal config at the
path shown by `dtr config`; it overlays the cloned registry without modifying
it:

```sh
dtr config
```

Create that file with this content, replacing only `model` with an exact
identifier printed by `dtr opencode-models`:

```yaml
version: 1
models:
  overrides:
    # This Mac cannot run Ollama concurrently with Codex.
    - id: qwen-local
      enabled: false
  additions:
  - id: opencode-featherless-qwen3-32b
    provider: opencode
    family: featherless
    model: featherless/Qwen/Qwen3-32B
    tier: standard
    enabled: true
    local: false
    roles: { architect: 5, implementer: 6, debugger: 6, reviewer: 6, researcher: 7, test: 6, log-analysis: 6 }
    efforts: [low, medium, high]
    default_effort: medium
    capabilities: { tools: true, vision: false, huge_context: false, write_safe: false }
    limits: { context_tokens: 32768 }
    cost: { input_per_million: 0, output_per_million: 0 }
    privacy: { private_code_allowed: false, training_opt_out_required: true }
```

The values above are a conservative advisory template, not a claim about the
model. Set the tier and scores only after you have evaluated the exact model.
Create one profile per model that you want automatic DTR selection to consider.

The personal overlay loads automatically for all commands. Use an explicit
non-secret `DTR_USER_CONFIG` path only if you need a different personal file:

```sh
dtr models
dtr select --provider opencode --role researcher --complexity normal
dtr route --provider opencode --role researcher --task "Summarize the named public error path." --files "src/errors.ts"
```

## Safety boundary

The bridge sends a compact advisory prompt and does not pass `--auto`, but the
current OpenCode CLI does not expose a DTR-verifiable read-only permission mode.
For that reason these profiles must keep `write_safe: false`, and DTR rejects
them from write pipelines. Run advisory tasks only in a trusted checkout or an
isolated worktree. Use `--private-code` or `--no-remote` to exclude them.
