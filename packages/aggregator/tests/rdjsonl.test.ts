import type { Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import { fingerprint } from '../src/fingerprint.js';
import { toRdjsonl, toRdjsonlDiagnostics } from '../src/rdjsonl.js';

function f(over: Partial<Finding> = {}): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'high',
    title: 'Tainted SQL in user lookup',
    rationale: 'User input concatenated into raw query.',
    file: 'src/users.ts',
    startLine: 17,
    confidence: 0.85,
    tags: [],
    ...over,
  } as Finding;
}

describe('toRdjsonl / toRdjsonlDiagnostics', () => {
  it('emits one diagnostic per finding with the required reviewdog fields', () => {
    const diags = toRdjsonlDiagnostics([f()]);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.message).toContain('Tainted SQL in user lookup');
    expect(d.message).toContain('User input concatenated into raw query.');
    expect(d.severity).toBe('ERROR');
    expect(d.location.path).toBe('src/users.ts');
    expect(d.location.range.start.line).toBe(17);
    expect(d.location.range.end?.line).toBe(17);
    expect(d.source?.name).toBe('clawreview');
    expect(d.code?.value).toBe('security.security');
    expect(d.original_output).toBe(fingerprint(f()));
  });

  it('maps ClawReview severities to reviewdog severities', () => {
    const diags = toRdjsonlDiagnostics([
      f({ severity: 'critical' }),
      f({ severity: 'high' }),
      f({ severity: 'medium' }),
      f({ severity: 'low' }),
      f({ severity: 'nit' }),
    ]);
    expect(diags.map((d) => d.severity)).toEqual(['ERROR', 'ERROR', 'WARNING', 'WARNING', 'INFO']);
  });

  it('forwards endLine when present and falls back to startLine otherwise', () => {
    const [withEnd, withoutEnd] = toRdjsonlDiagnostics([f({ endLine: 25 }), f()]);
    expect(withEnd!.location.range.end?.line).toBe(25);
    expect(withoutEnd!.location.range.end?.line).toBe(17);
  });

  it('appends a CWE reference to the message when present', () => {
    const [d] = toRdjsonlDiagnostics([f({ cwe: 'CWE-89' })]);
    expect(d!.message).toMatch(/Reference: CWE-89/);
  });

  it('emits a suggestion block when the finding carries a suggested patch', () => {
    const [d] = toRdjsonlDiagnostics([
      f({
        suggested: {
          description: 'Use prepared statement',
          diff: '- bad\n+ good',
        },
      }),
    ]);
    expect(d!.suggestions).toHaveLength(1);
    expect(d!.suggestions![0]!.text).toBe('- bad\n+ good');
    expect(d!.suggestions![0]!.range.start.line).toBe(17);
  });

  it('omits suggestions when none is provided', () => {
    const [d] = toRdjsonlDiagnostics([f()]);
    expect(d!.suggestions).toBeUndefined();
  });

  it('accepts an aggregated result as input', () => {
    const diags = toRdjsonlDiagnostics({
      findings: [f()],
      groupedByFile: [],
      totals: { critical: 0, high: 1, medium: 0, low: 0, nit: 0 },
      categoryTotals: {},
      agentTotals: {},
    });
    expect(diags).toHaveLength(1);
  });

  it('respects custom source name and code-url resolver', () => {
    const diags = toRdjsonlDiagnostics([f()], {
      sourceName: 'my-clawreview',
      sourceUrl: 'https://example.com',
      codeUrlFor: ({ ruleId }) => `https://docs.example.com/rules/${ruleId}`,
    });
    expect(diags[0]!.source).toEqual({ name: 'my-clawreview', url: 'https://example.com' });
    expect(diags[0]!.code).toEqual({
      value: 'security.security',
      url: 'https://docs.example.com/rules/security.security',
    });
  });

  it('toRdjsonl serializes one JSON object per line with a trailing newline', () => {
    const text = toRdjsonl([f(), f({ startLine: 42, title: 'second' })]);
    const lines = text.split('\n');
    // two diagnostics + trailing empty line from the final \n
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.location.range.start.line).toBe(17);
    expect(second.location.range.start.line).toBe(42);
    expect(second.message).toContain('second');
  });

  it('toRdjsonl returns an empty string when there are no findings', () => {
    expect(toRdjsonl([])).toBe('');
  });
});
