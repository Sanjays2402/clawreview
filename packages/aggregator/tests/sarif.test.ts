import type { Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import { aggregate } from '../src/aggregate.js';
import { fingerprint } from '../src/fingerprint.js';
import { toSarif } from '../src/sarif.js';

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

describe('toSarif', () => {
  it('produces a SARIF v2.1.0 log with rules and results', () => {
    const result = aggregate([
      f(),
      f({
        agent: 'performance',
        category: 'performance',
        severity: 'medium',
        title: 'N+1 query',
        file: 'src/orders.ts',
        startLine: 42,
        cwe: 'CWE-400',
      }),
    ]);
    const log = toSarif(result, { commitSha: 'deadbeef', repositoryUri: 'https://github.com/x/y' });
    expect(log.version).toBe('2.1.0');
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0]!;
    expect(run.tool.driver.name).toBe('clawreview');
    expect(run.tool.driver.rules).toHaveLength(2);
    expect(run.results).toHaveLength(2);
    expect(run.results[0]!.level).toBe('error');
    expect(run.results[1]!.level).toBe('warning');
    expect(run.results[0]!.ruleIndex).toBe(0);
    expect(run.results[1]!.ruleIndex).toBe(1);
    expect(run.versionControlProvenance?.[0]).toEqual({
      repositoryUri: 'https://github.com/x/y',
      revisionId: 'deadbeef',
    });
  });

  it('accepts a raw findings array and emits one rule per agent.category', () => {
    const log = toSarif([f(), f({ startLine: 18 })]);
    expect(log.runs[0]!.tool.driver.rules).toHaveLength(1);
    expect(log.runs[0]!.results).toHaveLength(2);
  });

  it('emits SARIF fixes for findings with suggested patches', () => {
    const log = toSarif([
      f({
        suggested: { description: 'Use parameterized query', diff: '@@ -1 +1 @@\n-bad\n+good' },
      }),
    ]);
    const fix = log.runs[0]!.results[0]!.fixes?.[0];
    expect(fix?.description.text).toMatch(/parameterized/);
    expect(fix?.artifactChanges[0]!.replacements[0]!.insertedContent.text).toContain('+good');
  });

  it('maps severity nit to SARIF note', () => {
    const log = toSarif([f({ severity: 'nit' })]);
    expect(log.runs[0]!.results[0]!.level).toBe('note');
  });

  it('emits partialFingerprints matching the aggregator fingerprint', () => {
    const finding = f();
    const log = toSarif([finding]);
    const r = log.runs[0]!.results[0]!;
    expect(r.partialFingerprints?.clawreviewFingerprint).toBe(fingerprint(finding));
    expect(r.partialFingerprints?.primaryLocationLineHash).toBe(fingerprint(finding));
  });

  it('attaches helpUri via helpUriFor callback', () => {
    const log = toSarif([f()], {
      helpUriFor: ({ ruleId }) => `https://docs.clawreview.dev/rules/${ruleId}`,
    });
    const rule = log.runs[0]!.tool.driver.rules[0]!;
    expect(rule.helpUri).toBe('https://docs.clawreview.dev/rules/security.security');
  });

  it('swallows helpUriFor exceptions without breaking SARIF emission', () => {
    const log = toSarif([f()], {
      helpUriFor: () => {
        throw new Error('boom');
      },
    });
    expect(log.runs[0]!.tool.driver.rules[0]!.helpUri).toBeUndefined();
    expect(log.runs[0]!.results).toHaveLength(1);
  });

  it('omits helpUri when helpUriFor returns an empty string', () => {
    const log = toSarif([f()], { helpUriFor: () => '' });
    expect(log.runs[0]!.tool.driver.rules[0]!.helpUri).toBeUndefined();
  });

  it('records suppressions on matching results', () => {
    const finding = f();
    const log = toSarif([finding], {
      suppressions: [{ finding, kind: 'inSource', justification: 'clawreview-ignore' }],
    });
    const r = log.runs[0]!.results[0]!;
    expect(r.suppressions).toEqual([{ kind: 'inSource', justification: 'clawreview-ignore' }]);
  });

  it('does not attach suppressions on findings outside the suppression list', () => {
    const a = f();
    const b = f({ file: 'src/other.ts', startLine: 99 });
    const log = toSarif([a, b], {
      suppressions: [{ finding: a, justification: 'inline' }],
    });
    expect(log.runs[0]!.results[0]!.suppressions).toBeDefined();
    expect(log.runs[0]!.results[1]!.suppressions).toBeUndefined();
  });
});
