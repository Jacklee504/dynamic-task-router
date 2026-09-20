import type { Complexity, DiversityLevel, RiskLevel, TaskProfile, WorkerRole } from "../types.js";

export type ProfileOverrides = Partial<Omit<TaskProfile, "role">> & { role?: WorkerRole };

// One isolated keyword such as "why", "architecture", or "trading" must not
// over-escalate task complexity or risk on its own. Escalation requires
// supporting evidence from the task wording.
const EXTREME_EVIDENCE = /\b(redesign|cross-cutting|all services|service-wide|root cause unknown|migration)\b/i;
const DIFFICULT_EVIDENCE = /\b(debug|regression|failing|investigate|root cause|ambiguous)\b/i;
const WHY_DIFFICULT_SUPPORT = /\b(fail\w*|error\w*|regression|crash\w*|broken|throw\w*|incorrect|debug\w*)\b/i;
const HIGH_RISK_EVIDENCE = /\b(auth|secret|credential|token|password|permission|security|production|deploy|live|destructive|delete|migration|order submission)\b/i;
const CHANGE_RISK_EVIDENCE = /\b(write|modify|change|implementation|bug|incident|fix)\b/i;
const FINANCIAL_DOMAIN = /\b(financial|finance|trading|payment|money)\b/i;
const FINANCIAL_ACTION = /\b(review|implement|debug|change|modify|fix|bug|incident|outage)\b/i;
const LOCAL = /\b(local[- ]only|offline|do not upload|private data)\b/i;

export function classifyTask(prompt: string, role: WorkerRole, overrides: ProfileOverrides = {}): TaskProfile {
  const inferredComplexity: Complexity = EXTREME_EVIDENCE.test(prompt) ? "extreme" : DIFFICULT_EVIDENCE.test(prompt) ? "difficult" : /\bwhy\b/i.test(prompt) && WHY_DIFFICULT_SUPPORT.test(prompt) ? "difficult" : "normal";
  const inferredRisk: RiskLevel = HIGH_RISK_EVIDENCE.test(prompt) ? "high" : CHANGE_RISK_EVIDENCE.test(prompt) || (FINANCIAL_DOMAIN.test(prompt) && FINANCIAL_ACTION.test(prompt)) ? "medium" : "low";
  const inferredLocal = LOCAL.test(prompt);
  return {
    role: overrides.role ?? role,
    complexity: overrides.complexity ?? inferredComplexity,
    risk: overrides.risk ?? inferredRisk,
    preferLocal: overrides.preferLocal ?? false,
    requireLocal: overrides.requireLocal ?? inferredLocal,
    privacySensitive: overrides.privacySensitive ?? inferredLocal,
    privateCode: overrides.privateCode ?? false,
    allowRemote: overrides.allowRemote ?? true,
    ...(overrides.allowedFamilies ? { allowedFamilies: overrides.allowedFamilies } : {}),
    ...(overrides.allowedProviders ? { allowedProviders: overrides.allowedProviders } : {}),
    diversity: overrides.diversity ?? "none",
    ...(overrides.contextRequirement ? { contextRequirement: overrides.contextRequirement } : {}),
    requiresTools: overrides.requiresTools ?? false,
  };
}

export function diversityFromFamilies(families: number): DiversityLevel {
  if (families >= 2) return "medium";
  return "none";
}
