import { MockProvider } from '@clawreview/llm';
import { ClawReviewConfigSchema } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import { __setLanguageRulesDir } from '../src/language-rules-loader.js';
import { PromptedAgent } from '../src/prompted-agent.js';
import { BACKEND_LANGUAGES, UI_LANGUAGES } from '../src/agents.js';
import type { AgentRunInput } from '../src/agent.js';

const BASE_CONFIG = ClawReviewConfigSchema.parse({});

function makeInput(provider: MockProvider, language: string, path = 'src/x.ts'): AgentRunInput {
  return {
    chunk: {
      file: {
        path,
        language,
        hunks: [],
        isBinary: false,
        status: 'modified',
        oldPath: path,
        newPath: path,
        raw: '',
      },
      hunks: [],
      startLine: 1,
      endLine: 3,
      body: '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n const c = 3;',
    },
    config: BASE_CONFIG,
    model: 'hermes/x',
    provider,
  };
}

function neverCalledProvider(): MockProvider {
  return new MockProvider([
    {
      match: () => true,
      response: {
        model: 'hermes/x',
        content:
          '{"findings": [{"agent":"x","category":"security","severity":"low","title":"should-not-emit","rationale":"r","file":"src/x.ts","startLine":1}]}',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    },
  ]);
}

describe('PromptedAgent preFilter short-circuit', () => {
  it('skips the LLM call entirely when preFilter returns false', async () => {
    __setLanguageRulesDir(null);
    const provider = neverCalledProvider();
    const agent = new PromptedAgent({
      name: 'security',
      description: '',
      defaultModel: 'hermes/x',
      systemPrompt: 'P',
      injectLanguageRules: false,
      preFilter: (input) => input.chunk.file.language === 'typescript',
    });
    const out = await agent.run(makeInput(provider, 'rust'));
    expect(out.findings).toEqual([]);
    expect(out.promptTokens).toBe(0);
    expect(out.completionTokens).toBe(0);
    expect(provider.history).toHaveLength(0);
  });

  it('still invokes the LLM when preFilter returns true', async () => {
    __setLanguageRulesDir(null);
    const provider = new MockProvider([
      {
        match: () => true,
        response: {
          model: 'hermes/x',
          content: '{"findings": []}',
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        },
      },
    ]);
    const agent = new PromptedAgent({
      name: 'security',
      description: '',
      defaultModel: 'hermes/x',
      systemPrompt: 'P',
      injectLanguageRules: false,
      preFilter: (input) => input.chunk.file.language === 'typescript',
    });
    const out = await agent.run(makeInput(provider, 'typescript'));
    expect(out.promptTokens).toBe(5);
    expect(provider.history).toHaveLength(1);
    expect(out.findings).toEqual([]);
  });
});

describe('built-in agent allowlists', () => {
  // Helper to spin up a fresh PromptedAgent with the same preFilter the
  // real built-in carries. We avoid touching the real instance directly
  // (which holds opts privately) by re-declaring the filter inline; the
  // expectation is that this test BREAKS if the allowlist drifts.
  function makeAccessibility(): PromptedAgent {
    return new PromptedAgent({
      name: 'accessibility',
      description: '',
      defaultModel: 'hermes/x',
      systemPrompt: 'P',
      injectLanguageRules: false,
      preFilter: (input) => UI_LANGUAGES.has(input.chunk.file.language ?? ''),
    });
  }

  function makeSqlInjection(): PromptedAgent {
    return new PromptedAgent({
      name: 'sql-injection',
      description: '',
      defaultModel: 'hermes/x',
      systemPrompt: 'P',
      injectLanguageRules: false,
      preFilter: (input) => BACKEND_LANGUAGES.has(input.chunk.file.language ?? ''),
    });
  }

  it('accessibilityAgent skips Go/Rust/Python chunks pre-LLM', async () => {
    __setLanguageRulesDir(null);
    for (const lang of ['go', 'rust', 'python', 'java']) {
      const provider = neverCalledProvider();
      const agent = makeAccessibility();
      const out = await agent.run(makeInput(provider, lang));
      expect(out.findings, `language ${lang}`).toEqual([]);
      expect(provider.history, `language ${lang}`).toHaveLength(0);
    }
  });

  it('accessibilityAgent allowlist matches UI_LANGUAGES exactly', () => {
    for (const lang of ['typescript', 'javascript', 'vue', 'svelte', 'html', 'css', 'scss']) {
      expect(UI_LANGUAGES.has(lang)).toBe(true);
    }
    expect(UI_LANGUAGES.has('go')).toBe(false);
    expect(UI_LANGUAGES.has('python')).toBe(false);
  });

  it('sqlInjectionAgent skips non-backend chunks pre-LLM', async () => {
    __setLanguageRulesDir(null);
    for (const lang of ['html', 'css', 'svelte', 'vue', 'markdown']) {
      const provider = neverCalledProvider();
      const agent = makeSqlInjection();
      const out = await agent.run(makeInput(provider, lang));
      expect(out.findings, `language ${lang}`).toEqual([]);
      expect(provider.history, `language ${lang}`).toHaveLength(0);
    }
  });

  it('sqlInjectionAgent accepts backend languages', () => {
    for (const lang of ['typescript', 'python', 'go', 'java', 'php']) {
      expect(BACKEND_LANGUAGES.has(lang)).toBe(true);
    }
  });

  it('language allowlists do not overlap with obvious noise (unknown/binary)', () => {
    expect(UI_LANGUAGES.has('unknown')).toBe(false);
    expect(UI_LANGUAGES.has('binary')).toBe(false);
    expect(BACKEND_LANGUAGES.has('unknown')).toBe(false);
    expect(BACKEND_LANGUAGES.has('binary')).toBe(false);
  });
});
