import { describe, expect, it } from 'vitest';
import type { ClawReviewConfig } from '@clawreview/types';

import {
  DEFAULT_RATE,
  bareModelId,
  estimateReviewCost,
  estimateTokens,
  preflightBudget,
  rateForModel,
} from '../src/cost-estimator.js';

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 1234..5678 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,6 @@
 export function authenticate(token: string): boolean {
-  return token === 'admin';
+  if (!token) return false;
+  if (token.length < 8) return false;
+  return verifyHmac(token);
 }
diff --git a/src/util.py b/src/util.py
new file mode 100644
index 0000..abcd
--- /dev/null
+++ b/src/util.py
@@ -0,0 +1,4 @@
+def helper():
+    pass
+
+# trailing
`;

const CONFIG: Pick<ClawReviewConfig, 'agents' | 'ignore' | 'models' | 'review_limits' | 'budget'> = {
  agents: ['security', 'style'],
  ignore: [],
  models: {},
  review_limits: {
    max_changed_lines_per_file: 1500,
    max_patch_bytes_per_file: 256 * 1024,
    include_generated: false,
  },
  budget: { monthly_usd: 50 },
};

describe('bareModelId', () => {
  it('strips a leading provider prefix', () => {
    expect(bareModelId('hermes/claude-opus-4')).toBe('claude-opus-4');
    expect(bareModelId('copilot/gpt-4')).toBe('gpt-4');
  });
  it('passes through unprefixed model ids', () => {
    expect(bareModelId('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(bareModelId('')).toBe('');
  });
});

describe('rateForModel', () => {
  it('returns the published rate for known models regardless of provider prefix', () => {
    expect(rateForModel('hermes/claude-opus-4').inputPer1k).toBe(0.015);
    expect(rateForModel('gpt-4o-mini').outputPer1k).toBe(0.0006);
  });
  it('falls back to DEFAULT_RATE for unknown models', () => {
    expect(rateForModel('totally-fake-model-9000')).toEqual(DEFAULT_RATE);
  });
});

describe('estimateTokens', () => {
  it('rounds up on the ~4 chars/token heuristic', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 2.75 → 3
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
  });
});

describe('estimateReviewCost', () => {
  it('returns zero cost when no agents are configured', () => {
    const est = estimateReviewCost(DIFF, { ...CONFIG, agents: [] });
    expect(est.totalUsd).toBe(0);
    expect(est.byAgent).toEqual([]);
    expect(est.chunks).toBeGreaterThan(0);
  });

  it('returns zero cost when the diff is empty', () => {
    const est = estimateReviewCost('', CONFIG);
    expect(est.chunks).toBe(0);
    expect(est.filesReviewed).toBe(0);
    expect(est.totalUsd).toBe(0);
  });

  it('produces per-agent breakdown with model + chunks + token estimates', () => {
    const est = estimateReviewCost(DIFF, CONFIG);
    expect(est.byAgent.length).toBe(2);
    expect(est.byAgent.map((b) => b.agent).sort()).toEqual(['security', 'style']);
    for (const row of est.byAgent) {
      expect(row.chunks).toBe(est.chunks);
      expect(row.model).toMatch(/^hermes\/claude-opus-4$/);
      expect(row.promptTokens).toBeGreaterThan(0);
      expect(row.completionTokens).toBeGreaterThan(0);
      expect(row.costUsd).toBeGreaterThan(0);
    }
  });

  it('honors per-agent model overrides from config.models', () => {
    const est = estimateReviewCost(DIFF, {
      ...CONFIG,
      models: { security: 'hermes/claude-haiku-3.5' },
    });
    const sec = est.byAgent.find((b) => b.agent === 'security');
    const sty = est.byAgent.find((b) => b.agent === 'style');
    expect(sec?.model).toBe('hermes/claude-haiku-3.5');
    expect(sty?.model).toBe('hermes/claude-opus-4');
    // Haiku is ~19x cheaper than Opus, so the security row should be
    // substantially less than the style row for the same chunks.
    expect(sec!.costUsd).toBeLessThan(sty!.costUsd);
  });

  it('scales output tokens via the configured completionRatio', () => {
    const lo = estimateReviewCost(DIFF, CONFIG, { completionRatio: 0.1 });
    const hi = estimateReviewCost(DIFF, CONFIG, { completionRatio: 0.8 });
    expect(hi.completionTokens).toBeGreaterThan(lo.completionTokens);
    expect(hi.totalUsd).toBeGreaterThan(lo.totalUsd);
  });

  it('adds overheadTokensPerChunk to prompt tokens, increasing cost', () => {
    const lo = estimateReviewCost(DIFF, CONFIG, { overheadTokensPerChunk: 0 });
    const hi = estimateReviewCost(DIFF, CONFIG, { overheadTokensPerChunk: 4000 });
    expect(hi.promptTokens).toBeGreaterThan(lo.promptTokens);
    expect(hi.totalUsd).toBeGreaterThan(lo.totalUsd);
  });

  it('drops files that match the configured ignore globs', () => {
    const est = estimateReviewCost(DIFF, { ...CONFIG, ignore: ['src/util.py'] });
    const baseline = estimateReviewCost(DIFF, CONFIG);
    expect(est.filesReviewed).toBeLessThan(baseline.filesReviewed);
    expect(est.chunks).toBeLessThan(baseline.chunks);
  });
});

describe('preflightBudget', () => {
  it('returns ok when there is no configured budget (treated as unlimited)', () => {
    const res = preflightBudget({
      diffText: DIFF,
      config: { ...CONFIG, budget: { monthly_usd: 0 } },
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('');
    expect(res.limitUsd).toBe(0);
  });

  it('returns ok when estimate + spent stays under the limit', () => {
    const res = preflightBudget({
      diffText: DIFF,
      config: CONFIG, // $50 monthly
      spentUsd: 1,
    });
    expect(res.ok).toBe(true);
    expect(res.estimate.totalUsd).toBeGreaterThan(0);
  });

  it('returns NOT ok with a human reason when projected spend exceeds the limit', () => {
    const res = preflightBudget({
      diffText: DIFF,
      config: { ...CONFIG, budget: { monthly_usd: 0.001 } },
      spentUsd: 0,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/exceed monthly budget/);
    expect(res.reason).toMatch(/\$0\.00/); // limit formatted in the message
  });

  it('clamps a negative spent input to zero rather than crediting the budget', () => {
    const res = preflightBudget({
      diffText: DIFF,
      config: { ...CONFIG, budget: { monthly_usd: 0.001 } },
      spentUsd: -100,
    });
    expect(res.spentUsd).toBe(0);
    expect(res.ok).toBe(false);
  });
});
