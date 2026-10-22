/**
 * Per-command help and flag validation for the `dtr` CLI.
 *
 * The spec below is the single source of truth for the command surface. It
 * drives `dtr <command> --help`, the generated usage listing, and the
 * unknown-flag check that stops a typo from being silently ignored.
 */
export type FlagSpec = { name: string; value?: string | undefined; description: string };
export type CommandSpec = {
  summary: string;
  usage: string;
  flags: FlagSpec[];
  /** Flags the command recognises but refuses, with its own specific error. */
  rejectedFlags?: string[] | undefined;
  examples?: string[] | undefined;
};

const globalFlags: FlagSpec[] = [
  { name: "cwd", value: "<path>", description: "Target repository (default: current directory)" },
  { name: "config-dir", value: "<path>", description: "Routing configuration directory" },
];

const roleFlag: FlagSpec = { name: "role", value: "<role>", description: "Worker role: architect|implementer|debugger|reviewer|researcher|test|log-analysis" };

const profileFlags: FlagSpec[] = [
  { name: "provider", value: "<provider>", description: "Restrict routing to one provider: claude|codex|ollama|openrouter|featherless|antigravity|opencode" },
  { name: "effort", value: "<level>", description: "Requested reasoning effort: low|medium|high|xhigh|max" },
  { name: "complexity", value: "<level>", description: "Task complexity: trivial|normal|difficult|extreme" },
  { name: "risk", value: "<level>", description: "Task risk: low|medium|high" },
  { name: "diversity", value: "<level>", description: "Required independent families: none|low|medium|high" },
  { name: "context", value: "<level>", description: "Context need: small|medium|large|huge" },
  { name: "prefer-local", description: "Prefer a local model when one is eligible" },
  { name: "local-only", description: "Require a local model" },
  { name: "privacy-sensitive", description: "Require a local, non-training model" },
  { name: "private-code", description: "Require explicit private-code approval" },
  { name: "no-remote", description: "Disallow remote models" },
  { name: "requires-tools", description: "Require workspace tool access" },
];

const taskFlag: FlagSpec = { name: "task", value: "<text>", description: "Compact task objective (at most 100 words)" };
const legacyTaskFlag: FlagSpec = { name: "prompt", value: "<text>", description: "Alias for --task" };
const filesFlag: FlagSpec = { name: "files", value: "<paths>", description: "Comma-separated relative paths inside --cwd (at most 8)" };
const includeFilesFlag: FlagSpec = { name: "include-files", value: "<paths>", description: "Alias for --files" };

