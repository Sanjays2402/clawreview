import { describe, it, expect } from 'vitest';

import { fingerprint, diffAgainstBaseline, indexByFingerprint } from '../src/fingerprint.js';
import type { Finding } from '@clawreview/types';

function f(over: Partial<Finding> = {}): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'high',
    title: 'Possible SQL injection in query builder',
    rationale: 'User input is concatenated directly into the SQL string.',
    file: 'src/db.ts',
    startLine: 42,
    confidence: 0.8,
    tags: [],
    ...over,
  };
}

describe('fingerprint', () => {
  it('is stable for identical findings', () => {
    expect(fingerprint(f())).toBe(fingerprint(f()));
  });

  it('is insensitive to small line shifts within the same 10-line region', () => {
    expect(fingerprint(f({ startLine: 42 }))).toBe(fingerprint(f({ startLine: 49 })));
  });

  it('changes when the file path changes', () => {
    expect(fingerprint(f())).not.toBe(fingerprint(f({ file: 'src/other.ts' })));
  });

  it('changes when the category changes', () => {
    expect(fingerprint(f())).not.toBe(fingerprint(f({ category: 'performance' })));
  });

  it('changes when title wording is materially different', () => {
    expect(fingerprint(f())).not.toBe(
      fingerprint(f({ title: 'Memory leak in connection pool teardown' })),
    );
  });

  it('treats whitespace and punctuation differences in title as the same', () => {
    expect(fingerprint(f({ title: 'Possible SQL injection in query builder' }))).toBe(
      fingerprint(f({ title: 'Possible: SQL-injection   in query  builder!' })),
    );
  });

  it('returns 16-hex-char strings', () => {
    expect(fingerprint(f())).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('indexByFingerprint', () => {
  it('keys findings by their fingerprint', () => {
    const finding = f();
    const map = indexByFingerprint([finding]);
    expect(map.get(fingerprint(finding))).toBe(finding);
  });
});

describe('diffAgainstBaseline', () => {
  it('returns empty added/removed when current matches baseline', () => {
    const d = diffAgainstBaseline([f()], [f()]);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.unchanged).toHaveLength(1);
  });

  it('flags new findings as added', () => {
    const newFinding = f({ file: 'src/new.ts', title: 'XSS sink in template render' });
    const d = diffAgainstBaseline([f(), newFinding], [f()]);
    expect(d.added).toEqual([newFinding]);
    expect(d.unchanged).toHaveLength(1);
    expect(d.removed).toHaveLength(0);
  });

  it('flags missing baseline findings as removed', () => {
    const goneFinding = f({ file: 'src/gone.ts' });
    const d = diffAgainstBaseline([f()], [f(), goneFinding]);
    expect(d.removed).toEqual([goneFinding]);
    expect(d.unchanged).toHaveLength(1);
    expect(d.added).toHaveLength(0);
  });

  it('handles fully disjoint sets', () => {
    const a = f({ file: 'a.ts' });
    const b = f({ file: 'b.ts' });
    const d = diffAgainstBaseline([a], [b]);
    expect(d.added).toEqual([a]);
    expect(d.removed).toEqual([b]);
    expect(d.unchanged).toHaveLength(0);
  });
});
