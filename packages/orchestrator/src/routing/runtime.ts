import type { ModelConfig, RouterConfig } from "../config.js";
import type { Provider } from "../types.js";
import { OllamaProvider } from "../providers/ollama.js";
import { AntigravityProvider } from "../providers/antigravity.js";
import type { Availability } from "./selector.js";

export async function modelAvailability(
  config: RouterConfig,
  providers: Record<string, Provider>,
): Promise<Availability> {
  const antigravity = providers.antigravity instanceof AntigravityProvider ? await providers.antigravity.availableModels(process.cwd()) : undefined;
  const providerHealth = await Promise.all(Object.entries(providers).map(async ([id, provider]) => [id, id === "antigravity" ? Boolean(antigravity) : await provider.health()] as const));
  const health = Object.fromEntries(providerHealth);
  const availability: Availability = {};
  for (const model of config.models) {
    const provider = providers[model.provider];
    availability[model.id] = Boolean(provider && health[model.provider]);
    if (model.provider === "ollama" && provider instanceof OllamaProvider && availability[model.id]) {
      availability[model.id] = await provider.isModelAvailable(model.model);
    }
    if (model.provider === "antigravity" && availability[model.id]) {
      availability[model.id] = Boolean(antigravity?.has(model.model));
    }
  }
  return availability;
}

export function configuredModel(config: RouterConfig, id: string): ModelConfig {
  const model = config.models.find((item) => item.id === id && item.enabled);
  if (!model) throw new Error(`Configured, enabled model not found: ${id}`);
  return model;
}
