import { describe, expect, it } from 'vitest';
import type { Finding } from '@clawreview/types';

import { overlap, similarityMerge } from '../src/similarity.js';

function f(over: Partial<Finding>): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'medium',
    title: 'Issue',
    rationale: 'String concatenation into SQL allows injection of arbitrary code.',
    file: 'src/db.ts',
    startLine: 42,
    confidence: 0.7,
    tags: [],
    ...over,
  } as Finding;
}

describe('overlap', () => {
  it('returns 1 for identical rationales', () => {
    expect(overlap('hello world from cake', 'hello world from cake')).toBeCloseTo(1);
  });

  it('returns 0 when either side is empty', () => {
    expect(overlap('', 'anything')).toBe(0);
    expect(overlap('anything', '')).toBe(0);
  });

  it('ignores tokens shorter than 3 chars (noise like a, to, of)', () => {
    // After dropping <3 char tokens both sides become just ['hello']
    expect(overlap('a hello of', 'hello to a')).toBeCloseTo(1);
  });

  it('symmetric: f(a, b) == f(b, a)', () => {
    const a = 'SQL injection risk via direct string concatenation in query';
    const b = 'Direct string concatenation builds SQL query, injection risk';
    expect(overlap(a, b)).toBeCloseTo(overlap(b, a));
  });

  it('low overlap for unrelated rationales', () => {
    const a = 'Missing aria-label on the input element breaks screen readers';
    const b = 'String concatenation into SQL allows injection of arbitrary code';
    expect(overlap(a, b)).toBeLessThan(0.3);
  });
});

describe('similarityMerge', () => {
  it('merges two findings on the same line with overlapping rationale across agents', () => {
    const out = similarityMerge([
      f({
        agent: 'security',
        category: 'security',
        severity: 'high',
        title: 'SQL injection risk',
        rationale: 'Direct string concatenation builds SQL query, injection risk via tainted input.',
        startLine: 42,
        confidence: 0.6,
      }),
      f({
        agent: 'sql-injection',
        category: 'sql-injection',
        severity: 'critical',
        title: 'String concatenation builds SQL',
        rationale: 'String concatenation into SQL builds a query, injection risk via tainted user input.',
        startLine: 43,
        confidence: 0.85,
      }),
    ]);
    expect(out.findings).toHaveLength(1);
    // Critical+sql-injection should win on severity.
    expect(out.findings[0]!.agent).toBe('sql-injection');
    expect(out.findings[0]!.severity).toBe('critical');
    // Loser's attribution survives in tags.
    expect(out.findings[0]!.tags).toContain('merged-from:security');
    expect(out.merged).toHaveLength(1);
    expect(out.merged[0]!.winner).toBe('sql-injection');
    expect(out.merged[0]!.losers).toEqual(['security']);
  });

  it('does not merge findings on the same line with unrelated rationale', () => {
    const out = similarityMerge([
      f({
        agent: 'security',
        rationale: 'Auth bypass: token verification missing on protected route.',
        startLine: 10,
      }),
      f({
        agent: 'performance',
        category: 'performance',
        rationale: 'Allocates a new Date inside the hot loop on every iteration.',
        startLine: 10,
      }),
    ]);
    expect(out.findings).toHaveLength(2);
    expect(out.merged).toEqual([]);
  });

  it('respects the radius option — far-apart findings are not merged', () => {
    const out = similarityMerge(
      [
        f({ startLine: 10, rationale: 'String concatenation into SQL allows injection of arbitrary code.' }),
        f({ startLine: 25, rationale: 'String concatenation into SQL allows injection of arbitrary code.' }),
      ],
      { radius: 5 },
    );
    expect(out.findings).toHaveLength(2);
  });

  it('respects the minOverlap option', () => {
    const out = similarityMerge(
      [
        f({ rationale: 'one two three four five', startLine: 10 }),
        f({ rationale: 'one two three four five', startLine: 11 }),
      ],
      { minOverlap: 0.9 },
    );
    // Identical rationales -> overlap 1.0 >= 0.9 -> merge.
    expect(out.findings).toHaveLength(1);
  });

  it('ties on severity break by higher confidence', () => {
    const out = similarityMerge([
      f({
        agent: 'security',
        severity: 'high',
        confidence: 0.5,
        rationale: 'SQL string concatenation enables injection of attacker-controlled tokens.',
      }),
      f({
        agent: 'sql-injection',
        category: 'sql-injection',
        severity: 'high',
        confidence: 0.9,
        rationale: 'SQL string concatenation enables injection of attacker-controlled tokens.',
        startLine: 43,
      }),
    ]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.agent).toBe('sql-injection');
    expect(out.findings[0]!.confidence).toBe(0.9);
  });

  it('preserves an empty merge log when nothing is collapsed', () => {
    const out = similarityMerge([
      f({ rationale: 'one two three four', startLine: 1 }),
      f({ rationale: 'completely different topic here', startLine: 100 }),
    ]);
    expect(out.findings).toHaveLength(2);
    expect(out.merged).toEqual([]);
  });

  it('returns input unchanged when called with the empty list', () => {
    const out = similarityMerge([]);
    expect(out.findings).toEqual([]);
    expect(out.merged).toEqual([]);
  });

  it('does not cross file boundaries even when text matches', () => {
    const out = similarityMerge([
      f({ file: 'src/a.ts', rationale: 'identical rationale text payload here', startLine: 10 }),
      f({ file: 'src/b.ts', rationale: 'identical rationale text payload here', startLine: 10 }),
    ]);
    expect(out.findings).toHaveLength(2);
  });
});
