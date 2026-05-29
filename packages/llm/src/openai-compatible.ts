import { RateLimiter } from './rate-limit.js';
import { withRetry } from './retry.js';
import type { ChatRequest, ChatResponse, LLMProvider } from './types.js';

export interface OpenAIProviderOptions {
  baseUrl: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  /** Requests per second cap. */
  rps?: number;
  fetch?: typeof fetch;
  name?: string;
}

interface OpenAIResponseShape {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason?: string;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private limiter: RateLimiter;
  private fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAIProviderOptions) {
    this.name = opts.name ?? 'openai-compatible';
    this.limiter = new RateLimiter(Math.max(opts.rps ?? 5, 1), opts.rps ?? 5);
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    await this.limiter.acquire();
    return withRetry(async () => {
      const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: req.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          ...(this.opts.defaultHeaders ?? {}),
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? 1500,
          ...(req.responseFormat === 'json_object'
            ? { response_format: { type: 'json_object' } }
            : {}),
        }),
      });

      if (!res.ok) {
        const text = await safeText(res);
        const err = new Error(`LLM ${this.name} request failed: ${res.status} ${res.statusText} ${text}`);
        (err as { status?: number }).status = res.status;
        throw err;
      }

      const json = (await res.json()) as OpenAIResponseShape;
      const choice = json.choices?.[0];
      if (!choice) throw new Error('LLM response missing choices');
      return {
        content: choice.message?.content ?? '',
        model: json.model ?? req.model,
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          totalTokens: json.usage?.total_tokens ?? 0,
        },
        finishReason: choice.finish_reason,
      };
    });
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
