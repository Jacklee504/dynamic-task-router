import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { OllamaProvider } from "./ollama.js";
import { OpenRouterProvider } from "./openrouter.js";
import { FeatherlessProvider } from "./featherless.js";
import { AntigravityProvider } from "./antigravity.js";
import type { ProcessRunner, Provider, ProviderId } from "../types.js";

export function createProviders(runner: ProcessRunner): Record<ProviderId, Provider> {
  return {
    claude: new ClaudeProvider(runner),
    codex: new CodexProvider(runner),
    ollama: new OllamaProvider(runner),
    openrouter: new OpenRouterProvider(),
    featherless: new FeatherlessProvider(),
    antigravity: new AntigravityProvider(runner),
  };
}
