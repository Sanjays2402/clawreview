export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
  signal?: AbortSignal;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage: ChatUsage;
  finishReason?: string;
}

export interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface ModelPricing {
  /** USD per 1k prompt tokens. */
  prompt: number;
  /** USD per 1k completion tokens. */
  completion: number;
}

export function estimateCostUsd(usage: ChatUsage, pricing?: ModelPricing): number {
  if (!pricing) return 0;
  return (
    (usage.promptTokens / 1000) * pricing.prompt +
    (usage.completionTokens / 1000) * pricing.completion
  );
}
