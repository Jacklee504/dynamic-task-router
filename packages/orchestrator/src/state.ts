import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Runtime state must not alter a target repository. The target path is hashed
 * so usage/history remains separated without leaking the path in the temp name.
 */
export function stateDirectoryFor(target: string): string {
  const identity = createHash("sha256").update(resolve(target)).digest("hex").slice(0, 24);
  return resolve(tmpdir(), "dynamic-task-router", identity);
}
