# Pipelines

Pipelines are explicit stage definitions in `config/pipelines.yaml`, not a
single large prompt. Each stage has a role, a strategy, dependencies, a
read-only setting, and optional diversity request.

Available templates:

- `debug-review`: primary debugger, independent debugger, fresh reviewer.
- `plan-challenge-review`: architect, independent plan challenge, reviewer.
- `implement-review`: implementation, verification, independent review.

```sh
npm run dtr -- pipeline --template debug-review --role debugger --risk high --prompt "Trace why a valid signal fails before order submission"
```

`--provider` applies only to single-worker `route` and `run` commands. A
pipeline may need independent model families, so pin stages only when needed:

```sh
dtr pipeline --template implement-review --write \
  --implementation-provider codex \
  --review-provider antigravity \
  --prompt "Implement the confirmed focused change and return verification evidence"
```

Omit both stage pins for normal automatic routing. A reviewer pin must provide
a model family different from the implementation worker.

Adapters that expose `worktreeScopedWrite` (Antigravity and Codex) can be pinned
as implementation providers only in isolated or branch write mode with an
explicit non-root write scope. They are not native-sandboxed writers: DTR
confines their repository work to a DTR worktree and verifies the diff before
the parent considers it. OpenCode does not expose `worktreeScopedWrite` in this
release. Worktree-scoped adapters are not eligible for the default in-place
write mode.

```sh
dtr pipeline --template implement-review --write --isolated \
  --scope src/router,tests/router \
  --implementation-provider antigravity \
  --review-provider codex \
  --prompt "Implement the confirmed focused change and return verification evidence"
```

A downstream stage receives the objective plus compact evidence from only its
declared dependencies. It never receives full unrelated sibling transcripts.
If a stage requests medium/high diversity, the router excludes the first
dependency’s model family when selecting that fresh stage.

Pipeline completion is never an integration decision. The caller receives the
run ID and stage metadata, then reviews evidence and decides whether to apply a
worktree diff.
