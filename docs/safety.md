# Runtime safety

Read-only is the default for every provider and every fan-out task. The router
fails closed on local-only, privacy, capability, reasoning-risk, model-family,
and write-boundary constraints.

Every routed prompt also carries a compact baseline restriction contract:

- no `rm`, `rmdir`, `unlink`, or recursive deletion;
- no Git `commit`, `push`, `reset`, `clean`, `checkout`, `merge`, or `rebase`;
- no secret/auth/global-configuration changes, package installs, or network installs;
- no file delete or rename, even in an approved write scope.

This is a default restriction, not a grant of authority. Codex receives its
native read-only/workspace-write sandbox and Claude receives plan/edit mode.
For CLIs without a command allowlist, the prompt restriction is defence in
depth; their only write-capable path remains DTR's isolated worktree. DTR then
rejects an out-of-scope path, deletion, malformed diff, or changed Git `HEAD`.
It never auto-commits, pushes, merges, or cleans up a failed worktree.

Write access needs all of: an explicit write pipeline request, a clean Git base,
a single stage owner, an allowed path list, and post-run path verification.
The write target is the current checkout by default (in-place), a temporary
detached worktree with `--isolated`, or a persistent branch worktree with
`--branch`. In-place mode requires a `write_safe` model; isolated or branch
mode also allows an adapter that exposes `worktreeScopedWrite` (Antigravity
and Codex) together with an explicit non-root scope. That adapter capability
never makes the provider private-code approved nor eligible for in-place
writes. It is never available through a raw MCP command or arbitrary CLI
flags.

Run records contain routing and execution metadata, not prompt/output bodies or
environment values. A failed/unknown process is not reported as aborted; abort
control is intentionally not exposed in this release.
