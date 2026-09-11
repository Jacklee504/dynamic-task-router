import type { ModelConfig } from "./config.js";
import { antigravityCommandCandidates } from "./providers/antigravity.js";
import { openCodeCommandCandidates } from "./providers/opencode.js";
import { codexCommandCandidates, missingHelpFlags } from "./providers/shared.js";
import type { ProcessRunner } from "./types.js";

type Check = { command: string; installed: boolean; authenticated?: boolean; safe?: boolean; missingFlags?: string[]; version?: string };
export type DoctorReport = {
  ready: boolean;
  providers: {
    codex: { ready: boolean; candidates: Check[] };
    claude: Check;
    ollama: { ready: boolean; command: Check; configuredModels: Array<{ id: string; model: string; installed: boolean }> };
    openrouter: { ready: boolean; credentialConfigured: boolean };
    featherless: { ready: boolean; credentialConfigured: boolean };
    antigravity: { ready: boolean; candidates: Check[] };
    opencode: { ready: boolean; candidates: Check[] };
  };
};

const timeoutMs = 5_000;

/** Safe local diagnostics only: no worker prompt, credential content, or auth output. */
export async function diagnoseProviders(
  runner: ProcessRunner,
  models: ModelConfig[],
  cwd: string,
  openRouterCredentialConfigured = Boolean(process.env.OPENROUTER_API_KEY),
  featherlessCredentialConfigured = Boolean(process.env.FEATHERLESS_API_KEY),
): Promise<DoctorReport> {
  const [codex, claude, ollama, antigravity, opencode] = await Promise.all([
    diagnoseCodex(runner, cwd),
    diagnoseClaude(runner, cwd),
    diagnoseOllama(runner, cwd, models),
    diagnoseAntigravity(runner, cwd),
    diagnoseOpenCode(runner, cwd),
  ]);
  const openrouter = { ready: openRouterCredentialConfigured, credentialConfigured: openRouterCredentialConfigured };
  const featherless = { ready: featherlessCredentialConfigured, credentialConfigured: featherlessCredentialConfigured };
  return { ready: codex.ready || (claude.installed && claude.authenticated === true && claude.safe === true) || ollama.ready || openrouter.ready || featherless.ready || antigravity.ready || opencode.ready, providers: { codex, claude, ollama, openrouter, featherless, antigravity, opencode } };
}

/** `opencode models` exposes the configured catalogue without printing auth. */
async function diagnoseOpenCode(runner: ProcessRunner, cwd: string): Promise<{ ready: boolean; candidates: Check[] }> {
  const candidates = await Promise.all(openCodeCommandCandidates().map(async (command) => {
    const version = await checkCommand(runner, command, cwd);
    if (!version.installed) return version;
    const [help, models] = await Promise.all([
      runner.run({ command, args: ["run", "--help"] }, { cwd, timeoutMs }),
      runner.run({ command, args: ["models"] }, { cwd, timeoutMs: 10_000 }),
    ]);
    const required = ["--model", "--variant", "--format", "--dir"];
    const missingFlags = missingHelpFlags(help, required);
    const authenticated = models.exitCode === 0 && models.stdout.split("\n").some((line) => /^\s*[^\s/]+\/[^\s]+/.test(line));
    return { ...version, authenticated, safe: help.exitCode === 0 && missingFlags.length === 0, ...(missingFlags.length ? { missingFlags } : {}) };
  }));
  return { ready: candidates.some((candidate) => candidate.installed && candidate.authenticated && candidate.safe), candidates };
}

async function diagnoseAntigravity(runner: ProcessRunner, cwd: string): Promise<{ ready: boolean; candidates: Check[] }> {
  const candidates = await Promise.all(antigravityCommandCandidates().map(async (command) => {
    const version = await checkCommand(runner, command, cwd);
    if (!version.installed) return version;
    const [help, models] = await Promise.all([
      runner.run({ command, args: ["--help"] }, { cwd, timeoutMs }),
      runner.run({ command, args: ["models"] }, { cwd, timeoutMs: 10_000 }),
    ]);
    const required = ["--model", "--output-format", "--sandbox"];
    const missingFlags = missingHelpFlags(help, required);
    const authenticated = models.exitCode === 0 && models.stdout.split("\n").some((line) => Boolean(line.trim().split(/\s+/)[0]));
    return { ...version, authenticated, safe: help.exitCode === 0 && missingFlags.length === 0, ...(missingFlags.length ? { missingFlags } : {}) };
  }));
  return { ready: candidates.some((candidate) => candidate.installed && candidate.authenticated && candidate.safe), candidates };
}

async function diagnoseCodex(runner: ProcessRunner, cwd: string): Promise<{ ready: boolean; candidates: Check[] }> {
  const candidates = await Promise.all(codexCommandCandidates().map(async (command) => {
    const version = await checkCommand(runner, command, cwd);
    if (!version.installed) return version;
    const [login, help] = await Promise.all([
      runner.run({ command, args: ["login", "status"] }, { cwd, timeoutMs }),
      runner.run({ command, args: ["exec", "--help"] }, { cwd, timeoutMs }),
    ]);
    const required = ["--cd", "--skip-git-repo-check", "--model", "--sandbox", "--ephemeral", "--json"];
    const missingFlags = missingHelpFlags(help, required);
    return { ...version, authenticated: login.exitCode === 0, safe: help.exitCode === 0 && missingFlags.length === 0, ...(missingFlags.length ? { missingFlags } : {}) };
  }));
  return { ready: candidates.some((candidate) => candidate.installed && candidate.authenticated && candidate.safe), candidates };
}

async function diagnoseClaude(runner: ProcessRunner, cwd: string): Promise<Check> {
  const version = await checkCommand(runner, "claude", cwd);
  if (!version.installed) return version;
  const [auth, help] = await Promise.all([
    runner.run({ command: "claude", args: ["auth", "status"] }, { cwd, timeoutMs }),
    runner.run({ command: "claude", args: ["--help"] }, { cwd, timeoutMs }),
  ]);
  const missingFlags = missingHelpFlags(help, ["--permission-mode", "--max-turns"]);
  return { ...version, authenticated: auth.exitCode === 0, safe: help.exitCode === 0 && missingFlags.length === 0, ...(missingFlags.length ? { missingFlags } : {}) };
}

async function diagnoseOllama(runner: ProcessRunner, cwd: string, models: ModelConfig[]): Promise<{ ready: boolean; command: Check; configuredModels: Array<{ id: string; model: string; installed: boolean }> }> {
  const command = await checkCommand(runner, "ollama", cwd);
  const configured = models.filter((model) => model.provider === "ollama" && model.enabled);
  if (!command.installed) return { ready: false, command, configuredModels: configured.map((model) => ({ id: model.id, model: model.model, installed: false })) };
  const listed = await runner.run({ command: "ollama", args: ["list"] }, { cwd, timeoutMs });
  const installed = new Set(listed.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
  const configuredModels = configured.map((model) => ({ id: model.id, model: model.model, installed: listed.exitCode === 0 && installed.has(model.model) }));
  return { ready: listed.exitCode === 0 && configuredModels.some((model) => model.installed), command, configuredModels };
}

async function checkCommand(runner: ProcessRunner, command: string, cwd: string): Promise<Check> {
  const result = await runner.run({ command, args: ["--version"] }, { cwd, timeoutMs });
  if (result.exitCode !== 0) return { command, installed: false };
  const version = result.stdout.split("\n").map((line) => line.trim()).find(Boolean);
  return { command, installed: true, ...(version ? { version: version.slice(0, 160) } : {}) };
}
