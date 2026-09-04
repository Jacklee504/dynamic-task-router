# Sequential Ollama fallback

Use this package when a local Ollama model cannot coexist with Codex or another
host on the same machine. It creates a bounded, offline packet, then runs one
advisory pass only after you explicitly confirm the conflicting host is paused
or closed.

```bash
sh packages/ollama/bin/ollama-router packet --help
sh packages/ollama/bin/ollama-router run --help
```

The wrapper passes only the supplied packet on standard input. It never grants
Ollama repository access and, by default, unloads the model when the run exits.
See [the sequential Ollama guide](../../docs/ollama.md).
