import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WriteBoundary } from "../types.js";
import { stateDirectoryFor } from "../state.js";
import type { WorktreeHandle, WriteVerification } from "./types.js";

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

export async function createWorktree(repo: string, runId: string, workerId: string): Promise<WorktreeHandle> {
  assertSafeIdentifier(runId, "run ID");
  assertSafeIdentifier(workerId, "worker ID");
  await assertCleanGitRepository(repo);
  const worktree = resolve(stateDirectoryFor(repo), "worktrees", runId, workerId);
  const branch = `dtr/${runId}-${workerId}`;
  await mkdir(resolve(worktree, ".."), { recursive: true, mode: 0o700 });
  await git(repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  return { branch, worktree, runId, workerId };
}

export async function verifyWriteBoundary(worktree: string, boundary: WriteBoundary): Promise<WriteVerification> {
  assertSafeBoundary(boundary);
  const porcelain = await git(worktree, ["status", "--porcelain", "-z"]);
  const tracked = porcelain.split("\0").filter(Boolean).filter((entry) => !entry.startsWith("?? ")).map((entry) => entry.slice(3).replace(/^.* -> /, ""));
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
  const expected = resolve(stateDirectoryFor(repo), "worktrees", handle.runId, handle.workerId);
  if (resolve(handle.worktree) !== expected || !handle.branch.startsWith(`dtr/${handle.runId}-`)) throw new Error("Refusing to remove a non-DTR worktree");
  await git(repo, ["worktree", "remove", handle.worktree]);
}

function isAllowed(path: string, boundary: WriteBoundary): boolean {
  const normal = path.replace(/^\.\//, "");
  const allowed = boundary.allowedPaths.some((item) => normal === item || normal.startsWith(`${item.replace(/\/$/, "")}/`));
  const forbidden = boundary.forbiddenPaths?.some((item) => normal === item || normal.startsWith(`${item.replace(/\/$/, "")}/`)) ?? false;
  return allowed && !forbidden;
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
