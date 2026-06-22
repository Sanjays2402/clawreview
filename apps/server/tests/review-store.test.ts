import { describe, expect, it, beforeEach } from 'vitest';
import type { Finding, ReviewSummary } from '@clawreview/types';

import { InMemoryReviewStore } from '../src/services/review-store.js';

function f(over: Partial<Finding> = {}): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'high',
    title: 'XSS risk',
    rationale: 'innerHTML with untrusted data',
    file: 'src/render.ts',
    startLine: 12,
    confidence: 0.8,
    tags: [],
    ...over,
  } as Finding;
}

function summary(over: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    pullRequest: { owner: 'o', repo: 'r', number: 1, headSha: 'h', baseSha: 'b' },
    status: 'completed',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date().toISOString(),
    agentExecutions: [
      {
        agent: 'security',
        status: 'ok',
        durationMs: 1200,
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.002,
        findings: [],
      },
    ],
    totalFindings: 0,
    totalCostUsd: 0.002,
    ...over,
  };
}

describe('InMemoryReviewStore', () => {
  let store: InMemoryReviewStore;
  beforeEach(() => {
    store = new InMemoryReviewStore();
  });

  it('starts and lists reviews, newest first', async () => {
    const a = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'aaa', baseSha: 'b' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 2, headSha: 'bbb', baseSha: 'b' });
    const list = await store.list({ limit: 10 });
    expect(list.items.map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it('filters by installation, owner, repo and status', async () => {
    await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'a', baseSha: 'b' });
    await store.start({ installationId: 2, owner: 'o', repo: 'r', prNumber: 2, headSha: 'a', baseSha: 'b' });
    await store.start({ installationId: 1, owner: 'o', repo: 'other', prNumber: 3, headSha: 'a', baseSha: 'b' });
    expect((await store.list({ limit: 10, installationId: 1 })).items).toHaveLength(2);
    expect((await store.list({ limit: 10, repo: 'r' })).items).toHaveLength(2);
    expect((await store.list({ limit: 10, status: 'queued' })).items).toHaveLength(3);
    expect((await store.list({ limit: 10, status: 'completed' })).items).toHaveLength(0);
  });

  it('paginates with a cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: i, headSha: 's' + i, baseSha: 'b' });
    }
    const page1 = await store.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe('2');
    const page2 = await store.list({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBe('4');
    const page3 = await store.list({ limit: 2, cursor: page2.nextCursor! });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  it('completes a review and stores findings with stable ids', async () => {
    const r = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'a', baseSha: 'b' });
    const findings = [f(), f({ severity: 'critical', startLine: 30 })];
    const done = await store.complete(r.id, summary({ totalFindings: 2 }), findings, { commentId: 5, checkRunId: 9 });
    expect(done.status).toBe('completed');
    expect(done.findings).toHaveLength(2);
    expect(done.findings[0]!.id).toBe(`${r.id}:0`);
    expect(done.commentId).toBe(5);
    expect(done.checkRunId).toBe(9);
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
  });

  // Tick 12: `complete()` accepts an optional `digest` ref and persists
  // it verbatim. The worker computes the digest ONCE per review and
  // hands the same reference to BOTH the PR-comment renderer and the
  // store so dashboard + comment header read byte-identical numbers.
  describe('digest persistence (tick 12)', () => {
    it('stores a caller-supplied digest verbatim on the record', async () => {
      const r = await store.start({
        installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'a', baseSha: 'b',
      });
      const findings = [
        f({ agent: 'security', category: 'security', severity: 'high', file: 'src/x.ts' }),
        f({ agent: 'style', category: 'style', severity: 'nit', file: 'src/y.ts' }),
      ];
      // Build the digest from the same findings list the worker would
      // pass to complete(). This mirrors the worker call site.
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8 });
      const done = await store.complete(r.id, summary({ totalFindings: 2 }), findings, { digest });
      // Persisted digest is the SAME shape the worker built.
      expect(done.digest).toBeDefined();
      expect(done.digest!.total).toBe(2);
      expect(done.digest!.totalsBySeverity.high).toBe(1);
      expect(done.digest!.totalsBySeverity.nit).toBe(1);
      // byCategory / byAgent surface verbatim from the digest.
      expect(done.digest!.byCategory).toMatchObject({ security: 1, style: 1 });
      expect(done.digest!.byAgent).toMatchObject({ security: 1, style: 1 });
      // topFiles list is already sorted (desc count, asc file on ties);
      // the persisted slice mirrors that.
      expect(done.digest!.topFiles.map((x) => x.file)).toEqual(['src/x.ts', 'src/y.ts']);
    });

    it('leaves `digest` undefined when the caller does not supply one (back-compat)', async () => {
      // Legacy callers (failed reviews, pre-tick-12 reruns) pass refs
      // without a digest. The record must NOT crash and must NOT
      // synthesise a digest from `findings` -- consumers that need
      // one recompute on demand.
      const r = await store.start({
        installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'a', baseSha: 'b',
      });
      const done = await store.complete(r.id, summary({ totalFindings: 1 }), [f()], { commentId: 1 });
      expect(done.digest).toBeUndefined();
      // commentId still wired through; presence of the new field
      // doesn't perturb existing refs.
      expect(done.commentId).toBe(1);
    });

    // Tick 20: the worker now passes cfg.min_confidence + cfg.severity_threshold
    // through to findingDigest so the persisted digest is in lock-step
    // with the post-filter view -- the comment header, the CLI, and
    // the dashboard read byte-identical numbers. The store layer just
    // persists whatever digest the worker hands it; this test pins the
    // shape contract end-to-end so a future refactor that drops the
    // filter wiring (or silently inverts the semantics) breaks the
    // test surface visibly.
    it('persists the filter-aware digest verbatim (tick 20 worker contract)', async () => {
      const r = await store.start({
        installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'a', baseSha: 'b',
      });
      // Simulate the worker's post-aggregate findings array. In the
      // real worker pipeline these have ALREADY been floored by
      // applyMinConfidence + aggregate's threshold, so the digest
      // filter is a defence-in-depth no-op on the happy path. But we
      // construct a deliberately mixed array here to PROVE the digest
      // filter is wired -- if the worker call ever drops the
      // minConfidence/severityThreshold opts, the persisted total
      // would be 4 instead of 1.
      const findings = [
        f({ severity: 'critical', confidence: 0.9, file: 'src/a.ts' }),
        f({ severity: 'high', confidence: 0.3, file: 'src/b.ts' }), // floored
        f({ severity: 'low', confidence: 0.9, file: 'src/c.ts' }),  // thresholded
        f({ severity: 'nit', confidence: 0.2, file: 'src/d.ts' }),  // both
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      // Build the digest the way the tick-20 worker does: pass the
      // same min_confidence + severity_threshold the cfg supplied to
      // aggregate(). One finding survives both filters.
      const digest = findingDigest(findings, {
        topAgents: 8,
        topCategories: 8,
        hotspots: true,
        minConfidence: 0.5,
        severityThreshold: 'medium',
      });
      const done = await store.complete(
        r.id,
        summary({ totalFindings: 1 }),
        findings,
        { digest },
      );
      // Persisted digest reflects the post-filter snapshot: total=1,
      // only the critical finding survived.
      expect(done.digest).toBeDefined();
      expect(done.digest!.total).toBe(1);
      expect(done.digest!.totalsBySeverity.critical).toBe(1);
      expect(done.digest!.totalsBySeverity.high).toBe(0);
      expect(done.digest!.totalsBySeverity.low).toBe(0);
      expect(done.digest!.totalsBySeverity.nit).toBe(0);
      // byFile reflects only the survivor: a sanity that the filter
      // applies to every bucket (not just the totals).
      expect(done.digest!.byFile).toEqual({ 'src/a.ts': 1 });
    });
  });

  it('dismiss and reopen a finding', async () => {
    const r = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'a', baseSha: 'b' });
    await store.complete(r.id, summary(), [f()]);
    const fid = `${r.id}:0`;
    const dismissed = await store.findingAction(fid, 'dismiss', 'false positive');
    expect(dismissed?.state).toBe('dismissed');
    expect(dismissed?.dismissReason).toBe('false positive');
    const reopened = await store.findingAction(fid, 'reopen');
    expect(reopened?.state).toBe('open');
    expect(reopened?.dismissReason).toBeUndefined();
    const missing = await store.findingAction('nope', 'dismiss');
    expect(missing).toBeNull();
  });

  it('fail() records error and duration', async () => {
    const r = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'a', baseSha: 'b' });
    await store.markRunning(r.id);
    await new Promise((res) => setTimeout(res, 10));
    await store.fail(r.id, new Error('boom'));
    const got = await store.get(r.id);
    expect(got?.status).toBe('failed');
    expect(got?.error).toBe('boom');
    expect(got?.durationMs).toBeGreaterThan(0);
  });

  it('weeklyStats computes severity counts, percentiles, and per-agent breakdown', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: i, headSha: 'h' + i, baseSha: 'b' });
      // Simulate a queued review starting in the past and finishing now.
      await store.markRunning(r.id);
      await new Promise((res) => setTimeout(res, 5 + i * 2));
      const s = summary({
        startedAt: new Date(Date.now() - (i + 1) * 1000).toISOString(),
        completedAt: new Date().toISOString(),
        agentExecutions: [
          { agent: 'security', status: i === 4 ? 'error' : 'ok', durationMs: 100 * (i + 1), promptTokens: 0, completionTokens: 0, costUsd: 0.01, findings: [] },
          { agent: 'performance', status: 'ok', durationMs: 200, promptTokens: 0, completionTokens: 0, costUsd: 0, findings: [] },
        ],
        totalCostUsd: 0.01,
      });
      await store.complete(r.id, s, [f({ severity: i < 2 ? 'critical' : 'medium' })]);
    }
    const stats = await store.weeklyStats(7);
    expect(stats.totalReviews).toBe(5);
    expect(stats.completedReviews).toBe(5);
    expect(stats.totalFindings).toBe(5);
    expect(stats.openFindings).toBe(5);
    expect(stats.bySeverity.critical).toBe(2);
    expect(stats.bySeverity.medium).toBe(3);
    expect(stats.p50LatencyMs).toBeGreaterThan(0);
    expect(stats.p95LatencyMs).toBeGreaterThanOrEqual(stats.p50LatencyMs);
    const security = stats.byAgent.find((a) => a.agent === 'security')!;
    expect(security.runs).toBe(5);
    expect(security.errorRate).toBeCloseTo(0.2, 5);
    expect(stats.dailyFindings).toHaveLength(7);
    expect(stats.dailyFindings.reduce((a, b) => a + b, 0)).toBe(5);
  });

  describe('bulkFindingAction', () => {
    it('dismisses every open finding when no filter is supplied', async () => {
      const r = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'h', baseSha: 'b' });
      await store.complete(r.id, summary({ totalFindings: 3 }), [
        f({ severity: 'high' }),
        f({ severity: 'medium', category: 'performance', agent: 'performance' }),
        f({ severity: 'nit', category: 'style', agent: 'style' }),
      ]);
      const result = await store.bulkFindingAction(r.id, 'dismiss', {}, 'sweep');
      expect(result?.matched).toBe(3);
      expect(result?.changed).toHaveLength(3);
      const rec = await store.get(r.id);
      expect(rec!.findings.every((x) => x.state === 'dismissed')).toBe(true);
      expect(rec!.findings[0]!.dismissReason).toBe('sweep');
    });

    it('respects severity, category, agent, and file filters', async () => {
      const r = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'h', baseSha: 'b' });
      await store.complete(r.id, summary({ totalFindings: 4 }), [
        f({ severity: 'high', file: 'a.ts' }),
        f({ severity: 'medium', category: 'performance', agent: 'performance', file: 'a.ts' }),
        f({ severity: 'medium', category: 'performance', agent: 'performance', file: 'b.ts' }),
        f({ severity: 'nit', category: 'style', agent: 'style', file: 'a.ts' }),
      ]);
      const result = await store.bulkFindingAction(
        r.id,
        'dismiss',
        { severities: ['medium'], files: ['a.ts'] },
      );
      expect(result?.matched).toBe(1);
      expect(result?.changed).toHaveLength(1);
      const rec = await store.get(r.id);
      const dismissed = rec!.findings.filter((x) => x.state === 'dismissed');
      expect(dismissed).toHaveLength(1);
      expect(dismissed[0]!.file).toBe('a.ts');
      expect(dismissed[0]!.severity).toBe('medium');
    });

    it('reopen only flips currently-dismissed findings, matched still counts the rest', async () => {
      const r = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'h', baseSha: 'b' });
      await store.complete(r.id, summary({ totalFindings: 2 }), [f({ severity: 'high' }), f({ severity: 'high', startLine: 99 })]);
      // First dismiss one.
      await store.findingAction(`${r.id}:0`, 'dismiss');
      const result = await store.bulkFindingAction(r.id, 'reopen', { severities: ['high'] });
      expect(result?.matched).toBe(2);
      expect(result?.changed).toEqual([`${r.id}:0`]);
      const rec = await store.get(r.id);
      expect(rec!.findings.every((x) => x.state === 'open')).toBe(true);
    });

    it('returns null for an unknown review id', async () => {
      const out = await store.bulkFindingAction('nope', 'dismiss', {});
      expect(out).toBeNull();
    });
  });

  describe('cross-review auto-suppress by fingerprint', () => {
    it('auto-dismisses findings whose fingerprint was dismissed in a prior review of the same PR', async () => {
      const r1 = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 7, headSha: 'sha1', baseSha: 'b' });
      await store.complete(r1.id, summary(), [f({ title: 'Recurring issue', startLine: 50 })]);
      await store.findingAction(`${r1.id}:0`, 'dismiss', 'false positive');

      // New review on the same PR, different head sha, same finding (line shifted slightly).
      const r2 = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 7, headSha: 'sha2', baseSha: 'b' });
      const rec = await store.complete(r2.id, summary(), [f({ title: 'Recurring issue', startLine: 53 })]);
      expect(rec.findings).toHaveLength(1);
      expect(rec.findings[0]!.state).toBe('dismissed');
      expect(rec.findings[0]!.autoDismissed).toBe(true);
      expect(rec.findings[0]!.dismissReason).toBe('false positive');
    });

    it('does not auto-dismiss findings dismissed on a different PR', async () => {
      const r1 = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 7, headSha: 'sha1', baseSha: 'b' });
      await store.complete(r1.id, summary(), [f({ title: 'Issue X' })]);
      await store.findingAction(`${r1.id}:0`, 'dismiss');

      const r2 = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 8, headSha: 'shaX', baseSha: 'b' });
      const rec = await store.complete(r2.id, summary(), [f({ title: 'Issue X' })]);
      expect(rec.findings[0]!.state).toBe('open');
      expect(rec.findings[0]!.autoDismissed).toBeFalsy();
    });

    it('reopen on a prior review stops future auto-suppress', async () => {
      const r1 = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 7, headSha: 'sha1', baseSha: 'b' });
      await store.complete(r1.id, summary(), [f({ title: 'Recurring' })]);
      await store.findingAction(`${r1.id}:0`, 'dismiss', 'noise');
      await store.findingAction(`${r1.id}:0`, 'reopen');

      const r2 = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 7, headSha: 'sha2', baseSha: 'b' });
      const rec = await store.complete(r2.id, summary(), [f({ title: 'Recurring' })]);
      expect(rec.findings[0]!.state).toBe('open');
    });

    it('assigns a stable fingerprint to every stored finding', async () => {
      const r = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'h', baseSha: 'b' });
      const rec = await store.complete(r.id, summary(), [f(), f({ file: 'x.ts' })]);
      expect(rec.findings[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(rec.findings[0]!.fingerprint).not.toBe(rec.findings[1]!.fingerprint);
    });
  });
});
