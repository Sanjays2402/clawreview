import { describe, it, expect } from 'vitest';

import { renderReviewReport, type ReportMetadata, type ReportFinding } from '../src/report.js';

function meta(over: Partial<ReportMetadata> = {}): ReportMetadata {
  return {
    reviewId: 'rv_1',
    owner: 'o',
    repo: 'r',
    prNumber: 42,
    headSha: 'abcdef1234567890',
    baseSha: '1111111111111111',
    status: 'completed',
    createdAt: '2026-05-29T00:00:00.000Z',
    completedAt: '2026-05-29T00:00:30.000Z',
    durationMs: 30_000,
    totalCostUsd: 0.0123,
    agentExecutions: [
      { agent: 'security', status: 'ok', durationMs: 1200, findings: 1 },
    ],
    ...over,
  };
}

function finding(over: Partial<ReportFinding> = {}): ReportFinding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'high',
    title: 'SQL injection',
    rationale: 'Concatenated user input.',
    file: 'src/db.ts',
    startLine: 12,
    confidence: 0.9,
    tags: [],
    ...over,
  };
}

describe('renderReviewReport', () => {
  it('renders header with PR identity and short SHAs', () => {
    const md = renderReviewReport(meta(), [finding()]);
    expect(md).toContain('# ClawReview report for o/r#42');
    expect(md).toContain('abcdef123456');
    expect(md).toContain('111111111111');
  });

  it('renders severity totals and per-file grouping', () => {
    const md = renderReviewReport(meta(), [
      finding({ severity: 'critical', file: 'a.ts' }),
      finding({ severity: 'low', file: 'b.ts', title: 'Style nit' }),
    ]);
    expect(md).toMatch(/Critical \| 1/);
    expect(md).toMatch(/Low \| 1/);
    expect(md).toMatch(/### `a\.ts`/);
    expect(md).toMatch(/### `b\.ts`/);
  });

  it('includes suggested patches as a fenced diff when present', () => {
    const md = renderReviewReport(meta(), [
      finding({
        suggested: { description: 'use parameterized query', diff: '- bad\n+ good' },
      }),
    ]);
    expect(md).toMatch(/```diff/);
    expect(md).toContain('- bad');
    expect(md).toContain('+ good');
  });

  it('omits dismissed findings by default but counts them in the header', () => {
    const md = renderReviewReport(meta(), [
      finding({ title: 'Open one' }),
      finding({ title: 'Dropped', state: 'dismissed', dismissReason: 'noise' }),
    ]);
    expect(md).toContain('Open one');
    expect(md).not.toContain('Dropped');
    expect(md).toContain('| Dismissed |');
  });

  it('includes dismissed section when asked, with auto marker and reason', () => {
    const md = renderReviewReport(
      meta(),
      [
        finding({ title: 'Open one' }),
        finding({
          title: 'Recurring',
          state: 'dismissed',
          dismissReason: 'false positive',
          autoDismissed: true,
        }),
      ],
      { includeDismissed: true },
    );
    expect(md).toContain('## Dismissed findings');
    expect(md).toContain('Recurring');
    expect(md).toContain('(auto)');
    expect(md).toContain('false positive');
  });

  it('shows a friendly empty-state when there are no open findings', () => {
    const md = renderReviewReport(meta(), []);
    expect(md).toMatch(/No open findings/);
  });

  it('escapes table-breaking pipes and collapses newlines in rationale', () => {
    const md = renderReviewReport(meta(), [
      finding({ rationale: 'first line\nsecond | pipe' }),
    ]);
    expect(md).toContain('first line second \\| pipe');
  });
});
