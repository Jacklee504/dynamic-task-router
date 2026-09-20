# Write modes and worktrees

Writing is off by default. `implement-review` becomes write-capable with `--write`, defaulting to in-place edits on the current clean checkout.

DTR supports three write modes:

1. **Default (In-place)**: Writes directly to the current checkout with atomic write-lock enforcement (`write-lock.json`) to prevent concurrent writer collisions. The repository must be clean before starting.
2. **Isolated (`--isolated`)**: Creates a temporary detached worktree (`git worktree add --detach <path> HEAD`) in DTR's private temporary state directory. No temporary branches are created.
3. **Branch (`--branch <name>`)**: Creates a persistent named branch in a separate worktree without switching or altering the user's base checkout.

Provide an optional comma-separated `--scope` allowlist to narrow the write boundary:

```sh
npm run dtr -- pipeline --template implement-review --write --scope src/execution,tests/execution --role implementer --prompt "Fix the confirmed state-sync defect and add regression tests"
```

Before the worker starts, DTR verifies the target repository is Git and clean, acquires locks or prepares the worktree, and prints execution metadata:

```text
dtr: run=<id>
dtr: write mode=<in-place|isolated|branch>
dtr: branch=<name|detached>
dtr: base-head=<sha>
dtr: cwd=<path>
dtr: scope=<allowed-paths>
```

After the worker completes, DTR records changed paths and runs `git diff --check`. Any path outside a supplied scope fails the run. DTR also rejects file deletions/renames and worker-created Git commits. By default, write implementation stages that produce no file changes are rejected unless `--allow-noop` is explicitly specified.
