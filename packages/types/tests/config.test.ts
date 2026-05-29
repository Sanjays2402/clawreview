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
});
