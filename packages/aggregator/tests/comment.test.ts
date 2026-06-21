import { describe, expect, it } from 'vitest';

import { aggregate } from '../src/aggregate.js';
import { blameKey, type BlameMap } from '../src/authors.js';
import { deriveCheckRun } from '../src/check.js';
import { renderPrComment } from '../src/comment.js';
import { type FindingDigest } from '../src/digest.js';

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

describe('renderPrComment topAgents / topCategories (tick 11)', () => {
  // The PR-comment header rewires to consume `findingDigest()`'s
  // pre-capped slices when the new opts are set. Tests pin both
  // (a) the existing unbounded path stays untouched when the new
  //     opts are NOT set (back-compat with snapshot tests / earlier
  //     callers); and
  // (b) the new path produces ordering + truncation byte-identical
  //     to what the CLI's `stats --by agent --top-agents <n>` ships,
  //     by going through the same digest helper.

  function many(): Array<{ agent: string; category: 'security' | 'style' | 'performance' | 'maintainability' | 'bug'; severity: 'high' | 'medium' | 'low'; file: string; startLine: number }> {
    return [
      // 4 security from agent A1
      { agent: 'a1', category: 'security', severity: 'high', file: 'a.ts', startLine: 1 },
      { agent: 'a1', category: 'security', severity: 'high', file: 'a.ts', startLine: 11 },
      { agent: 'a1', category: 'security', severity: 'high', file: 'a.ts', startLine: 21 },
      { agent: 'a1', category: 'security', severity: 'high', file: 'a.ts', startLine: 31 },
      // 3 style from A2
      { agent: 'a2', category: 'style', severity: 'medium', file: 'b.ts', startLine: 1 },
      { agent: 'a2', category: 'style', severity: 'medium', file: 'b.ts', startLine: 11 },
      { agent: 'a2', category: 'style', severity: 'medium', file: 'b.ts', startLine: 21 },
      // 2 perf from A3
      { agent: 'a3', category: 'performance', severity: 'low', file: 'c.ts', startLine: 1 },
      { agent: 'a3', category: 'performance', severity: 'low', file: 'c.ts', startLine: 11 },
      // 1 maintainability from A4
      { agent: 'a4', category: 'maintainability', severity: 'low', file: 'd.ts', startLine: 1 },
      // 1 bug from A5
      { agent: 'a5', category: 'bug', severity: 'low', file: 'e.ts', startLine: 1 },
    ];
  }

  function buildResult() {
    return aggregate(
      many().map((row, i) => ({
        ...row,
        title: `t${i}`,
        rationale: 'r',
        confidence: 0.8,
        tags: [] as string[],
      })),
      { maxPerFile: 50, threshold: 'nit' as const },
    );
  }

  it('renders the category line via the digest slice and appends (N more) when truncated', () => {
    const r = buildResult();
    const md = renderPrComment(r, { prNumber: 1, headSha: 'abc1234', topCategories: 2 });
    // Top 2 categories by count: security (4), style (3). Lines
    // appear in render order; the truncation tail is _(N more)_.
    expect(md).toMatch(/`security` 4/);
    expect(md).toMatch(/`style` 3/);
    // 5 categories total -> 3 dropped into the tail annotation.
    expect(md).toMatch(/_\(3 more\)_/);
    // The dropped categories must NOT appear in the line.
    expect(md).not.toMatch(/`maintainability` /);
    expect(md).not.toMatch(/`reliability` /);
  });

  it('renders the by-agent line ONLY when topAgents is set (default: no agent line)', () => {
    const r = buildResult();
    const without = renderPrComment(r, { prNumber: 1, headSha: 'abc1234' });
    // No "By agent" header line when topAgents is unset.
    expect(without).not.toMatch(/By agent:/);

    const withCap = renderPrComment(r, { prNumber: 1, headSha: 'abc1234', topAgents: 3 });
    expect(withCap).toMatch(/By agent: /);
    expect(withCap).toMatch(/`a1` 4/);
    expect(withCap).toMatch(/`a2` 3/);
    expect(withCap).toMatch(/`a3` 2/);
    // a4 and a5 collapsed into the tail.
    expect(withCap).toMatch(/_\(2 more\)_/);
    expect(withCap).not.toMatch(/`a4` /);
    expect(withCap).not.toMatch(/`a5` /);
  });

  it('does not render an (N more) tail when the cap is at or above the bucket count', () => {
    const r = buildResult();
    const md = renderPrComment(r, {
      prNumber: 1,
      headSha: 'abc1234',
      topAgents: 10,
      topCategories: 10,
    });
    expect(md).toMatch(/By agent: /);
    // All five agents render -- no truncation annotation.
    expect(md).toMatch(/`a1` 4/);
    expect(md).toMatch(/`a5` 1/);
    expect(md).not.toMatch(/more\)_/);
  });

  it('preserves the existing unbounded category line when topCategories is unset (back-compat)', () => {
    // Defensive: any change to the existing render shape would break
    // downstream snapshot tests and pre-tick-11 callers. The line
    // should be sorted by count desc with no _(N more)_ tail.
    const r = buildResult();
    const md = renderPrComment(r, { prNumber: 1, headSha: 'abc1234' });
    expect(md).toMatch(/`security` 4 · `style` 3 · `performance` 2 · `maintainability` 1 · `bug` 1/);
    expect(md).not.toMatch(/more\)_/);
    expect(md).not.toMatch(/By agent:/);
  });

  it('reuses a caller-supplied digest instead of recomputing one', () => {
    // The worker already builds a digest for the dashboard; the
    // comment renderer should consume that digest rather than walk
    // the findings array a second time. We verify by handing a
    // digest whose slices DO NOT match the result (a pathological
    // case the helper would never produce, but the cleanest way to
    // observe "the renderer used my object").
    const r = buildResult();
    const fakeDigest = {
      total: 0,
      totalsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
      byCategory: { security: 1 } as Partial<Record<'security' | 'style', number>>,
      byAgent: { 'fake-agent': 42 },
      byFile: {},
      topAgents: [{ agent: 'fake-agent', count: 42 }],
      topCategories: [{ category: 'security' as const, count: 1 }],
      topFiles: [],
    };
    const md = renderPrComment(r, {
      prNumber: 1,
      headSha: 'abc1234',
      topAgents: 1,
      topCategories: 1,
      digest: fakeDigest as unknown as FindingDigest,
    });
    // Both lines reflect the injected (not recomputed) digest.
    expect(md).toMatch(/`fake-agent` 42/);
    expect(md).toMatch(/`security` 1/);
    // The genuine top entries (a1 / a2 / style) must NOT appear in
    // the byCategory / byAgent lines.
    expect(md).not.toMatch(/`a1` 4/);
    expect(md).not.toMatch(/`a2` /);
  });
});
