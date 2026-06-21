import type { Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import {
  findingDigest,
  severityIterationOrder,
} from '../src/digest.js';

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

describe('findingDigest', () => {
  it('walks the input once and produces all bucket maps', () => {
    const findings = [
      f({ agent: 'security', category: 'security', severity: 'critical', file: 'src/a.ts' }),
      f({ agent: 'security', category: 'security', severity: 'high', file: 'src/a.ts', startLine: 20 }),
      f({ agent: 'style', category: 'style', severity: 'medium', file: 'src/b.ts' }),
      f({ agent: 'style', category: 'style', severity: 'nit', file: 'src/c.ts' }),
    ];

    const digest = findingDigest(findings);

    expect(digest.total).toBe(4);
    expect(digest.totalsBySeverity.critical).toBe(1);
    expect(digest.totalsBySeverity.high).toBe(1);
    expect(digest.totalsBySeverity.medium).toBe(1);
    expect(digest.totalsBySeverity.nit).toBe(1);
    expect(digest.totalsBySeverity.low).toBe(0);

    expect(digest.byAgent.security).toBe(2);
    expect(digest.byAgent.style).toBe(2);

    expect(digest.byCategory.security).toBe(2);
    expect(digest.byCategory.style).toBe(2);

    expect(digest.byFile['src/a.ts']).toBe(2);
    expect(digest.byFile['src/b.ts']).toBe(1);
  });

  it('returns a fixed-shape severity totals record even when buckets are empty', () => {
    const digest = findingDigest([]);
    expect(digest.total).toBe(0);
    expect(Object.keys(digest.totalsBySeverity).sort()).toEqual(
      ['critical', 'high', 'low', 'medium', 'nit'],
    );
    for (const v of Object.values(digest.totalsBySeverity)) {
      expect(v).toBe(0);
    }
    expect(digest.topFiles).toEqual([]);
    expect(digest.hotspots).toBeUndefined();
  });

  it('returns topFiles sorted by descending count then by file path', () => {
    const findings = [
      f({ file: 'src/b.ts' }),
      f({ file: 'src/a.ts' }),
      f({ file: 'src/a.ts', startLine: 20 }),
      f({ file: 'src/c.ts' }),
      f({ file: 'src/c.ts', startLine: 30 }),
    ];
    const digest = findingDigest(findings, { topFiles: 5 });
    // a and c are tied at 2; a sorts first alphabetically.
    expect(digest.topFiles[0]).toEqual({ file: 'src/a.ts', count: 2 });
    expect(digest.topFiles[1]).toEqual({ file: 'src/c.ts', count: 2 });
    expect(digest.topFiles[2]).toEqual({ file: 'src/b.ts', count: 1 });
  });

  it('caps topFiles at the requested limit', () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 20; i += 1) {
      findings.push(f({ file: `src/file-${String(i).padStart(2, '0')}.ts` }));
    }
    const digest = findingDigest(findings, { topFiles: 3 });
    expect(digest.topFiles).toHaveLength(3);
    // Every file has count 1, so sort is purely alphabetical.
    expect(digest.topFiles[0]!.file).toBe('src/file-00.ts');
    expect(digest.topFiles[1]!.file).toBe('src/file-01.ts');
    expect(digest.topFiles[2]!.file).toBe('src/file-02.ts');
  });

  it('clamps topFiles into [1, 200] so a hostile caller cannot disable or blow it up', () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 5; i += 1) {
      findings.push(f({ file: `src/file-${i}.ts` }));
    }
    const tooLow = findingDigest(findings, { topFiles: 0 });
    expect(tooLow.topFiles).toHaveLength(1);
    const negative = findingDigest(findings, { topFiles: -100 });
    expect(negative.topFiles).toHaveLength(1);
    const huge = findingDigest(findings, { topFiles: 10_000 });
    // Hard ceiling 200, but only 5 distinct files exist so we cap at 5.
    expect(huge.topFiles).toHaveLength(5);
  });

  it('omits the hotspots field when not requested (so JSON consumers can tell "not computed" from "empty")', () => {
    const digest = findingDigest([
      f({ file: 'src/a.ts', startLine: 10 }),
      f({ file: 'src/a.ts', startLine: 12 }),
      f({ file: 'src/a.ts', startLine: 14 }),
    ]);
    expect(digest.hotspots).toBeUndefined();
    expect('hotspots' in digest).toBe(false);
  });

  it('includes hotspots when opts.hotspots = true (uses default clusterer options)', () => {
    const findings = [
      f({ file: 'src/a.ts', startLine: 10, severity: 'high' }),
      f({ file: 'src/a.ts', startLine: 12, severity: 'medium' }),
      f({ file: 'src/a.ts', startLine: 14, severity: 'low' }),
      f({ file: 'src/b.ts', startLine: 200 }),
    ];
    const digest = findingDigest(findings, { hotspots: true });
    expect(digest.hotspots).toBeDefined();
    expect(digest.hotspots!.length).toBeGreaterThanOrEqual(1);
    const cluster = digest.hotspots![0]!;
    expect(cluster.file).toBe('src/a.ts');
    expect(cluster.count).toBeGreaterThanOrEqual(2);
  });

  it('forwards hotspot opts when opts.hotspots is an object', () => {
    const findings = [
      f({ file: 'src/a.ts', startLine: 10 }),
      f({ file: 'src/a.ts', startLine: 11 }),
      f({ file: 'src/b.ts', startLine: 10 }),
      f({ file: 'src/b.ts', startLine: 11 }),
    ];
    // limit=1 should trim to a single returned cluster.
    const digest = findingDigest(findings, { hotspots: { limit: 1, minFindings: 2 } });
    expect(digest.hotspots).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const findings = [
      f({ file: 'src/a.ts', startLine: 10 }),
      f({ file: 'src/a.ts', startLine: 20 }),
    ];
    const snapshot = findings.map((x) => ({ ...x }));
    findingDigest(findings, { hotspots: true });
    expect(findings.map((x) => ({ ...x }))).toEqual(snapshot);
  });

  it('byCategory is sparse: absent categories do not appear in the map', () => {
    const digest = findingDigest([f({ category: 'security' })]);
    expect(digest.byCategory.security).toBe(1);
    expect(digest.byCategory.performance).toBeUndefined();
    expect(Object.keys(digest.byCategory)).toEqual(['security']);
  });
});

describe('severityIterationOrder', () => {
  it('returns the canonical critical-first order', () => {
    expect(severityIterationOrder()).toEqual(['critical', 'high', 'medium', 'low', 'nit']);
  });
});
