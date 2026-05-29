import type { ChatRequest, ChatResponse, LLMProvider } from './types.js';

export interface MockResponse {
  match: (req: ChatRequest) => boolean;
  response: ChatResponse | ((req: ChatRequest) => ChatResponse);
}

export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  private calls: ChatRequest[] = [];

  constructor(private responses: MockResponse[] = []) {}

  push(resp: MockResponse): void {
    this.responses.push(resp);
  }

  get history(): readonly ChatRequest[] {
    return this.calls;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const match = this.responses.find((r) => r.match(req));
    if (!match) {
      return {
        content: '{"findings": []}',
        model: req.model,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }
    return typeof match.response === 'function' ? match.response(req) : match.response;
  }
}
