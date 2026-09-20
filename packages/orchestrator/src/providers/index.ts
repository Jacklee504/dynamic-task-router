import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { OllamaProvider } from "./ollama.js";
import { OpenRouterProvider } from "./openrouter.js";
import { FeatherlessProvider } from "./featherless.js";
import { AntigravityProvider } from "./antigravity.js";
import { OpenCodeProvider } from "./opencode.js";
import type { ProcessRunner, Provider, ProviderId } from "../types.js";

export function createProviders(runner: ProcessRunner): Record<ProviderId, Provider> {
  return {
    claude: new ClaudeProvider(runner),
    codex: new CodexProvider(runner),
    ollama: new OllamaProvider(runner),
    openrouter: new OpenRouterProvider(),
    featherless: new FeatherlessProvider(),
    antigravity: new AntigravityProvider(runner),
    opencode: new OpenCodeProvider(runner),
  };
}

const DEFAULT_CAPABILITIES: Record<ProviderId, import("../types.js").ProviderCapabilities> = {
  claude: { workspaceRead: true, workspaceSearch: true, shellAccess: true, nativeTextAttachments: false, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: false },
  codex: { workspaceRead: true, workspaceSearch: true, shellAccess: true, nativeTextAttachments: false, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: true },
  ollama: { workspaceRead: true, workspaceSearch: true, shellAccess: true, nativeTextAttachments: false, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: false },
  openrouter: { workspaceRead: false, workspaceSearch: false, shellAccess: false, nativeTextAttachments: false, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: false },
  featherless: { workspaceRead: false, workspaceSearch: false, shellAccess: false, nativeTextAttachments: false, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: false },
  antigravity: { workspaceRead: true, workspaceSearch: true, shellAccess: true, nativeTextAttachments: false, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: true },
  opencode: { workspaceRead: true, workspaceSearch: true, shellAccess: true, nativeTextAttachments: true, nativeImageAttachments: false, verifiedReadOnlyExecution: true, worktreeScopedWrite: false },
};

export function getProviderCapabilities(id: ProviderId): import("../types.js").ProviderCapabilities {
  return DEFAULT_CAPABILITIES[id];
}

