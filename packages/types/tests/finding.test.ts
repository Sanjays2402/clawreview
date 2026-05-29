import { describe, expect, it } from 'vitest';

import { FindingSchema, FindingsResponseSchema } from '../src/finding.js';

describe('FindingSchema', () => {
  const base = {
    agent: 'security',
    category: 'security' as const,
    severity: 'high' as const,
    title: 'Use of eval',
    rationale: 'eval allows arbitrary code execution.',
    file: 'src/index.ts',
    startLine: 12,
  };

  it('accepts a valid finding', () => {
    expect(FindingSchema.parse(base).agent).toBe('security');
  });

  it('rejects a CWE that does not match the pattern', () => {
    const result = FindingSchema.safeParse({ ...base, cwe: 'CVE-2023-0001' });
    expect(result.success).toBe(false);
  });

  it('defaults confidence and tags', () => {
    const parsed = FindingSchema.parse(base);
    expect(parsed.confidence).toBe(0.6);
    expect(parsed.tags).toEqual([]);
  });

  it('parses a response wrapper', () => {
    const parsed = FindingsResponseSchema.parse({ findings: [base] });
    expect(parsed.findings).toHaveLength(1);
  });
});
