import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { assertCleanGitRepository, createWorktree, verifyWriteBoundary } from "../src/worktrees/manager.js";
import { stateDirectoryFor } from "../src/state.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dtr-worktree-")); directories.push(root, stateDirectoryFor(root));
  await exec("git", ["init", "-b", "main", root]); await exec("git", ["-C", root, "config", "user.email", "test@example.com"]); await exec("git", ["-C", root, "config", "user.name", "DTR Test"]);
  await writeFile(join(root, "README.md"), "initial\n"); await exec("git", ["-C", root, "add", "."]); await exec("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}

describe("isolated worktrees", () => {
  it("creates unique DTR branches without changing the base checkout", async () => {
    const root = await repository(); const first = await createWorktree(root, "run-1", "implement"); const second = await createWorktree(root, "run-2", "implement");
    expect(first.branch).toBe("dtr/run-1-implement"); expect(second.branch).toBe("dtr/run-2-implement");
    expect(first.worktree.startsWith(stateDirectoryFor(root))).toBe(true);
    await expect(access(join(root, ".dtr"))).rejects.toThrow();
    expect((await exec("git", ["-C", root, "branch", "--show-current"])).stdout.trim()).toBe("main");
  });
  it("rejects traversal in worktree identities and write scopes", async () => {
    const root = await repository();
    await expect(createWorktree(root, "../run", "implement")).rejects.toThrow("Invalid run ID");
    const handle = await createWorktree(root, "run-5", "implement");
    await expect(verifyWriteBoundary(handle.worktree, { allowedPaths: ["../outside"] })).rejects.toThrow("Invalid write boundary path");
  });
  it("enforces declared write paths and retains out-of-scope evidence", async () => {
    const root = await repository(); const handle = await createWorktree(root, "run-3", "implement");
    await writeFile(join(handle.worktree, "README.md"), "changed\n");
    await expect(verifyWriteBoundary(handle.worktree, { allowedPaths: ["src"] })).rejects.toThrow("Write boundary violation");
    expect((await exec("git", ["-C", handle.worktree, "status", "--porcelain"])).stdout).toContain("README.md");
  });
  it("allows the workspace root boundary but still refuses environment files", async () => {
    const root = await repository(); const handle = await createWorktree(root, "run-root", "implement");
    await writeFile(join(handle.worktree, "README.md"), "changed\n");
    await expect(verifyWriteBoundary(handle.worktree, { allowedPaths: ["."] }, handle.initialHead)).resolves.toMatchObject({ changedPaths: ["README.md"] });
    await writeFile(join(handle.worktree, ".env.local"), "not allowed\n");
    await expect(verifyWriteBoundary(handle.worktree, { allowedPaths: ["."] }, handle.initialHead)).rejects.toThrow("Write boundary violation");
  });
  it("verifies allowed changes and refuses a dirty base", async () => {
    const root = await repository(); const handle = await createWorktree(root, "run-4", "implement");
    await exec("mkdir", ["-p", join(handle.worktree, "src")]); await writeFile(join(handle.worktree, "src", "worker.ts"), "export {};\n");
    await expect(verifyWriteBoundary(handle.worktree, { allowedPaths: ["src"] })).resolves.toMatchObject({ changedPaths: ["src/worker.ts"], checks: [{ command: "git diff --check", success: true }] });
    await writeFile(join(root, "README.md"), "dirty\n"); await expect(assertCleanGitRepository(root)).rejects.toThrow("uncommitted changes");
  });
  it("rejects deletions and worker-created commits", async () => {
    const root = await repository(); const deleted = await createWorktree(root, "run-6", "implement");
    await exec("rm", [join(deleted.worktree, "README.md")]);
    await expect(verifyWriteBoundary(deleted.worktree, { allowedPaths: ["README.md"] }, deleted.initialHead)).rejects.toThrow("file deletion");

    const committed = await createWorktree(root, "run-7", "implement");
    await writeFile(join(committed.worktree, "README.md"), "changed\n");
    await exec("git", ["-C", committed.worktree, "add", "README.md"]);
    await exec("git", ["-C", committed.worktree, "commit", "-m", "not allowed"]);
    await expect(verifyWriteBoundary(committed.worktree, { allowedPaths: ["README.md"] }, committed.initialHead)).rejects.toThrow("Git commit");
  });
});
