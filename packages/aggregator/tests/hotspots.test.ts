import type { Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import { detectHotspots, renderHotspotLine } from '../src/hotspots.js';

function f(over: Partial<Finding> = {}): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'medium',
    title: 'something',
    rationale: 'r',
    file: 'src/a.ts',
    startLine: 1,
    confidence: 0.7,
    tags: [],
    ...over,
  } as Finding;
}

describe('detectHotspots', () => {
  it('returns an empty list when there are no findings', () => {
    expect(detectHotspots([])).toEqual([]);
  });

  it('returns an empty list when no cluster meets minFindings', () => {
    const hotspots = detectHotspots([f({ startLine: 5 }), f({ file: 'src/b.ts', startLine: 50 })]);
    expect(hotspots).toEqual([]);
  });

  it('groups findings within the default 10-line window', () => {
    const hotspots = detectHotspots([
      f({ startLine: 5 }),
      f({ startLine: 12 }), // within 10 of 5
      f({ startLine: 30 }), // starts a new cluster
      f({ startLine: 33 }), // joins the new cluster
    ]);
    expect(hotspots).toHaveLength(2);
    expect(hotspots[0]!.count).toBe(2);
    expect(hotspots[0]!.startLine).toBe(5);
    expect(hotspots[0]!.endLine).toBe(12);
    expect(hotspots[1]!.startLine).toBe(30);
    expect(hotspots[1]!.endLine).toBe(33);
  });

  it('respects a custom windowLines value', () => {
    const tight = detectHotspots(
      [f({ startLine: 5 }), f({ startLine: 12 })],
      { windowLines: 3 },
    );
    expect(tight).toEqual([]); // 12 - 5 > 3, not a cluster

    const loose = detectHotspots(
      [f({ startLine: 5 }), f({ startLine: 12 }), f({ startLine: 50 })],
      { windowLines: 100 },
    );
    expect(loose).toHaveLength(1);
    expect(loose[0]!.count).toBe(3);
  });

  it('keeps clusters separated by file even when line ranges overlap', () => {
    const hotspots = detectHotspots(
      [
        f({ file: 'src/a.ts', startLine: 10 }),
        f({ file: 'src/a.ts', startLine: 12 }),
        f({ file: 'src/b.ts', startLine: 10 }),
        f({ file: 'src/b.ts', startLine: 12 }),
      ],
    );
    expect(hotspots).toHaveLength(2);
    expect(hotspots.map((h) => h.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('tracks the cluster end line off findings that span multiple lines', () => {
    const [hotspot] = detectHotspots([
      f({ startLine: 5 }),
      f({ startLine: 8, endLine: 18 }),
    ]);
    expect(hotspot!.startLine).toBe(5);
    expect(hotspot!.endLine).toBe(18);
  });

  it('promotes topSeverity to the worst severity in the cluster', () => {
    const [hotspot] = detectHotspots([
      f({ startLine: 5, severity: 'low' }),
      f({ startLine: 7, severity: 'critical' }),
      f({ startLine: 9, severity: 'medium' }),
    ]);
    expect(hotspot!.topSeverity).toBe('critical');
  });

  it('orders findings inside a cluster by severity then startLine', () => {
    const [hotspot] = detectHotspots([
      f({ startLine: 5, severity: 'low' }),
      f({ startLine: 7, severity: 'high' }),
      f({ startLine: 9, severity: 'critical' }),
    ]);
    expect(hotspot!.findings.map((x) => [x.severity, x.startLine])).toEqual([
      ['critical', 9],
      ['high', 7],
      ['low', 5],
    ]);
  });

  it('sorts hotspots by (count desc, topSeverity asc, file asc)', () => {
    const hotspots = detectHotspots(
      [
        // Smaller cluster, but a critical finding.
        f({ file: 'src/a.ts', startLine: 10, severity: 'critical' }),
        f({ file: 'src/a.ts', startLine: 12, severity: 'low' }),
        // Bigger cluster, all medium.
        f({ file: 'src/b.ts', startLine: 1, severity: 'medium' }),
        f({ file: 'src/b.ts', startLine: 3, severity: 'medium' }),
        f({ file: 'src/b.ts', startLine: 5, severity: 'medium' }),
      ],
    );
    expect(hotspots[0]!.file).toBe('src/b.ts'); // size beats severity
    expect(hotspots[1]!.file).toBe('src/a.ts');
  });

  it('applies the limit option', () => {
    const limited = detectHotspots(
      [
        f({ file: 'a.ts', startLine: 1 }),
        f({ file: 'a.ts', startLine: 2 }),
        f({ file: 'b.ts', startLine: 1 }),
        f({ file: 'b.ts', startLine: 2 }),
        f({ file: 'c.ts', startLine: 1 }),
        f({ file: 'c.ts', startLine: 2 }),
      ],
      { limit: 2 },
    );
    expect(limited).toHaveLength(2);
  });

  it('honors minFindings', () => {
    const strict = detectHotspots(
      [
        f({ startLine: 1 }),
        f({ startLine: 2 }),
        f({ startLine: 3 }),
      ],
      { minFindings: 5 },
    );
    expect(strict).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [f({ startLine: 10 }), f({ startLine: 5 })];
    const snapshot = input.map((x) => x.startLine);
    detectHotspots(input);
    expect(input.map((x) => x.startLine)).toEqual(snapshot);
  });
});

describe('renderHotspotLine', () => {
  it('formats a single-line cluster as L<n>', () => {
    const line = renderHotspotLine({
      file: 'src/a.ts',
      startLine: 5,
      endLine: 5,
      findings: [],
      topSeverity: 'high',
      count: 2,
    });
    expect(line).toBe('`src/a.ts` L5 — 2 findings (top: high)');
  });

  it('formats a multi-line cluster as L<start>-<end>', () => {
    const line = renderHotspotLine({
      file: 'src/a.ts',
      startLine: 5,
      endLine: 12,
      findings: [],
      topSeverity: 'critical',
      count: 4,
    });
    expect(line).toBe('`src/a.ts` L5-12 — 4 findings (top: critical)');
  });

  it('singularises "finding" when count is 1', () => {
    const line = renderHotspotLine({
      file: 'x',
      startLine: 1,
      endLine: 1,
      findings: [],
      topSeverity: 'low',
      count: 1,
    });
    expect(line).toContain('1 finding (');
  });
});
