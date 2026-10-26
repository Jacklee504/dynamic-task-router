# Releasing packages

## Local validation

Validate the Codex skill from the repository root when Python has PyYAML
installed and the standard Codex skill-creator is available:

```bash
python3 "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" packages/codex/skills/dynamic-task-router
```

Validate Claude locally with `claude plugin validate ./packages/claude` when the
Claude CLI is available. Validate Qwen's JSON manifest with `python3 -m json.tool
packages/qwen/dynamic-task-router/qwen-extension.json` and forward-test it
with `qwen extensions install ./packages/qwen/dynamic-task-router --scope
project` when Qwen Code is available. Test route, status, safe abort, and
independent review; never use production systems.

Validate the sequential Ollama wrapper without loading a model:

```bash
sh -n packages/ollama/bin/ollama-router
sh packages/ollama/bin/ollama-router help
```

Forward-test a packet and one local-model run only when the parent host is not
using the same machine resources.

## Versioning

Use semantic versioning in each package manifest.

- Patch: documentation, wording, and non-behavioral corrections.
- Minor: new safe workflow behavior or compatible capability support.
- Major: changed safety guarantees, lifecycle semantics, or compatibility.

## Publishing

1. Create a tagged GitHub release from a validated commit.
2. Release `packages/codex/`, `packages/claude/`, and
   `packages/qwen/dynamic-task-router/` as separate package roots; distribute
   `packages/ollama/` as a source wrapper.
3. Submit each package through its host’s current plugin distribution channel.
4. Test each installed package in a fresh host session.

Do not claim marketplace availability until the package has actually been
accepted and published.
