import type { Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import { fingerprint } from '../src/fingerprint.js';
import { toGitlabCodeQuality } from '../src/gitlab.js';

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

describe('toGitlabCodeQuality', () => {
  it('emits one issue per finding with required GitLab fields', () => {
    const issues = toGitlabCodeQuality([f()]);
    expect(issues).toHaveLength(1);
    const i = issues[0]!;
    expect(i.description).toBe('Tainted SQL in user lookup');
    expect(i.check_name).toBe('security.security');
    expect(i.fingerprint).toBe(fingerprint(f()));
    expect(i.location.path).toBe('src/users.ts');
    expect(i.location.lines.begin).toBe(17);
  });

  it('maps ClawReview severities to GitLab severities', () => {
    const issues = toGitlabCodeQuality([
      f({ severity: 'critical' }),
      f({ severity: 'high' }),
      f({ severity: 'medium' }),
      f({ severity: 'low' }),
      f({ severity: 'nit' }),
    ]);
    expect(issues.map((i) => i.severity)).toEqual([
      'blocker',
      'critical',
      'major',
      'minor',
      'info',
    ]);
  });

  it('forwards endLine when present', () => {
    const issues = toGitlabCodeQuality([f({ endLine: 25 })]);
    expect(issues[0]!.location.lines).toEqual({ begin: 17, end: 25 });
  });

  it('omits end when endLine is undefined', () => {
    const issues = toGitlabCodeQuality([f()]);
    expect(issues[0]!.location.lines).toEqual({ begin: 17 });
  });

  it('attaches a Security category for security/sql-injection/secrets', () => {
    const issues = toGitlabCodeQuality([
      f({ category: 'security' }),
      f({ category: 'sql-injection' }),
      f({ category: 'secrets' }),
    ]);
    for (const i of issues) expect(i.categories).toEqual(['Security']);
  });

  it('omits categories for "other"', () => {
    const issues = toGitlabCodeQuality([f({ category: 'other' })]);
    expect(issues[0]!.categories).toBeUndefined();
  });

  it('includes a content body with rationale, CWE, and suggested patch', () => {
    const issues = toGitlabCodeQuality([
      f({
        rationale: 'Use parameterised queries.',
        cwe: 'CWE-89',
        suggested: { description: 'Use prepared statement', diff: '- bad\n+ good' },
      }),
    ]);
    const body = issues[0]!.content!.body;
    expect(body).toContain('Use parameterised queries.');
    expect(body).toContain('Reference: CWE-89');
    expect(body).toContain('Suggested change: Use prepared statement');
    expect(body).toContain('```diff');
    expect(body).toContain('+ good');
  });

  it('accepts an aggregated result as input', () => {
    const issues = toGitlabCodeQuality({
      findings: [f()],
      groupedByFile: [],
      totals: { critical: 0, high: 1, medium: 0, low: 0, nit: 0 },
      categoryTotals: {},
      agentTotals: {},
    });
    expect(issues).toHaveLength(1);
  });

  it('honours a custom severityMap override', () => {
    const issues = toGitlabCodeQuality([f({ severity: 'nit' })], {
      severityMap: {
        critical: 'blocker',
        high: 'critical',
        medium: 'major',
        low: 'minor',
        nit: 'minor', // nits surfaced as minor instead of info
      },
    });
    expect(issues[0]!.severity).toBe('minor');
  });
});
