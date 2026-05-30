import type { Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import { aggregate } from '../src/aggregate.js';
import { toJUnitXml } from '../src/junit.js';

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
    tags: [],
    ...over,
  } as Finding;
}

describe('toJUnitXml', () => {
  it('renders a valid JUnit document with failures and skipped cases', () => {
    const result = aggregate(
      [
        f(),
        f({ severity: 'low', title: 'Magic number', file: 'src/util.ts', startLine: 3 }),
        f({ severity: 'critical', title: 'Hardcoded secret', file: 'src/k.ts', startLine: 9 }),
      ],
      { threshold: 'nit' },
    );
    const xml = toJUnitXml(result, { timestamp: '2026-01-01T00:00:00.000Z' });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('tests="3"');
    expect(xml).toContain('failures="2"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('<failure message="HIGH: Tainted SQL"');
    expect(xml).toContain('<failure message="CRITICAL: Hardcoded secret"');
    expect(xml).toContain('<skipped message="low"');
  });

  it('escapes XML special chars and CDATA terminators', () => {
    const xml = toJUnitXml([
      f({ title: '<bad> & "quoted"', rationale: 'contains ]]> sequence' }),
    ]);
    expect(xml).toContain('&lt;bad&gt; &amp; &quot;quoted&quot;');
    expect(xml).not.toMatch(/contains \]\]> sequence/);
    expect(xml).toContain(']]]]><![CDATA[>');
  });

  it('respects custom failOn severities', () => {
    const xml = toJUnitXml([f({ severity: 'medium' })], { failOn: ['medium'] });
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('<failure');
  });

  it('emits empty suite without testcases when findings are empty', () => {
    const xml = toJUnitXml([]);
    expect(xml).toContain('tests="0"');
    expect(xml).not.toContain('<testcase');
  });
});
