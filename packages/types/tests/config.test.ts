import { describe, expect, it } from 'vitest';

import { ClawReviewConfigSchema, DEFAULT_CONFIG } from '../src/config.js';

describe('ClawReviewConfigSchema', () => {
  it('returns defaults when given an empty object', () => {
    expect(DEFAULT_CONFIG.agents).toContain('security');
    expect(DEFAULT_CONFIG.severity_threshold).toBe('low');
    expect(DEFAULT_CONFIG.budget.monthly_usd).toBe(50);
  });

  it('rejects an unknown agent', () => {
    const result = ClawReviewConfigSchema.safeParse({ agents: ['mystery'] });
    expect(result.success).toBe(false);
  });

  it('accepts a per-agent model override', () => {
    const result = ClawReviewConfigSchema.parse({ models: { security: 'gpt-4o-mini' } });
    expect(result.models.security).toBe('gpt-4o-mini');
  });

  describe('min_confidence', () => {
    it('defaults to 0 (no floor)', () => {
      expect(DEFAULT_CONFIG.min_confidence).toBe(0);
    });

    it('accepts a value in [0, 1]', () => {
      const r = ClawReviewConfigSchema.parse({ min_confidence: 0.35 });
      expect(r.min_confidence).toBe(0.35);
    });

    it('rejects values outside [0, 1]', () => {
      expect(ClawReviewConfigSchema.safeParse({ min_confidence: -0.1 }).success).toBe(false);
      expect(ClawReviewConfigSchema.safeParse({ min_confidence: 1.5 }).success).toBe(false);
    });

    it('rejects non-numeric values', () => {
      expect(ClawReviewConfigSchema.safeParse({ min_confidence: 'high' }).success).toBe(false);
    });
  });
});
