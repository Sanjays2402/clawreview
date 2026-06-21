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

  describe('severity_rules drop / confidence matchers', () => {
    it('accepts a rule with min_confidence + max_confidence + drop', () => {
      const r = ClawReviewConfigSchema.parse({
        severity_rules: [
          {
            path: 'vendor/**',
            category: 'style',
            min_confidence: 0,
            max_confidence: 0.4,
            drop: true,
            reason: 'vendored noise',
          },
        ],
      });
      expect(r.severity_rules[0]?.drop).toBe(true);
      expect(r.severity_rules[0]?.max_confidence).toBe(0.4);
    });

    it('accepts a rule with drop alone (no set/bump required)', () => {
      const r = ClawReviewConfigSchema.parse({
        severity_rules: [{ path: '**/*.gen.ts', drop: true }],
      });
      expect(r.severity_rules[0]?.drop).toBe(true);
    });

    it('rejects a rule with neither set nor bump nor drop', () => {
      const r = ClawReviewConfigSchema.safeParse({
        severity_rules: [{ path: '**/*.ts' }],
      });
      expect(r.success).toBe(false);
    });

    it('rejects a rule where min_confidence > max_confidence', () => {
      const r = ClawReviewConfigSchema.safeParse({
        severity_rules: [{ path: '**/*.ts', min_confidence: 0.9, max_confidence: 0.4, drop: true }],
      });
      expect(r.success).toBe(false);
    });

    it('rejects min_confidence / max_confidence outside [0, 1]', () => {
      expect(
        ClawReviewConfigSchema.safeParse({
          severity_rules: [{ path: '**', min_confidence: -0.5, drop: true }],
        }).success,
      ).toBe(false);
      expect(
        ClawReviewConfigSchema.safeParse({
          severity_rules: [{ path: '**', max_confidence: 1.2, drop: true }],
        }).success,
      ).toBe(false);
    });
  });
});
