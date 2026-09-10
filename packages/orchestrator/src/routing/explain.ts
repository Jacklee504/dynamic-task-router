import type { ModelSelection, TaskProfile } from "../types.js";

export function explainSelection(profile: TaskProfile, selection: ModelSelection | undefined, rejected: Record<string, string[]> = {}): Record<string, unknown> {
  return { profile, ...(selection ? { selection: selection.explanation } : { selection: { reasons: [], rejected, degraded: "no eligible model" } }) };
}
