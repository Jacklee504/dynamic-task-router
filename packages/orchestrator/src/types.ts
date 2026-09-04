export type ProviderId = "claude" | "codex" | "ollama" | "openrouter" | "featherless" | "antigravity";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type WorkerRole =
  | "architect"
  | "implementer"
  | "debugger"
  | "reviewer"
  | "researcher"
  | "test"
  | "log-analysis";

export type Complexity = "trivial" | "normal" | "difficult" | "extreme";
export type RiskLevel = "low" | "medium" | "high";
export type DiversityLevel = "none" | "low" | "medium" | "high";
export type ContextRequirement = "small" | "medium" | "large" | "huge";

export interface TaskProfile {
  role: WorkerRole;
  complexity: Complexity;
  risk: RiskLevel;
  preferLocal: boolean;
  requireLocal: boolean;
  privacySensitive: boolean;
  privateCode?: boolean | undefined;
  allowRemote?: boolean | undefined;
  allowedFamilies?: string[] | undefined;
  allowedProviders?: ProviderId[] | undefined;
  diversity: DiversityLevel;
  contextRequirement?: ContextRequirement;
  requiresTools: boolean;
}

export interface WriteBoundary {
  allowedPaths: string[];
  forbiddenPaths?: string[];
}

export type RunState = "queued" | "running" | "succeeded" | "failed" | "aborted";

export interface PipelineStage {
  id: string;
  role: WorkerRole;
  strategy: "single" | "fanout";
  readOnly: boolean;
  dependsOn?: string[] | undefined;
  diversity?: DiversityLevel | undefined;
  preferredFamilies?: string[] | undefined;
}

export interface PipelineDefinition { id: string; stages: PipelineStage[]; }

export interface SelectionExplanation {
  selected?: string;
  score?: number;
  reasons: string[];
  rejected: Record<string, string[]>;
  degraded?: string;
}

export interface ModelSelection {
  model: string;
  score: number;
  explanation: SelectionExplanation;
}

export interface RoutingMetadata {
  profile: TaskProfile;
  selectedModel: string;
  selection: SelectionExplanation;
  requestedEffort: Effort;
  effectiveEffort: Effort;
  fallbackFrom?: string;
}

export interface WorkerRequest {
  prompt: string;
  cwd: string;
  role: WorkerRole;
  model: string;
  effort: Effort;
  readOnly: boolean;
  writeBoundary?: WriteBoundary;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WorkerResult {
  provider: ProviderId;
  model: string;
  requestedEffort: Effort;
  effectiveEffort?: Effort;
  output: string;
  success: boolean;
  durationMs: number;
  error?: string;
  usage?: TokenUsage;
  providerMetadata?: Record<string, string | number | boolean>;
}

export interface TokenUsage {
  /** Reported by the provider response, never inferred from text length. */
  source: "provider-reported";
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface Provider {
  id: ProviderId;
  health(): Promise<boolean>;
  run(request: WorkerRequest): Promise<WorkerResult>;
}

export interface Command {
  command: string;
  args: string[];
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export interface ProcessRunner {
  run(command: Command, options: { cwd: string; timeoutMs?: number | undefined; signal?: AbortSignal | undefined }): Promise<ProcessResult>;
}
