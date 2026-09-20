import type { WriteBoundary } from "../types.js";

export type WriteMode = "in-place" | "isolated" | "branch";

export interface WorktreeHandle {
  branch: string;
  worktree: string;
  runId: string;
  workerId: string;
  /** Immutable starting commit; used to reject worker-created commits. */
  initialHead: string;
  mode: WriteMode;
}

export interface WriteVerification {
  changedPaths: string[];
  checks: Array<{ command: string; success: boolean }>;
  boundary: WriteBoundary;
}
