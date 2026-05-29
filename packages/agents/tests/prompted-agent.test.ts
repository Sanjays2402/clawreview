import { MockProvider } from '@clawreview/llm';
import { describe, expect, it } from 'vitest';

import { PromptedAgent } from '../src/prompted-agent.js';
import type { AgentRunInput } from '../src/agent.js';

function makeInput(provider: MockProvider): AgentRunInput {
  return {
    chunk: {
      file: { path: 'src/x.ts', language: 'typescript', hunks: [], isBinary: false, status: 'modified', oldPath: 'src/x.ts', newPath: 'src/x.ts', raw: '' },
      hunks: [],
      startLine: 10,
      endLine: 14,
      body: '@@ -10,2 +10,3 @@\n const a = 1;\n+eval(input);\n const b = 2;',
    },
    config: { agents: ['security'], severity_threshold: 'low', ignore: [], models: {}, budget: { monthly_usd: 50 }, custom_rules: [], max_findings_per_file: 8, comment_style: 'detailed' },
    model: 'hermes/x',
    provider,
  };
}

describe('PromptedAgent JSON validation', () => {
  it('drops findings outside the hunk range', async () => {
    const provider = new MockProvider([
      {
        match: () => true,
        response: {
          model: 'hermes/x',
          content: JSON.stringify({
            findings: [
              { agent: 'security', category: 'security', severity: 'high', title: 'eval', rationale: 'r', file: 'src/x.ts', startLine: 11 },
              { agent: 'security', category: 'security', severity: 'high', title: 'far', rationale: 'r', file: 'src/x.ts', startLine: 99 },
            ],
          }),
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      },
    ]);
    const agent = new PromptedAgent({ name: 'security', description: '', defaultModel: 'hermes/x', systemPrompt: '' });
    const res = await agent.run(makeInput(provider));
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]!.startLine).toBe(11);
  });

  it('returns no findings when JSON is malformed', async () => {
    const provider = new MockProvider([
      { match: () => true, response: { model: 'hermes/x', content: 'not really json', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } },
    ]);
    const agent = new PromptedAgent({ name: 'security', description: '', defaultModel: 'hermes/x', systemPrompt: '' });
    await expect(agent.run(makeInput(provider))).rejects.toThrow();
  });
});
