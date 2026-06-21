import type { Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import { aggregate, applyMinConfidence, dedupFindings, rankFindings } from '../src/aggregate.js';

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

  describe('minConfidence floor', () => {
    it('drops findings below the configured floor regardless of severity', () => {
      const findings = [
        f({ title: 'noise', confidence: 0.1, severity: 'medium' }),
        f({ title: 'maybe', confidence: 0.3, severity: 'medium', startLine: 50 }),
        f({ title: 'solid', confidence: 0.7, severity: 'medium', startLine: 100 }),
      ];
      const out = aggregate(findings, { minConfidence: 0.4 });
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0]!.title).toBe('solid');
    });

    it('does not floor findings exactly at the threshold (inclusive >=)', () => {
      const findings = [
        f({ title: 'edge', confidence: 0.5 }),
        f({ title: 'just under', confidence: 0.49, startLine: 50 }),
      ];
      const out = aggregate(findings, { minConfidence: 0.5 });
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0]!.title).toBe('edge');
    });

    it('defaults to 0 (no floor)', () => {
      const findings = [f({ confidence: 0.01 })];
      const out = aggregate(findings, {});
      expect(out.findings).toHaveLength(1);
    });

    it('clamps a misconfigured value into [0, 1] rather than dropping everything', () => {
      const findings = [f({ confidence: 0.7 }), f({ confidence: 0.5, startLine: 50 })];
      // A value >1 would otherwise drop every finding (none has conf=2).
      const tooHigh = aggregate(findings, { minConfidence: 2 as number });
      // Confidence is clamped to 1.0, so everything below 1.0 is dropped.
      expect(tooHigh.findings).toHaveLength(0);
      // Negative inputs clamp to 0 (no floor).
      const tooLow = aggregate(findings, { minConfidence: -3 as number });
      expect(tooLow.findings).toHaveLength(2);
      // NaN clamps to 0 (no floor) -- guards against `Number(undefined)` leakage.
      const nan = aggregate(findings, { minConfidence: Number.NaN });
      expect(nan.findings).toHaveLength(2);
    });

    it('floored findings are not counted toward maxPerFile (cap means "best N kept")', () => {
      // Two real findings + 10 low-confidence noise -- with floor on,
      // maxPerFile=2 should keep both real ones, not be eaten by noise.
      const findings: Finding[] = [];
      for (let i = 0; i < 10; i += 1) {
        findings.push(f({ confidence: 0.1, startLine: i + 1, severity: 'low', title: `noise-${i}` }));
      }
      findings.push(f({ confidence: 0.9, startLine: 50, severity: 'low', title: 'real-1' }));
      findings.push(f({ confidence: 0.9, startLine: 60, severity: 'low', title: 'real-2' }));
      const out = aggregate(findings, { minConfidence: 0.5, maxPerFile: 2 });
      expect(out.findings.map((x) => x.title).sort()).toEqual(['real-1', 'real-2']);
    });

    it('composes with the severity threshold (both must pass)', () => {
      const findings = [
        f({ severity: 'medium', confidence: 0.8 }),
        f({ severity: 'nit', confidence: 0.9, startLine: 50 }),
        f({ severity: 'medium', confidence: 0.2, startLine: 100 }),
      ];
      // threshold=low keeps low+up, drops nit. minConfidence=0.5 drops
      // the third finding. Only the first survives.
      const out = aggregate(findings, { threshold: 'low', minConfidence: 0.5 });
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0]!.severity).toBe('medium');
      expect(out.findings[0]!.confidence).toBe(0.8);
    });
  });
});

describe('applyMinConfidence', () => {
  it('partitions input into kept and dropped at the inclusive boundary', () => {
    const findings = [
      f({ title: 'a', confidence: 0.1 }),
      f({ title: 'b', confidence: 0.5, startLine: 50 }),
      f({ title: 'c', confidence: 0.9, startLine: 100 }),
    ];
    const r = applyMinConfidence(findings, 0.5);
    expect(r.kept.map((x) => x.title).sort()).toEqual(['b', 'c']);
    expect(r.dropped.map((x) => x.title)).toEqual(['a']);
    expect(r.threshold).toBe(0.5);
  });

  it('returns the input unchanged when threshold is 0 (no floor)', () => {
    const findings = [f({ confidence: 0.01 }), f({ confidence: 0.99, startLine: 50 })];
    const r = applyMinConfidence(findings, 0);
    expect(r.kept).toHaveLength(2);
    expect(r.dropped).toHaveLength(0);
    expect(r.threshold).toBe(0);
  });

  it('clamps a misconfigured threshold into [0, 1] and surfaces the effective value', () => {
    const findings = [f({ confidence: 0.5 })];
    // threshold > 1 clamps to 1; everything strictly below 1 drops.
    const tooHigh = applyMinConfidence(findings, 2);
    expect(tooHigh.kept).toHaveLength(0);
    expect(tooHigh.dropped).toHaveLength(1);
    expect(tooHigh.threshold).toBe(1);
    // Negative threshold clamps to 0; nothing drops.
    const tooLow = applyMinConfidence(findings, -3);
    expect(tooLow.kept).toHaveLength(1);
    expect(tooLow.dropped).toHaveLength(0);
    expect(tooLow.threshold).toBe(0);
    // NaN clamps to 0; nothing drops. Guards against `Number(undefined)`.
    const nan = applyMinConfidence(findings, Number.NaN);
    expect(nan.kept).toHaveLength(1);
    expect(nan.threshold).toBe(0);
  });

  it('preserves input order in kept and dropped (no rank/sort side-effects)', () => {
    const findings = [
      f({ title: 'z', confidence: 0.9, startLine: 1 }),
      f({ title: 'a', confidence: 0.1, startLine: 2 }),
      f({ title: 'm', confidence: 0.6, startLine: 3 }),
      f({ title: 'b', confidence: 0.1, startLine: 4 }),
    ];
    const r = applyMinConfidence(findings, 0.5);
    expect(r.kept.map((x) => x.title)).toEqual(['z', 'm']);
    expect(r.dropped.map((x) => x.title)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array or its findings', () => {
    const findings = [
      f({ title: 'keep', confidence: 0.9 }),
      f({ title: 'drop', confidence: 0.1, startLine: 50 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(findings));
    applyMinConfidence(findings, 0.5);
    expect(findings).toEqual(snapshot);
  });

  it('matches the floor behaviour inside aggregate() for the same threshold', () => {
    // Defensive correlation test: any divergence between
    // applyMinConfidence and the floor inlined inside aggregate() will
    // show up here, so the extraction stays honest. Distinct files
    // sidestep aggregate()'s dedup so we compare ONLY the floor.
    const findings = [
      f({ file: 'src/a.ts', confidence: 0.05, startLine: 1, severity: 'critical' }),
      f({ file: 'src/b.ts', confidence: 0.35, startLine: 1, severity: 'critical' }),
      f({ file: 'src/c.ts', confidence: 0.55, startLine: 1, severity: 'critical' }),
      f({ file: 'src/d.ts', confidence: 0.85, startLine: 1, severity: 'critical' }),
    ];
    const helper = applyMinConfidence(findings, 0.4);
    const aggregated = aggregate(findings, { minConfidence: 0.4, maxPerFile: 99 });
    const helperFiles = new Set(helper.kept.map((x) => x.file));
    const aggFiles = new Set(aggregated.findings.map((x) => x.file));
    expect(helperFiles).toEqual(aggFiles);
  });
});
