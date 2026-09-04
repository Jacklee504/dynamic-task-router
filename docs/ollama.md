# Sequential Ollama fallback

The normal `ollama` adapter is a read-only DTR provider run through Codex OSS
mode. Use this separate wrapper instead when local inference competes for the
same GPU, RAM, or thermal budget as Codex, Claude, or another host. It is a
manual sequential handoff, not an automatically routed concurrent worker.

## Guarantees

- `run` requires `--exclusive`, an explicit confirmation that conflicting hosts
  are paused or closed.
- The model receives one prepared packet on standard input, not repository or
  terminal access.
- Packets use the compact `GOAL`, `SCOPE`, `DO NOT`, `CHECK`, and `RETURN`
  contract. A supplied context file is capped at 16 KiB by default.
- Output is a proposal for the parent to review; it is never applied.
- The model is stopped when the run exits unless `--keep-loaded` is passed.

## Example

From the router checkout, create a dedicated temporary directory for the packet
and result. Curate the source excerpt first; do not pass a transcript or whole
repository.

```bash
dtr_ollama_dir=$(mktemp -d /tmp/dtr-ollama.XXXXXX)

sh packages/ollama/bin/ollama-router packet \
  --role review \
  --goal "Find correctness regressions in the supplied parser excerpt" \
  --scope "Advisory review of parser.ts only" \
  --do-not "Do not assume access to other files or suggest broad rewrites." \
  --check "Parent will run npm test after deciding whether to apply a proposal." \
  --context /path/to/curated-parser-excerpt.txt \
  --output "$dtr_ollama_dir/parser-review.packet"
```

Pause or close the conflicting host, then run one pass and save its response:

```bash
sh packages/ollama/bin/ollama-router run \
  --exclusive \
  --model qwen3.5:9b \
  --packet "$dtr_ollama_dir/parser-review.packet" \
  --output "$dtr_ollama_dir/parser-review.result"
```

Reopen the parent host, inspect the result, apply only any justified change,
and run the named checks. Do not use `--keep-loaded` on a resource-constrained
machine unless you intend to leave Ollama resident.

The wrapper refuses to overwrite packet or result files and exits before
loading a model if `--exclusive`, the model, or the packet is missing.
