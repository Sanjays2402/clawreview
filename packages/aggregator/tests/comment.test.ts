import { describe, expect, it } from 'vitest';

import { aggregate } from '../src/aggregate.js';
import { deriveCheckRun } from '../src/check.js';
import { renderPrComment } from '../src/comment.js';

describe('comment + check', () => {
  it('renders a clean-review comment when there are no findings', () => {
    const result = aggregate([]);
    const md = renderPrComment(result, { prNumber: 42, headSha: 'abc1234567' });
    expect(md).toMatch(/No findings/);
    expect(md).toMatch(/PR #42/);
  });

  it('includes a category breakdown line when findings exist', () => {
    const result = aggregate([
      {
        agent: 'security',
        category: 'security',
        severity: 'high',
        title: 'Tainted SQL',
        rationale: 'Avoid string interpolation in queries.',
        file: 'a.ts',
        startLine: 5,
        confidence: 0.8,
        tags: [],
      },
      {
        agent: 'performance',
        category: 'performance',
        severity: 'medium',
        title: 'N+1 query',
        rationale: 'Batch this lookup.',
        file: 'b.ts',
        startLine: 7,
        confidence: 0.7,
        tags: [],
      },
    ]);
    const md = renderPrComment(result, { prNumber: 1, headSha: 'deadbeef00' });
    expect(md).toMatch(/`security` 1/);
    expect(md).toMatch(/`performance` 1/);
  });

  it('chooses failure for any critical finding', () => {    const result = aggregate([
      {
        agent: 'security',
        category: 'security',
        severity: 'critical',
        title: 'Bad',
        rationale: 'Reason',
        file: 'a.ts',
        startLine: 1,
        confidence: 0.9,
        tags: [],
      },
    ]);
    const check = deriveCheckRun(result, 'abc1234');
    expect(check.conclusion).toBe('failure');
    expect(check.output.title).toMatch(/finding/);
  });
});