export const commandSpecs: Record<string, CommandSpec> = {
  tui: {
    summary: "Open the interactive terminal UI for the target repository.",
    usage: "dtr tui [--cwd <path>]",
    flags: globalFlags,
    examples: ["dtr tui --cwd /path/to/repository"],
  },
  start: {
    summary: "Print the compact dispatch contract. Does not invoke a model.",
    usage: "dtr start",
    flags: [],
    examples: ["dtr start"],
  },
  health: {
    summary: "List provider availability and installed local models.",
    usage: "dtr health [--cwd <path>]",
    flags: globalFlags,
  },
  doctor: {
    summary: "Run safe provider, binary, and authentication diagnostics.",
    usage: "dtr doctor [--verbose] [--cwd <path>]",
    flags: [{ name: "verbose", description: "Print the full per-check report" }, ...globalFlags],
    examples: ["dtr doctor --verbose"],
  },
  config: {
    summary: "Show the non-secret personal configuration overlay path.",
    usage: "dtr config",
    flags: [{ name: "config-dir", value: "<path>", description: "Routing configuration directory" }],
  },
  models: {
    summary: "List the configured model registry with availability.",
    usage: "dtr models [--json] [--refresh]",
    flags: [{ name: "json", description: "Print the registry as JSON" }, { name: "refresh", description: "Refresh the optional catalogue cache" }, ...globalFlags],
    examples: ["dtr models --json", "dtr models refresh"],
  },
  "discover-models": {
    summary: "Compare account-visible catalogues with the configured registry.",
    usage: "dtr discover-models [--refresh] [--cwd <path>]",
    flags: [{ name: "refresh", description: "Refresh cached catalogue metadata" }, ...globalFlags],
  },
  "opencode-models": {
    summary: "List OpenCode's configured catalogue identifiers.",
    usage: "dtr opencode-models [--cwd <path>]",
    flags: globalFlags,
  },
  run: {
    summary: "Run one task against an explicitly chosen provider and model.",
    usage: "dtr run --allow-raw-prompt --provider <provider> --model <model> --role <role> --prompt <text>",
    flags: [
      { name: "allow-raw-prompt", description: "Required expert override for the raw-prompt path" },
      { name: "provider", value: "<provider>", description: "Provider that owns the model" },
      { name: "model", value: "<id>", description: "Configured model id or model name" },
      { name: "include-files", value: "<paths>", description: "Relative paths to inline as bounded excerpts" },
      ...profileFlags,
      roleFlag,
      ...globalFlags,
    ],
    examples: ["dtr run --allow-raw-prompt --provider codex --model codex-terra --role reviewer --prompt \"Review the pipeline. Do not modify anything.\""],
  },
  select: {
    summary: "Dry-run model selection. Never invokes a model.",
    usage: "dtr select --role <role> [--prompt <text>] [profile flags]",
    flags: [{ name: "prompt", value: "<text>", description: "Task text used for classification" }, { name: "model", value: "<id>", description: "Preview one specific model id" }, ...profileFlags, roleFlag, ...globalFlags],
    examples: ["dtr select --role reviewer --complexity difficult --risk high"],
  },
  route: {
    summary: "Route one bounded read-only task to the best eligible model.",
    usage: "dtr route --task <text> [--files path1,path2]",
    flags: [taskFlag, filesFlag, { name: "verbose", description: "Print routing metadata and the run log path" }, ...profileFlags, roleFlag, ...globalFlags],
    rejectedFlags: ["prompt", "include-files"],
    examples: ["dtr route --task \"Find why valid signals never reach order submission\" --files \"src/signals.ts,src/orders.ts\""],
  },
  fanout: {
    summary: "Run the same read-only task through independent model families.",
    usage: "dtr fanout --task <text> [--families <n>]",
    flags: [taskFlag, legacyTaskFlag, { name: "families", value: "<n>", description: "Number of independent families (at least 2)" }, filesFlag, includeFilesFlag, ...profileFlags, roleFlag, ...globalFlags],
    examples: ["dtr fanout --task \"Find why valid signals never reach order submission\" --families 2"],
  },
  pipeline: {
    summary: "Run a named multi-stage pipeline, optionally with a write stage.",
    usage: "dtr pipeline --template <name> --task <text> [--write] [--scope path1,path2]",
    flags: [
      taskFlag, legacyTaskFlag,
      { name: "template", value: "<name>", description: "Pipeline template: debug-review|plan-challenge-review|implement-review" },
      { name: "write", description: "Allow the write stage to change files" },
      { name: "isolated", description: "Write in a temporary detached worktree" },
      { name: "branch", value: "<name>", description: "Write in a persistent named branch worktree" },
      { name: "scope", value: "<paths>", description: "Comma-separated write allowlist" },
      { name: "allow-noop", description: "Accept a write stage that changes nothing" },
      { name: "implementation-provider", value: "<provider>", description: "Provider pinned to the implementation stage" },
      { name: "review-provider", value: "<provider>", description: "Provider pinned to the review stage" },
      filesFlag,
      includeFilesFlag,
      ...profileFlags.filter((flag) => flag.name !== "provider"),
      roleFlag,
      ...globalFlags,
    ],
    rejectedFlags: ["provider"],
    examples: ["dtr pipeline --template implement-review --task \"Add explicit provider capabilities\" --write --scope \"packages/orchestrator/src/types.ts\""],
  },
  runs: {
    summary: "List recent persisted runs for the target repository.",
    usage: "dtr runs [--limit <n>] [--json]",
    flags: [{ name: "limit", value: "<n>", description: "Maximum runs to list (default 20)" }, { name: "json", description: "Print the run list as JSON" }, ...globalFlags],
    examples: ["dtr runs --limit 5"],
  },
  status: {
    summary: "Show one persisted run record.",
    usage: "dtr status --run-id <id> [--json]",
    flags: [{ name: "run-id", value: "<id>", description: "Run id or unique id prefix" }, { name: "json", description: "Print the full run record as JSON" }, ...globalFlags],
    examples: ["dtr status --run-id 1a2b3c4d", "dtr status --run-id 1a2b3c4d --json"],
  },
  evaluate: {
    summary: "Run the routing-policy evaluation cases.",
    usage: "dtr evaluate",
    flags: [{ name: "config-dir", value: "<path>", description: "Routing configuration directory" }],
  },
  stats: {
    summary: "Summarize run states and recorded review outcomes.",
    usage: "dtr stats [--cwd <path>]",
    flags: globalFlags,
  },
  usage: {
    summary: "Summarize provider execution telemetry. Not account quota.",
    usage: "dtr usage [--cwd <path>]",
    flags: globalFlags,
  },
  outcome: {
    summary: "Record the parent review outcome for a completed run.",
    usage: "dtr outcome --run-id <id> --status <status>",
    flags: [
      { name: "run-id", value: "<id>", description: "Run id of the reviewed run" },
      { name: "status", value: "<status>", description: "accepted|rejected|partial|escalated" },
      { name: "findings", value: "<n>", description: "Number of review findings" },
      { name: "score", value: "<0-1>", description: "Manual quality score" },
      { name: "regression", description: "Record that a regression was detected" },
      ...globalFlags,
    ],
    examples: ["dtr outcome --run-id 1a2b3c4d --status accepted"],
  },
};

