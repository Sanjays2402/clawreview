import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockProvider } from '@clawreview/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __setLanguageRulesDir } from '../src/language-rules-loader.js';
import { PromptedAgent } from '../src/prompted-agent.js';
import type { AgentRunInput } from '../src/agent.js';

function makeInput(provider: MockProvider, over: Partial<AgentRunInput['chunk']['file']> = {}): AgentRunInput {
  return {
    chunk: {
      file: {
        path: 'src/x.ts',
        language: 'typescript',
        hunks: [],
        isBinary: false,
        status: 'modified',
        oldPath: 'src/x.ts',
        newPath: 'src/x.ts',
        raw: '',
        ...over,
      },
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

function dirWithRules(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'clawreview-prompted-agent-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('PromptedAgent JSON validation', () => {
  beforeEach(() => __setLanguageRulesDir(null));
  afterEach(() => __setLanguageRulesDir(null));

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
    const agent = new PromptedAgent({
      name: 'security',
      description: '',
      defaultModel: 'hermes/x',
      systemPrompt: '',
      // Disable rule injection for this test so the assertion is not
      // sensitive to whichever language sheet ships in the repo.
      injectLanguageRules: false,
    });
    const res = await agent.run(makeInput(provider));
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]!.startLine).toBe(11);
  });

  it('returns no findings when JSON is malformed', async () => {
    const provider = new MockProvider([
      { match: () => true, response: { model: 'hermes/x', content: 'not really json', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } },
    ]);
    const agent = new PromptedAgent({
      name: 'security',
      description: '',
      defaultModel: 'hermes/x',
      systemPrompt: '',
      injectLanguageRules: false,
    });
    await expect(agent.run(makeInput(provider))).rejects.toThrow();
  });
});

describe('PromptedAgent language-rule injection', () => {
  beforeEach(() => __setLanguageRulesDir(null));
  afterEach(() => __setLanguageRulesDir(null));

  it('appends matching <lang>.md to the system prompt when enabled', async () => {
    __setLanguageRulesDir(dirWithRules({ 'typescript.md': '# TS rules\n- no eval' }));
    const provider = new MockProvider([
      { match: () => true, response: { model: 'hermes/x', content: '{"findings": []}', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } },
    ]);
    const agent = new PromptedAgent({
      name: 'security',
      description: '',
      defaultModel: 'hermes/x',
      systemPrompt: 'BASE PROMPT',
    });
    await agent.run(makeInput(provider));
    const systemMsg = provider.history[0]!.messages.find((m) => m.role === 'system')!.content;
    expect(systemMsg).toContain('BASE PROMPT');
    expect(systemMsg).toContain('Language-specific rules');
    expect(systemMsg).toContain('# TS rules');
    expect(systemMsg).toContain('- no eval');
  });

  it('leaves the system prompt untouched when injectLanguageRules is false', async () => {
    __setLanguageRulesDir(dirWithRules({ 'typescript.md': '# TS rules' }));
    const provider = new MockProvider([
      { match: () => true, response: { model: 'hermes/x', content: '{"findings": []}', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } },
    ]);
    const agent = new PromptedAgent({
      name: 'security',
      description: '',
      defaultModel: 'hermes/x',
      systemPrompt: 'BASE PROMPT',
      injectLanguageRules: false,
    });
    await agent.run(makeInput(provider));
    const systemMsg = provider.history[0]!.messages.find((m) => m.role === 'system')!.content;
    expect(systemMsg).toBe('BASE PROMPT');
  });

  it('falls back to the bare system prompt when no rule sheet exists', async () => {
    __setLanguageRulesDir(dirWithRules({}));
    const provider = new MockProvider([
      { match: () => true, response: { model: 'hermes/x', content: '{"findings": []}', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } },
    ]);
    const agent = new PromptedAgent({
      name: 'security',
      description: '',
      defaultModel: 'hermes/x',
      systemPrompt: 'BASE',
    });
    await agent.run(makeInput(provider));
    const systemMsg = provider.history[0]!.messages.find((m) => m.role === 'system')!.content;
    expect(systemMsg).toBe('BASE');
  });

  it('resolves javascript chunks to the typescript rule sheet', async () => {
    __setLanguageRulesDir(dirWithRules({ 'typescript.md': '# TS rules - JS hits this' }));
    const provider = new MockProvider([
      { match: () => true, response: { model: 'hermes/x', content: '{"findings": []}', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } },
    ]);
    const agent = new PromptedAgent({
      name: 'security',
      description: '',
      defaultModel: 'hermes/x',
      systemPrompt: 'BASE',
    });
    await agent.run(makeInput(provider, { language: 'javascript' }));
    const systemMsg = provider.history[0]!.messages.find((m) => m.role === 'system')!.content;
    expect(systemMsg).toContain('# TS rules - JS hits this');
  });
});
