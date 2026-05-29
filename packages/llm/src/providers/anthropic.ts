import { OpenAICompatibleProvider } from '../openai-compatible.js';

export function anthropicProvider(apiKey: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey,
    defaultHeaders: { 'anthropic-version': '2023-06-01' },
  });
}