/** The commands listed in the generated usage summary, grouped for scanning. */
export const commandGroups: Array<{ title: string; entries: Array<{ command: string; note: string }> }> = [
  {
    title: "Getting started",
    entries: [
      { command: "dtr", note: "Open the interactive terminal UI (requires a TTY)" },
      { command: "dtr start", note: "Print the compact dispatch contract; no model call" },
      { command: "dtr doctor [--verbose]", note: "Check provider availability and authentication" },
      { command: "dtr health", note: "List provider availability" },
      { command: "dtr models [--json]", note: "List the configured model registry" },
      { command: "dtr config", note: "Show the non-secret personal configuration overlay" },
    ],
  },
  {
    title: "Running work",
    entries: [
      { command: "dtr route --task <text> [--files p1,p2]", note: "Route one bounded read-only task" },
      { command: "dtr fanout --task <text> [--families <n>]", note: "Run one task through independent families" },
      { command: "dtr pipeline --template <name> --task <text>", note: "Run a named multi-stage pipeline" },
      { command: "dtr select --role <role>", note: "Dry-run selection; never invokes a model" },
      { command: "dtr run --allow-raw-prompt ...", note: "Expert override for a pinned provider and model" },
    ],
  },
  {
    title: "Inspecting results",
    entries: [
      { command: "dtr runs [--limit <n>]", note: "List recent persisted runs" },
      { command: "dtr status --run-id <id>", note: "Show one run record" },
      { command: "dtr stats", note: "Summarize run states and review outcomes" },
      { command: "dtr usage", note: "Summarize provider execution telemetry" },
      { command: "dtr outcome --run-id <id> --status <s>", note: "Record the parent review outcome" },
      { command: "dtr evaluate", note: "Run the routing-policy evaluation cases" },
    ],
  },
];

/** Known flag names for a command, including the global flags every command accepts. */
export function knownFlagsFor(command: string): Set<string> {
  const spec = commandSpecs[command];
  const names = new Set<string>(["help", "h"]);
  for (const flag of spec?.flags ?? []) names.add(flag.name);
  for (const name of spec?.rejectedFlags ?? []) names.add(name);
  for (const flag of globalFlags) names.add(flag.name);
  return names;
}

/** Renders the help text for one command, or the overall usage when unknown. */
export function renderCommandHelp(command: string | undefined, overall: string): string {
  const spec = command ? commandSpecs[command] : undefined;
  if (!spec) return overall;
  const lines = [spec.summary, "", `Usage: ${spec.usage}`];
  if (spec.flags.length) {
    lines.push("", "Options:");
    for (const flag of spec.flags) lines.push(`  --${flag.name}${flag.value ? ` ${flag.value}` : ""}  ${flag.description}`);
  }
  lines.push("  --help  Show this help");
  if (spec.examples?.length) {
    lines.push("", "Examples:");
    for (const example of spec.examples) lines.push(`  ${example}`);
  }
  return lines.join("\n");
}
