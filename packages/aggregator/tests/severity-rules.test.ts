import type { ClawReviewConfig, Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import { applySeverityRules, bumpSeverity } from '../src/severity-rules.js';

function f(over: Partial<Finding> = {}): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'low',
    title: 'X',
    rationale: 'r',
    file: 'src/billing/charge.ts',
    startLine: 1,
    confidence: 0.7,
    tags: [],
    ...over,
  } as Finding;
}

function cfg(
  rules: ClawReviewConfig['severity_rules'],
): Pick<ClawReviewConfig, 'severity_rules'> {
  return { severity_rules: rules };
}

describe('bumpSeverity', () => {
  it('escalates with negative delta and clamps at critical', () => {
    expect(bumpSeverity('low', -1)).toBe('medium');
    expect(bumpSeverity('critical', -1)).toBe('critical');
  });
  it('de-escalates with positive delta and clamps at nit', () => {
    expect(bumpSeverity('low', 1)).toBe('nit');
    expect(bumpSeverity('nit', 5)).toBe('nit');
  });
});

describe('applySeverityRules', () => {
  it('is a no-op when no rules configured', () => {
    const res = applySeverityRules([f()], cfg([]));
    expect(res.applied).toEqual([]);
    expect(res.findings[0].severity).toBe('low');
  });

  it('escalates findings under a sensitive path glob', () => {
    const res = applySeverityRules(
      [f(), f({ file: 'src/util/math.ts' })],
      cfg([{ path: 'src/billing/**', bump: -2, reason: 'PCI scope' }]),
    );
    expect(res.findings[0].severity).toBe('high');
    expect(res.findings[1].severity).toBe('low');
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].from).toBe('low');
    expect(res.applied[0].to).toBe('high');
    expect(res.findings[0].tags).toContain('severity-rule:0:pci-scope');
  });

  it('respects absolute set: severity over bump', () => {
    const res = applySeverityRules(
      [f({ severity: 'nit' })],
      cfg([{ path: '**/*.ts', set: 'critical', bump: 1, reason: 'override' }]),
    );
    expect(res.findings[0].severity).toBe('critical');
  });

  it('uses first matching rule only', () => {
    const res = applySeverityRules(
      [f()],
      cfg([
        { path: 'src/billing/**', set: 'high' },
        { path: '**/*.ts', set: 'nit' },
      ]),
    );
    expect(res.findings[0].severity).toBe('high');
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].ruleIndex).toBe(0);
  });

  it('filters by agent and category', () => {
    const res = applySeverityRules(
      [f({ agent: 'style', category: 'style' }), f()],
      cfg([{ path: '**/*.ts', agent: 'security', category: 'security', bump: -1 }]),
    );
    expect(res.findings[0].severity).toBe('low');
    expect(res.findings[1].severity).toBe('medium');
  });

  it('records no-op matches without mutating tags', () => {
    const res = applySeverityRules(
      [f({ severity: 'critical' })],
      cfg([{ path: '**/*.ts', bump: -3 }]),
    );
    expect(res.findings[0].severity).toBe('critical');
    expect(res.findings[0].tags).toEqual([]);
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].from).toBe(res.applied[0].to);
  });
});
