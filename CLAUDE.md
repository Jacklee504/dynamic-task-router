# CLAUDE.md (Claude Code)

Read `AGENTS.md` in this repository for the workspace layout, build and test
commands, invariants, and coding conventions before making changes.

Global safety boundaries: treat configured safety hooks as hard boundaries;
never bypass, weaken, or work around them. Reviews and routing commits must
not add AI/contributor attribution. Writes require an explicit scope and an
isolated worktree. Never place credentials in `config/` or the repository.

Respect the read-only-by-default invariant: provider help/version/metadata
reads are safe diagnostics; a missing CLI flag must fail closed rather than
silently assume safety.