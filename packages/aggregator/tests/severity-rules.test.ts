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
    expect(res.dropped).toEqual([]);
    expect(res.findings[0]?.severity).toBe('low');
  });

  it('escalates findings under a sensitive path glob', () => {
    const res = applySeverityRules(
      [f(), f({ file: 'src/util/math.ts' })],
      cfg([{ path: 'src/billing/**', bump: -2, reason: 'PCI scope' }]),
    );
    expect(res.findings).toHaveLength(2);
    expect(res.findings[0]?.severity).toBe('high');
    expect(res.findings[1]?.severity).toBe('low');
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0]?.from).toBe('low');
    expect(res.applied[0]?.to).toBe('high');
    expect(res.findings[0]?.tags).toContain('severity-rule:0:pci-scope');
    expect(res.dropped).toEqual([]);
  });

  it('respects absolute set: severity over bump', () => {
    const res = applySeverityRules(
      [f({ severity: 'nit' })],
      cfg([{ path: '**/*.ts', set: 'critical', bump: 1, reason: 'override' }]),
    );
    expect(res.findings[0]?.severity).toBe('critical');
  });

  it('uses first matching rule only', () => {
    const res = applySeverityRules(
      [f()],
      cfg([
        { path: 'src/billing/**', set: 'high' },
        { path: '**/*.ts', set: 'nit' },
      ]),
    );
    expect(res.findings[0]?.severity).toBe('high');
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0]?.ruleIndex).toBe(0);
  });

  it('filters by agent and category', () => {
    const res = applySeverityRules(
      [f({ agent: 'style', category: 'style' }), f()],
      cfg([{ path: '**/*.ts', agent: 'security', category: 'security', bump: -1 }]),
    );
    expect(res.findings[0]?.severity).toBe('low');
    expect(res.findings[1]?.severity).toBe('medium');
  });

  it('records no-op matches without mutating tags', () => {
    const res = applySeverityRules(
      [f({ severity: 'critical' })],
      cfg([{ path: '**/*.ts', bump: -3 }]),
    );
    expect(res.findings[0]?.severity).toBe('critical');
    expect(res.findings[0]?.tags).toEqual([]);
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0]?.from).toBe(res.applied[0]?.to);
  });

  describe('drop action', () => {
    it('removes the finding from the output and records it in dropped[]', () => {
      const res = applySeverityRules(
        [f(), f({ file: 'vendor/lib/x.ts' })],
        cfg([{ path: 'vendor/**', drop: true, reason: 'vendored' }]),
      );
      expect(res.findings).toHaveLength(1);
      expect(res.findings[0]?.file).toBe('src/billing/charge.ts');
      expect(res.dropped).toHaveLength(1);
      expect(res.dropped[0]?.finding.file).toBe('vendor/lib/x.ts');
      expect(res.dropped[0]?.reason).toBe('vendored');
    });

    it('drop wins over set/bump on the same matching rule', () => {
      const res = applySeverityRules(
        [f()],
        cfg([{ path: '**/*.ts', set: 'critical', drop: true }]),
      );
      expect(res.findings).toEqual([]);
      expect(res.dropped).toHaveLength(1);
      expect(res.applied).toEqual([]);
    });

    it('a later non-drop rule does not run if an earlier drop matched', () => {
      const res = applySeverityRules(
        [f()],
        cfg([
          { path: '**/*.ts', drop: true },
          { path: 'src/billing/**', set: 'critical' },
        ]),
      );
      expect(res.findings).toEqual([]);
      expect(res.dropped).toHaveLength(1);
      expect(res.dropped[0]?.ruleIndex).toBe(0);
    });
  });

  describe('confidence band matchers', () => {
    it('min_confidence skips findings below the floor', () => {
      const res = applySeverityRules(
        [f({ confidence: 0.2 }), f({ confidence: 0.8 })],
        cfg([{ path: '**', min_confidence: 0.5, set: 'critical' }]),
      );
      expect(res.findings[0]?.severity).toBe('low'); // 0.2 not matched
      expect(res.findings[1]?.severity).toBe('critical');
      expect(res.applied).toHaveLength(1);
    });

    it('max_confidence skips findings above the ceiling', () => {
      const res = applySeverityRules(
        [f({ confidence: 0.2 }), f({ confidence: 0.95 })],
        cfg([{ path: '**', max_confidence: 0.4, set: 'nit' }]),
      );
      expect(res.findings[0]?.severity).toBe('nit'); // 0.2 matched
      expect(res.findings[1]?.severity).toBe('low'); // 0.95 not matched
    });

    it('combines min_confidence + max_confidence + drop to filter a noise band', () => {
      const res = applySeverityRules(
        [
          f({ confidence: 0.15, category: 'style' }),
          f({ confidence: 0.35, category: 'style' }),
          f({ confidence: 0.7, category: 'style' }),
          f({ confidence: 0.35, category: 'security' }),
        ],
        cfg([
          {
            path: '**',
            category: 'style',
            min_confidence: 0.2,
            max_confidence: 0.5,
            drop: true,
          },
        ]),
      );
      // Drop only the style finding inside the [0.2, 0.5] band.
      expect(res.findings).toHaveLength(3);
      expect(res.dropped).toHaveLength(1);
      expect(res.dropped[0]?.finding.confidence).toBe(0.35);
      expect(res.dropped[0]?.finding.category).toBe('style');
    });

    it('inclusive bounds on both ends', () => {
      const res = applySeverityRules(
        [f({ confidence: 0.5 })],
        cfg([{ path: '**', min_confidence: 0.5, max_confidence: 0.5, drop: true }]),
      );
      expect(res.dropped).toHaveLength(1);
    });
  });
});
