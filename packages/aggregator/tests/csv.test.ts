import type { Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import { toCsv } from '../src/csv.js';
import { fingerprint } from '../src/fingerprint.js';

function f(over: Partial<Finding> = {}): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'high',
    title: 'Tainted SQL',
    rationale: 'Avoid string interpolation in raw queries.',
    file: 'src/users.ts',
    startLine: 17,
    confidence: 0.85,
    tags: ['sql', 'a01'],
    ...over,
  } as Finding;
}

describe('toCsv', () => {
  it('emits a header row plus one row per finding', () => {
    const csv = toCsv([f(), f({ severity: 'low', title: 'Magic number' })]);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('fingerprint,agent,category,severity');
    expect(lines[1]).toContain('security,security,high');
  });

  it('quotes and escapes commas, quotes, and newlines', () => {
    const csv = toCsv([
      f({ title: 'has, comma', rationale: 'has "quote" inside\nand newline' }),
    ]);
    expect(csv).toContain('"has, comma"');
    expect(csv).toContain('"has ""quote"" inside\nand newline"');
  });

  it('joins tags with pipe and falls back endLine to startLine', () => {
    const csv = toCsv([f({ tags: ['a', 'b', 'c'] })]);
    expect(csv).toContain('a|b|c');
    // endLine column should default to startLine (17)
    const rows = csv.split('\r\n');
    const header = rows[0].split(',');
    const data = rows[1].split(',');
    const endIdx = header.indexOf('endLine');
    expect(data[endIdx]).toBe('17');
  });

  it('includes a stable fingerprint matching the fingerprint helper', () => {
    const x = f();
    const csv = toCsv([x]);
    const rows = csv.split('\r\n');
    const header = rows[0].split(',');
    const data = rows[1].split(',');
    expect(data[header.indexOf('fingerprint')]).toBe(fingerprint(x));
  });

  it('omits header when header: false and returns empty for no findings', () => {
    expect(toCsv([], { header: false })).toBe('');
    const csv = toCsv([f()], { header: false });
    expect(csv.split('\r\n')[0]).not.toContain('fingerprint,agent');
    expect(csv).toContain('security,security,high');
  });
});
