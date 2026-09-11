# Isolated write workers

Writing is off by default. `implement-review` becomes write-capable with
`--write`, using the entire target workspace as its write boundary. Provide an
optional comma-separated `--scope` allowlist to narrow that boundary:

```sh
npm run dtr -- pipeline --template implement-review --write --scope src/execution,tests/execution --role implementer --prompt "Fix the confirmed state-sync defect and add regression tests"
```

Before the worker starts, DTR verifies the target repository is Git and clean,
then creates the worktree in DTR's private operating-system temporary state
directory on a unique `dtr/<run-id>-<worker-id>` branch. Codex uses
`workspace-write` only in that worktree; Claude uses its edit permission mode
only in that worktree. Ollama is not write-capable. Git necessarily records a
worktree's administrative entry inside the repository's `.git` directory, but
no `.dtr` or untracked working-tree files are created in the target repository.

After the worker, DTR records changed paths and runs `git diff --check`. Any
path outside a supplied scope fails the run and the worktree remains as
evidence. DTR also rejects file deletion/renames and a changed worktree `HEAD`,
so a worker cannot commit its own result. DTR never auto-merges, force-resets
the base checkout, removes a user worktree, or deletes an unsafe worktree
automatically.
