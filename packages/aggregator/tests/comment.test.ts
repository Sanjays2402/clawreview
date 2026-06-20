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

  it('chooses failure for any critical finding', () => {
    const result = aggregate([
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

  it('renders a Run summary block when runSummary is provided', () => {
    const result = aggregate([]);
    const md = renderPrComment(result, {
      prNumber: 7,
      headSha: 'abc1234',
      runSummary: {
        durationMs: 4321,
        totalCostUsd: 0.1234,
        skippedCount: 2,
        agentExecutions: [
          { agent: 'security', status: 'ok', durationMs: 1500, findings: 0 },
          { agent: 'style', status: 'ok', durationMs: 800, findings: 0 },
        ],
      },
    });
    expect(md).toMatch(/Run summary/);
    expect(md).toMatch(/Duration: 4\.3s/);
    expect(md).toMatch(/Cost: \$0\.1234/);
    expect(md).toMatch(/Skipped files: 2/);
    expect(md).toMatch(/`security`/);
    expect(md).toMatch(/1\.5s/);
  });

  it('omits Run summary block entirely when runSummary is absent', () => {
    const result = aggregate([
      {
        agent: 'security',
        category: 'security',
        severity: 'high',
        title: 'x',
        rationale: 'y',
        file: 'a.ts',
        startLine: 1,
        confidence: 0.7,
        tags: [],
      },
    ]);
    const md = renderPrComment(result, { prNumber: 1, headSha: 'abc1234' });
    expect(md).not.toMatch(/Run summary/);
  });

  it('formats long durations as minutes', () => {
    const md = renderPrComment(aggregate([]), {
      prNumber: 1,
      headSha: 'abc1234',
      runSummary: { durationMs: 125_000 },
    });
    expect(md).toMatch(/Duration: 2m05s/);
  });

  it('surfaces an agent error message in the breakdown', () => {
    const md = renderPrComment(aggregate([]), {
      prNumber: 1,
      headSha: 'abc1234',
      runSummary: {
        agentExecutions: [
          { agent: 'security', status: 'error', durationMs: 50, findings: 0, error: 'timeout' },
        ],
      },
    });
    expect(md).toMatch(/error: timeout/);
  });

  it('renders a Hotspots block when hotspots:true and clusters exist', () => {
    const result = aggregate([
      { agent: 'security', category: 'security', severity: 'high', title: 'a', rationale: 'x', file: 'src/a.ts', startLine: 5, confidence: 0.8, tags: [] },
      { agent: 'security', category: 'security', severity: 'medium', title: 'b', rationale: 'x', file: 'src/a.ts', startLine: 9, confidence: 0.8, tags: [] },
      { agent: 'security', category: 'security', severity: 'low', title: 'c', rationale: 'x', file: 'src/a.ts', startLine: 11, confidence: 0.8, tags: [] },
    ]);
    const md = renderPrComment(result, { prNumber: 1, headSha: 'abc1234', hotspots: true });
    expect(md).toMatch(/\*\*Hotspots\*\*/);
    expect(md).toContain('`src/a.ts` L5-11');
    expect(md).toContain('3 findings');
    expect(md).toContain('top: high');
  });

  it('omits the Hotspots block when hotspots is absent', () => {
    const result = aggregate([
      { agent: 'security', category: 'security', severity: 'high', title: 'a', rationale: 'x', file: 'src/a.ts', startLine: 5, confidence: 0.8, tags: [] },
      { agent: 'security', category: 'security', severity: 'medium', title: 'b', rationale: 'x', file: 'src/a.ts', startLine: 9, confidence: 0.8, tags: [] },
    ]);
    const md = renderPrComment(result, { prNumber: 1, headSha: 'abc1234' });
    expect(md).not.toMatch(/\*\*Hotspots\*\*/);
  });

  it('omits the Hotspots block when no cluster reaches minFindings', () => {
    const result = aggregate([
      { agent: 'security', category: 'security', severity: 'high', title: 'a', rationale: 'x', file: 'src/a.ts', startLine: 5, confidence: 0.8, tags: [] },
      { agent: 'security', category: 'security', severity: 'medium', title: 'b', rationale: 'x', file: 'src/b.ts', startLine: 9, confidence: 0.8, tags: [] },
    ]);
    const md = renderPrComment(result, { prNumber: 1, headSha: 'abc1234', hotspots: true });
    expect(md).not.toMatch(/\*\*Hotspots\*\*/);
  });

  it('honors a tightened hotspot windowLines via the options object', () => {
    const result = aggregate([
      { agent: 'security', category: 'security', severity: 'high', title: 'a', rationale: 'x', file: 'src/a.ts', startLine: 5, confidence: 0.8, tags: [] },
      { agent: 'security', category: 'security', severity: 'medium', title: 'b', rationale: 'x', file: 'src/a.ts', startLine: 30, confidence: 0.8, tags: [] },
    ]);
    const md = renderPrComment(result, {
      prNumber: 1,
      headSha: 'abc1234',
      hotspots: { windowLines: 2 },
    });
    expect(md).not.toMatch(/\*\*Hotspots\*\*/);
  });
});
