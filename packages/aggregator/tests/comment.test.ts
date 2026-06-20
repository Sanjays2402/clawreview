import { describe, expect, it } from 'vitest';

import { aggregate } from '../src/aggregate.js';
import { blameKey, type BlameMap } from '../src/authors.js';
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

  it('renders Top contributors block when authors.blame is supplied and yields rows', () => {
    const result = aggregate([
      { agent: 'security', category: 'security', severity: 'critical', title: 'a', rationale: 'x', file: 'src/a.ts', startLine: 5, confidence: 0.8, tags: [] },
      { agent: 'style', category: 'style', severity: 'low', title: 'b', rationale: 'y', file: 'src/b.ts', startLine: 9, confidence: 0.6, tags: [] },
    ]);
    const blame: BlameMap = new Map([
      [blameKey('src/a.ts', 5), { authorName: 'Sanjay', authorEmail: 'sanjay@example.com' }],
      [blameKey('src/b.ts', 9), { authorName: 'Cake', authorEmail: 'cake@example.com' }],
    ]);
    const md = renderPrComment(result, {
      prNumber: 1,
      headSha: 'abc1234',
      authors: { blame, top: 5 },
    });
    expect(md).toMatch(/Top contributors by severity/);
    // Worst-first ordering: critical owner comes first.
    expect(md.indexOf('Sanjay')).toBeLessThan(md.indexOf('Cake'));
    expect(md).toMatch(/\| Sanjay \| 1 \|/);
    expect(md).toMatch(/\| Cake \| 1 \|/);
  });

  it('renders Top contributors block when a pre-computed breakdown is supplied', () => {
    const result = aggregate([
      { agent: 'security', category: 'security', severity: 'high', title: 'a', rationale: 'x', file: 'src/a.ts', startLine: 5, confidence: 0.8, tags: [] },
    ]);
    const md = renderPrComment(result, {
      prNumber: 1,
      headSha: 'abc1234',
      authors: {
        breakdown: {
          authors: [
            {
              authorName: 'Sanjay',
              authorEmail: 'sanjay@example.com',
              findings: [],
              total: 4,
              bySeverity: { critical: 1, high: 2, medium: 1, low: 0, nit: 0 },
              worstSeverity: 'critical',
            },
          ],
          unknown: { length: 2 },
        },
      },
    });
    expect(md).toMatch(/Top contributors by severity/);
    expect(md).toMatch(/\| Sanjay \| 4 \|/);
    expect(md).toMatch(/Critical 1/);
    expect(md).toMatch(/High 2/);
    expect(md).toMatch(/2 finding\(s\) had no blame entry/);
  });

  it('caps Top contributors to opts.authors.top and shows the overflow tail', () => {
    const result = aggregate([
      { agent: 'security', category: 'security', severity: 'high', title: 'a', rationale: 'x', file: 'src/a.ts', startLine: 5, confidence: 0.8, tags: [] },
    ]);
    const md = renderPrComment(result, {
      prNumber: 1,
      headSha: 'abc1234',
      authors: {
        top: 2,
        breakdown: {
          authors: [
            { authorName: 'A', authorEmail: 'a@x', findings: [], total: 3, bySeverity: { critical: 1, high: 0, medium: 0, low: 0, nit: 2 }, worstSeverity: 'critical' },
            { authorName: 'B', authorEmail: 'b@x', findings: [], total: 2, bySeverity: { critical: 0, high: 2, medium: 0, low: 0, nit: 0 }, worstSeverity: 'high' },
            { authorName: 'C', authorEmail: 'c@x', findings: [], total: 1, bySeverity: { critical: 0, high: 0, medium: 1, low: 0, nit: 0 }, worstSeverity: 'medium' },
            { authorName: 'D', authorEmail: 'd@x', findings: [], total: 1, bySeverity: { critical: 0, high: 0, medium: 0, low: 1, nit: 0 }, worstSeverity: 'low' },
          ],
        },
      },
    });
    expect(md).toMatch(/Top contributors by severity/);
    expect(md).toMatch(/\| A \| 3 \|/);
    expect(md).toMatch(/\| B \| 2 \|/);
    expect(md).not.toMatch(/\| C \|/);
    expect(md).toMatch(/and 2 more author\(s\)/);
  });

  it('omits Top contributors block when authors is absent', () => {
    const result = aggregate([
      { agent: 'security', category: 'security', severity: 'high', title: 'a', rationale: 'x', file: 'src/a.ts', startLine: 5, confidence: 0.8, tags: [] },
    ]);
    const md = renderPrComment(result, { prNumber: 1, headSha: 'abc1234' });
    expect(md).not.toMatch(/Top contributors/);
  });

  it('omits Top contributors block when blame yields zero attributed authors', () => {
    const result = aggregate([
      { agent: 'security', category: 'security', severity: 'high', title: 'a', rationale: 'x', file: 'src/a.ts', startLine: 5, confidence: 0.8, tags: [] },
    ]);
    const md = renderPrComment(result, {
      prNumber: 1,
      headSha: 'abc1234',
      authors: { blame: new Map() },
    });
    expect(md).not.toMatch(/Top contributors/);
  });

  it('renders Top contributors block on a clean (zero-finding) review when caller supplies pre-computed authors', () => {
    const md = renderPrComment(aggregate([]), {
      prNumber: 1,
      headSha: 'abc1234',
      authors: {
        breakdown: {
          authors: [
            { authorName: 'X', authorEmail: 'x@x', findings: [], total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 }, worstSeverity: 'nit' },
          ],
        },
      },
    });
    expect(md).toMatch(/Top contributors by severity/);
    expect(md).toMatch(/No findings/);
  });
});
