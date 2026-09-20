import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WriteBoundary } from "../types.js";
import { stateDirectoryFor } from "../state.js";
import type { WorktreeHandle, WriteMode, WriteVerification } from "./types.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try { const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" }); return stdout; }
  catch (error) { throw new Error(`git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function assertCleanGitRepository(repo: string): Promise<void> {
  await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  const status = await git(repo, ["status", "--porcelain"]);
  if (status.trim()) throw new Error("Refusing write worker: base repository has uncommitted changes");
}

export async function acquireWriteLock(repo: string, runId: string): Promise<string> {
  const lockPath = resolve(stateDirectoryFor(repo), "write-lock.json");
  await mkdir(resolve(lockPath, ".."), { recursive: true, mode: 0o700 });
  if (existsSync(lockPath)) {
    const existing = JSON.parse(await readFile(lockPath, "utf8")) as { runId: string; acquiredAt: string };
    throw new Error(`Concurrent in-place write blocked: run ${existing.runId} holds the lock (acquired ${existing.acquiredAt})`);
  }
  const lock = { runId, acquiredAt: new Date().toISOString() };
  await writeFile(lockPath, JSON.stringify(lock), { mode: 0o600 });
  return lockPath;
}

export async function releaseWriteLock(repo: string): Promise<void> {
  const lockPath = resolve(stateDirectoryFor(repo), "write-lock.json");
  try { await unlink(lockPath); } catch { /* lock may already be released */ }
}

export async function createWorktree(repo: string, runId: string, workerId: string): Promise<WorktreeHandle> {
  assertSafeIdentifier(runId, "run ID");
  assertSafeIdentifier(workerId, "worker ID");
  await assertCleanGitRepository(repo);
  const worktree = resolve(stateDirectoryFor(repo), "worktrees", runId, workerId);
  const branch = `dtr/${runId}-${workerId}`;
  await mkdir(resolve(worktree, ".."), { recursive: true, mode: 0o700 });
  await git(repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  return { branch, worktree, runId, workerId, initialHead: (await git(worktree, ["rev-parse", "HEAD"])).trim(), mode: "isolated" };
}

export async function prepareInPlaceWrite(repo: string, runId: string, workerId: string): Promise<WorktreeHandle> {
  assertSafeIdentifier(runId, "run ID");
  assertSafeIdentifier(workerId, "worker ID");
  await assertCleanGitRepository(repo);
  const branch = (await git(repo, ["branch", "--show-current"])).trim();
  const initialHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { branch, worktree: repo, runId, workerId, initialHead, mode: "in-place" };
}

export async function prepareBranchWrite(repo: string, runId: string, workerId: string, branchName: string): Promise<WorktreeHandle> {
  assertSafeIdentifier(runId, "run ID");
  assertSafeIdentifier(workerId, "worker ID");
  await assertCleanGitRepository(repo);
  const currentBranch = (await git(repo, ["branch", "--show-current"])).trim();
  if (currentBranch === branchName) throw new Error(`Branch '${branchName}' is already checked out`);
  await git(repo, ["checkout", "-b", branchName]);
  const initialHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { branch: branchName, worktree: repo, runId, workerId, initialHead, mode: "branch" };
}

/** Reject out-of-scope changes, deletions, and worker-created commits. */
export async function verifyWriteBoundary(worktree: string, boundary: WriteBoundary, initialHead?: string): Promise<WriteVerification> {
  assertSafeBoundary(boundary);
  if (initialHead && (await git(worktree, ["rev-parse", "HEAD"])).trim() !== initialHead) {
    throw new Error("Write restriction violation: worker created or changed a Git commit");
  }
  const porcelain = await git(worktree, ["status", "--porcelain", "-z"]);
  const entries = porcelain.split("\0").filter(Boolean);
  const destructive = entries.filter((entry) => /[DR]/.test(entry.slice(0, 2))).map((entry) => entry.slice(3).replace(/^.* -> /, ""));
  if (destructive.length) throw new Error(`Write restriction violation: file deletion or rename is not allowed (${destructive.join(", ")})`);
  const tracked = entries.filter((entry) => !entry.startsWith("?? ")).map((entry) => entry.slice(3).replace(/^.* -> /, ""));
  const untracked = (await git(worktree, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  const changedPaths = [...new Set([...tracked, ...untracked])].sort();
  const outside = changedPaths.filter((path) => !isAllowed(path, boundary));
  if (outside.length) throw new Error(`Write boundary violation: ${outside.join(", ")}`);
  const checks = [{ command: "git diff --check", success: true }];
  try { await git(worktree, ["diff", "--check"]); }
  catch { checks[0]!.success = false; throw new Error("Verification failed: git diff --check"); }
  return { changedPaths, checks, boundary };
}

export async function removeDtrWorktree(repo: string, handle: WorktreeHandle): Promise<void> {
  assertSafeIdentifier(handle.runId, "run ID");
  assertSafeIdentifier(handle.workerId, "worker ID");
  if (handle.mode === "in-place" || handle.mode === "branch") return;
  const expected = resolve(stateDirectoryFor(repo), "worktrees", handle.runId, handle.workerId);
  if (resolve(handle.worktree) !== expected || !handle.branch.startsWith(`dtr/${handle.runId}-`)) throw new Error("Refusing to remove a non-DTR worktree");
  await git(repo, ["worktree", "remove", handle.worktree]);
}

function isAllowed(path: string, boundary: WriteBoundary): boolean {
  const normal = path.replace(/^\.\//, "");
  const alwaysForbidden = normal === ".git" || normal.startsWith(".git/") || normal.split("/").some((item) => item.startsWith(".env"));
  const allowed = boundary.allowedPaths.some((item) => item === "." || normal === item || normal.startsWith(`${item.replace(/\/$/, "")}/`));
  const forbidden = boundary.forbiddenPaths?.some((item) => normal === item || normal.startsWith(`${item.replace(/\/$/, "")}/`)) ?? false;
  return allowed && !forbidden && !alwaysForbidden;
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(value)) throw new Error(`Invalid ${label}`);
}

export function assertSafeBoundary(boundary: WriteBoundary): void {
  if (!boundary.allowedPaths.length) throw new Error("Write boundary must declare at least one allowed path");
  for (const path of [...boundary.allowedPaths, ...(boundary.forbiddenPaths ?? [])]) {
    if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`Invalid write boundary path: ${path}`);
  }
}
