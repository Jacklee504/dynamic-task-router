# Prompt policy and token budgets

## Two-step compact dispatch

The normal CLI route is deliberately a two-step protocol for people and host
agents:

```sh
dtr start                         # no model call; prints the contract
dtr route --task "<compact task>" --files "src/a.ts,test/a.test.ts"
```

`dtr start` returns a fixed contract that tells the caller to send one task of
at most 100 words: the outcome, essential facts, constraints, and desired
check. `--files` is optional and contains at most eight relative file paths.
It is a path list, not file content. DTR rejects absolute/traversal paths,
oversized task text, `--prompt`, and `--include-files` on this normal route
before any provider is called.

The worker receives a normalized task packet and must return only `STATUS`,
`PATHS`, `CHECK`, and `RISK`, capped at 120 words and 1,200 characters. This
keeps a caller's routing explanation, parent reasoning, pasted source, raw
logs, or transcript out of worker context and the handoff. The file list is an
initial inspection boundary; a provider may read a direct dependency when
necessary, but must name it in `PATHS`.

`dtr run --allow-raw-prompt …` remains available for a deliberately manual,
explicit-model invocation. It is an expert escape hatch and retains the larger
raw-prompt bound. Do not use it for normal automated dispatches.

## Provider additions and token budget

DTR can append small, provider-specific task instructions after the task
objective and before its compact return contract. This is useful for a
provider-specific preflight, but it is not a place to paste a project guide or
general transcript.

Configure it in `config/routing-policy.yaml`:

```yaml
prompt:
  charsPerToken: 4
  maxInputTokens: 600
  responseReserveTokens: 384
  hostContextReserveTokens:
    claude: 1200 # optional allowance for known host-injected project guidance
  providers:
    claude:
      append:
        - "Before starting, follow any applicable CLAUDE.md instructions in the target repository."
```

`append` accepts at most three entries of 400 characters each. DTR estimates
the composed prompt with the configured `charsPerToken` value and rejects a
dispatch when it exceeds the smaller of `maxInputTokens` and the selected
model's context after `responseReserveTokens` and the provider's optional host
reserve. It does not silently truncate a task or policy instruction.

The estimate covers DTR's own prompt only. DTR intentionally does not read
`CLAUDE.md`, `AGENTS.md`, environment files, or other host-injected context to
measure them. Use `hostContextReserveTokens` as a conservative allowance when
such context is material.

Claude Code normally discovers applicable `CLAUDE.md` files on its own. Leave
the Claude `append` list empty unless you specifically want an additional
reminder or workflow rule; an unnecessary reminder still consumes input tokens.

## Explicit file context

Expert raw-prompt commands can attach selected reference files without giving
DTR a repository scan:

```sh
dtr run --allow-raw-prompt --cwd /path/to/repo --provider codex --model codex-terra --role debugger \
  --prompt "Explain the failing parser test" \
  --include-files src/parser.ts,test/parser.test.ts
```

`--include-files` accepts at most five regular files beneath `--cwd`, each up
to 1,000 characters and 3,000 characters in total. It rejects a symlink whose
target leaves that directory, binary inputs, and oversize files rather than
silently truncating them. The final composed prompt is still checked against
the model-specific token budget. File content is labelled as reference material
so it cannot override the task contract. No files are included unless the user
names them explicitly.
