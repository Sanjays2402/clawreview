import type { ChatMessage, ChatResponse, LLMProvider } from './types.js';

export interface JsonChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * Asks a model for JSON and tries hard to recover when the model wraps it in
 * markdown fences or prefixes it with a sentence. Returns parsed object plus
 * raw chat response so callers can record usage and cost.
 */
export async function chatJson<T = unknown>(
  provider: LLMProvider,
  opts: JsonChatOptions,
): Promise<{ value: T; raw: ChatResponse }> {
  const raw = await provider.chat({
    ...opts,
    responseFormat: 'json_object',
  });
  const value = extractJson<T>(raw.content);
  return { value, raw };
}

export function extractJson<T = unknown>(text: string): T {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty LLM response');

  const candidates: string[] = [];
  candidates.push(trimmed);

  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(trimmed)) !== null) {
    if (m[1]) candidates.push(m[1].trim());
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      continue;
    }
  }
  throw new Error('Could not parse JSON from LLM response');
}
