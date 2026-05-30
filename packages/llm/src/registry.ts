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

  /**
   * Returns the configured base URLs for each provider, useful for /readyz
   * probes. Empty if no providers have been resolved yet.
   */
  endpoints(): Array<{ name: 'hermes' | 'copilot' | 'openai'; baseUrl: string; requiresKey: boolean }> {
    return [
      { name: 'hermes', baseUrl: this.opts.hermesBaseUrl ?? DEFAULT_HERMES, requiresKey: false },
      { name: 'copilot', baseUrl: this.opts.copilotBaseUrl ?? DEFAULT_COPILOT, requiresKey: Boolean(this.opts.copilotApiKey) },
      { name: 'openai', baseUrl: this.opts.openaiBaseUrl ?? 'https://api.openai.com/v1', requiresKey: Boolean(this.opts.openaiApiKey) },
    ];
  }
}

export interface EndpointProbeResult {
  name: string;
  baseUrl: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

/**
 * Probes an OpenAI-compatible endpoint by hitting GET /models with a short
 * timeout. A 401/403 is still considered alive (the endpoint is reachable),
 * since clawreview's readiness only cares about network reachability.
 */
export async function probeEndpoint(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 1500,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }> {
  const url = baseUrl.replace(/\/$/, '') + '/models';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    return { ok: res.status < 500, status: res.status, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
