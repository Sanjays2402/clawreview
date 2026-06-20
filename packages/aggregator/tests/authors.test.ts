import { describe, expect, it } from 'vitest';
import type { Finding } from '@clawreview/types';

import {
  attributeFindingsToAuthors,
  blameKey,
  parsePorcelainBlame,
  UNKNOWN_AUTHOR_KEY,
  type BlameMap,
} from '../src/authors.js';

function f(over: Partial<Finding>): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'medium',
    title: 'Issue',
    rationale: 'r',
    file: 'src/x.ts',
    startLine: 10,
    confidence: 0.7,
    tags: [],
    ...over,
  } as Finding;
}

function blame(entries: Array<[string, number, string, string]>): BlameMap {
  const m: BlameMap = new Map();
  for (const [file, line, name, email] of entries) {
    m.set(blameKey(file, line), { authorName: name, authorEmail: email });
  }
  return m;
}

describe('blameKey', () => {
  it('uses file:line format and is deterministic', () => {
    expect(blameKey('src/a.ts', 12)).toBe('src/a.ts:12');
    expect(blameKey('src/a.ts', 12)).toBe(blameKey('src/a.ts', 12));
  });
});

describe('attributeFindingsToAuthors', () => {
  const findings = [
    f({ file: 'src/x.ts', startLine: 10, severity: 'critical' }),
    f({ file: 'src/x.ts', startLine: 15, severity: 'medium' }),
    f({ file: 'src/y.ts', startLine: 1, severity: 'low' }),
    f({ file: 'src/y.ts', startLine: 200 /* no blame */ }),
  ];
  const blameMap = blame([
    ['src/x.ts', 10, 'Sanjay Singh', 'sanjay@example.com'],
    ['src/x.ts', 15, 'Sanjay Singh', 'sanjay@example.com'],
    ['src/y.ts', 1, 'Cake Bot', 'cake@example.com'],
  ]);

  it('groups findings by author with per-severity counts', () => {
    const out = attributeFindingsToAuthors(findings, blameMap);
    const sanjay = out.authors.find((a) => a.authorEmail === 'sanjay@example.com');
    expect(sanjay?.total).toBe(2);
    expect(sanjay?.bySeverity.critical).toBe(1);
    expect(sanjay?.bySeverity.medium).toBe(1);
    expect(sanjay?.worstSeverity).toBe('critical');

    const cake = out.authors.find((a) => a.authorEmail === 'cake@example.com');
    expect(cake?.total).toBe(1);
    expect(cake?.worstSeverity).toBe('low');
  });

  it('sorts authors by worst severity, then total count, then name', () => {
    const out = attributeFindingsToAuthors(findings, blameMap);
    // Sanjay has critical, Cake has low — Sanjay must come first.
    expect(out.authors[0]?.authorEmail).toBe('sanjay@example.com');
    expect(out.authors[1]?.authorEmail).toBe('cake@example.com');
  });

  it('routes findings with no blame entry into the unknown bucket', () => {
    const out = attributeFindingsToAuthors(findings, blameMap);
    expect(out.unknown).toHaveLength(1);
    expect(out.unknown[0]!.file).toBe('src/y.ts');
    expect(out.unknown[0]!.startLine).toBe(200);
    expect(out.attributed).toBe(3);
  });

  it('treats author emails case-insensitively for bucket keys', () => {
    const map = blame([
      ['src/a.ts', 1, 'Sanjay Singh', 'Sanjay@Example.com'],
      ['src/a.ts', 2, 'Sanjay Singh', 'sanjay@example.com'],
    ]);
    const out = attributeFindingsToAuthors(
      [
        f({ file: 'src/a.ts', startLine: 1 }),
        f({ file: 'src/a.ts', startLine: 2 }),
      ],
      map,
    );
    expect(out.authors).toHaveLength(1);
    expect(out.authors[0]?.total).toBe(2);
  });

  it('returns an empty result for an empty findings list', () => {
    const out = attributeFindingsToAuthors([], new Map());
    expect(out.authors).toEqual([]);
    expect(out.unknown).toEqual([]);
    expect(out.attributed).toBe(0);
  });

  it('exports a stable sentinel name for the unknown bucket', () => {
    expect(UNKNOWN_AUTHOR_KEY).toBe('(unknown)');
  });
});

describe('parsePorcelainBlame', () => {
  // Two-line file: line 1 by Sanjay, line 2 by Cake.
  const SAMPLE = [
    'abc1234567 1 1 2',
    'author Sanjay Singh',
    'author-mail <sanjay@example.com>',
    'author-time 1700000000',
    'committer Sanjay Singh',
    'committer-mail <sanjay@example.com>',
    'committer-time 1700000000',
    'summary feat: first line',
    'filename src/x.ts',
    '\tconst a = 1;',
    'def4567890 2 2 1',
    'author Cake Bot',
    'author-mail <cake@example.com>',
    'author-time 1700000100',
    'committer Cake Bot',
    'committer-mail <cake@example.com>',
    'committer-time 1700000100',
    'summary chore: second line',
    'filename src/x.ts',
    '\tconst b = 2;',
  ].join('\n');

  it('parses a two-author file into a line -> author map', () => {
    const out = parsePorcelainBlame(SAMPLE);
    expect(out.size).toBe(2);
    expect(out.get(1)).toEqual({ authorName: 'Sanjay Singh', authorEmail: 'sanjay@example.com' });
    expect(out.get(2)).toEqual({ authorName: 'Cake Bot', authorEmail: 'cake@example.com' });
  });

  it('uses the FINAL line number from the header (not orig-line)', () => {
    const sample = [
      'aaaaaaaaaa 5 12 1',
      'author Renamed Author',
      'author-mail <ren@example.com>',
      '\tcontent',
    ].join('\n');
    const out = parsePorcelainBlame(sample);
    // orig-line was 5; we should be keyed on final-line=12.
    expect(out.has(5)).toBe(false);
    expect(out.has(12)).toBe(true);
  });

  it('falls back to empty email when the mail header is missing', () => {
    const sample = [
      'bbbbbbbbbb 1 1 1',
      'author Just A Name',
      '\tcontent',
    ].join('\n');
    const out = parsePorcelainBlame(sample);
    expect(out.get(1)).toEqual({ authorName: 'Just A Name', authorEmail: '' });
  });

  it('returns an empty map for empty input', () => {
    expect(parsePorcelainBlame('').size).toBe(0);
  });
});
