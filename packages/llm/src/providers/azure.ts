import { OpenAICompatibleProvider } from '../openai-compatible.js';

export interface AzureProviderOptions {
  endpoint: string;
  apiKey: string;
  deployment: string;
}

export function azureProvider(opts: AzureProviderOptions): OpenAICompatibleProvider {
  const baseUrl = opts.endpoint.replace(/\/$/, '') + '/openai/deployments/' + opts.deployment;
  return new OpenAICompatibleProvider({
    name: 'azure',
    baseUrl,
    defaultHeaders: { 'api-key': opts.apiKey },
  });
}
