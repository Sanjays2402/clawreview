import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { LLMProvider } from './types.js';

export interface ProviderRegistryOptions {
  hermesBaseUrl?: string;
  copilotBaseUrl?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  copilotApiKey?: string;
}

export interface ResolvedProvider {
  provider: LLMProvider;
  model: string;
}

const DEFAULT_HERMES = 'http://127.0.0.1:8642/v1';
const DEFAULT_COPILOT = 'http://127.0.0.1:4141/v1';

/**
 * Registry that picks a provider based on a model id. Models prefixed
 * `hermes/` go to the local Hermes agent; `copilot/` go to the github-copilot
 * proxy; anything else goes to a generic OpenAI-compatible endpoint.
 */
export class ProviderRegistry {
  private hermes?: LLMProvider;
  private copilot?: LLMProvider;
  private openai?: LLMProvider;

  constructor(private opts: ProviderRegistryOptions = {}) {}

  resolve(model: string): ResolvedProvider {
    if (model.startsWith('hermes/')) {
      this.hermes ??= new OpenAICompatibleProvider({
        name: 'hermes',
        baseUrl: this.opts.hermesBaseUrl ?? DEFAULT_HERMES,
      });
      return { provider: this.hermes, model: model.slice('hermes/'.length) };
    }
    if (model.startsWith('copilot/')) {
      this.copilot ??= new OpenAICompatibleProvider({
        name: 'copilot',
        baseUrl: this.opts.copilotBaseUrl ?? DEFAULT_COPILOT,
        apiKey: this.opts.copilotApiKey,
      });
      return { provider: this.copilot, model: model.slice('copilot/'.length) };
    }
    this.openai ??= new OpenAICompatibleProvider({
      name: 'openai',
      baseUrl: this.opts.openaiBaseUrl ?? 'https://api.openai.com/v1',
      apiKey: this.opts.openaiApiKey,
    });
    return { provider: this.openai, model };
  }
}
