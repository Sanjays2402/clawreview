import type { Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import { aggregate, dedupFindings, rankFindings } from '../src/aggregate.js';

function f(over: Partial<Finding>): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'medium',
    title: 'Issue',
    rationale: 'Reason',
    file: 'src/x.ts',
    startLine: 10,
    confidence: 0.7,
    tags: [],
    ...over,
  } as Finding;
}

describe('rankFindings', () => {
  it('sorts by severity then confidence then file/line', () => {
    const a = f({ severity: 'high', confidence: 0.9, startLine: 20 });
    const b = f({ severity: 'critical', confidence: 0.5 });
    const c = f({ severity: 'high', confidence: 0.95, startLine: 5 });
    const ranked = rankFindings([a, b, c]);
    expect(ranked.map((x) => x.severity)).toEqual(['critical', 'high', 'high']);
    expect(ranked[1]!.confidence).toBeGreaterThanOrEqual(ranked[2]!.confidence);
  });
});

describe('dedupFindings', () => {
  it('collapses near-identical findings on the same file+line, keeping the more severe one', () => {
    const a = f({ title: 'SQL injection risk', severity: 'high', confidence: 0.7, agent: 'sql-injection' });
    const b = f({ title: 'SQL injection in query', severity: 'critical', startLine: 11, agent: 'security' });
    const out = dedupFindings([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('critical');
  });

  it('keeps distinct findings on the same line in different categories', () => {
    const a = f({ category: 'performance', title: 'N+1 query' });
    const b = f({ category: 'security', title: 'Tainted input', startLine: 11 });
    const out = dedupFindings([a, b]);
    expect(out).toHaveLength(2);
  });
});

describe('aggregate', () => {
  it('applies severity threshold and per-file cap', () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 12; i += 1) {
      findings.push(f({ startLine: i + 1, severity: 'low', title: `t-${i}` }));
    }
    findings.push(f({ severity: 'nit', startLine: 99, title: 'nit-thing' }));
    const out = aggregate(findings, { threshold: 'low', maxPerFile: 5 });
    expect(out.findings).toHaveLength(5);
    expect(out.totals.low).toBe(5);
    expect(out.totals.nit).toBe(0);
  });

  it('returns categoryTotals and agentTotals over surviving findings', () => {
    const out = aggregate([
      f({ category: 'security', agent: 'security', title: 'a' }),
      f({ category: 'security', agent: 'security', title: 'b', startLine: 50 }),
      f({ category: 'performance', agent: 'performance', title: 'c', file: 'src/y.ts' }),
      f({ category: 'style', agent: 'style', severity: 'low', title: 'd', file: 'src/z.ts' }),
    ]);
    expect(out.categoryTotals.security).toBe(2);
    expect(out.categoryTotals.performance).toBe(1);
    expect(out.categoryTotals.style).toBe(1);
    expect(out.agentTotals.security).toBe(2);
    expect(out.agentTotals.performance).toBe(1);
    expect(out.agentTotals.style).toBe(1);
  });

  it('omits categories with zero count', () => {
    const out = aggregate([f({ category: 'security', agent: 'security' })]);
    expect(out.categoryTotals.security).toBe(1);
    expect(out.categoryTotals.performance).toBeUndefined();
  });
});
