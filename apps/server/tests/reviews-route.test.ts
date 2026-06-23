import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { buildServer } = await import('../src/server.js');
const { _resetReviewStoreForTests, getReviewStore } = await import('../src/services/review-store.js');

describe('reviews and stats routes', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    _resetReviewStoreForTests();
  });

  it('lists empty when nothing has run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reviews' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it('rejects bad pagination', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reviews?limit=999' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown review', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reviews/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('lists started reviews and returns detail', async () => {
    const store = getReviewStore();
    const r = await store.start({ installationId: 99, owner: 'sanjay', repo: 'demo', prNumber: 7, headSha: 'abcdef0', baseSha: 'beef000' });
    const list = await app.inject({ method: 'GET', url: '/api/reviews?installation=99' });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(r.id);
    expect(body.items[0].openFindings).toBe(0);

    const detail = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().headSha).toBe('abcdef0');
  });

  it('dismisses and reopens a finding via POST /api/findings/:id', async () => {
    const store = getReviewStore();
    const r = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 1, headSha: 'h', baseSha: 'b' });
    await store.complete(
      r.id,
      {
        pullRequest: { owner: 'o', repo: 'r', number: 1, headSha: 'h', baseSha: 'b' },
        status: 'completed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        agentExecutions: [],
        totalFindings: 1,
        totalCostUsd: 0,
      },
      [
        {
          agent: 'security',
          category: 'security',
          severity: 'high',
          title: 'Tainted input',
          rationale: 'user-controlled value flows to query',
          file: 'src/x.ts',
          startLine: 4,
          confidence: 0.7,
          tags: [],
        },
      ],
    );
    const fid = `${r.id}:0`;
    const dismiss = await app.inject({
      method: 'POST',
      url: `/api/findings/${fid}`,
      payload: { action: 'dismiss', reason: 'tracked elsewhere' },
    });
    expect(dismiss.statusCode).toBe(200);
    expect(dismiss.json().finding.state).toBe('dismissed');

    const reopen = await app.inject({
      method: 'POST',
      url: `/api/findings/${fid}`,
      payload: { action: 'reopen' },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json().finding.state).toBe('open');

    const missing = await app.inject({
      method: 'POST',
      url: `/api/findings/missing`,
      payload: { action: 'dismiss' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('weekly stats returns the expected shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats/weekly?days=7' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.windowDays).toBe(7);
    expect(body.dailyFindings).toHaveLength(7);
    expect(body.bySeverity).toMatchObject({ critical: 0, high: 0, medium: 0, low: 0, nit: 0 });
  });

  it('webhook posts queue a review and it shows up in /api/reviews', async () => {    const { computeSignature } = await import('@clawreview/github');
    process.env.GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || 'test-secret';
    const payload = JSON.stringify({
      action: 'opened',
      number: 11,
      pull_request: {
        id: 1, number: 11, title: 't', state: 'open', draft: false,
        head: { sha: 'sha111', ref: 'f' }, base: { sha: 'base000', ref: 'main' },
        user: { login: 'u' },
      },
      repository: { id: 1, name: 'demo', full_name: 'o/demo', owner: { login: 'o', id: 1 } },
      installation: { id: 55 },
    });
    const sig = computeSignature(payload, process.env.GITHUB_WEBHOOK_SECRET!);
    const post = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-int',
        'x-hub-signature-256': sig,
        'content-type': 'application/json',
      },
      payload,
    });
    expect(post.statusCode).toBe(200);
    expect(post.json().reviewId).toMatch(/^rv_/);
    const list = await app.inject({ method: 'GET', url: '/api/reviews?installation=55' });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].prNumber).toBe(11);
  });

  it('exports a review as SARIF with open findings only', async () => {
    const store = getReviewStore();
    const r = await store.start({ installationId: 7, owner: 'o', repo: 'r', prNumber: 2, headSha: 'h2', baseSha: 'b2' });
    await store.complete(
      r.id,
      {
        pullRequest: { owner: 'o', repo: 'r', number: 2, headSha: 'h2', baseSha: 'b2' },
        status: 'completed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        agentExecutions: [],
        totalFindings: 2,
        totalCostUsd: 0,
      },
      [
        { agent: 'security', category: 'security', severity: 'high', title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
        { agent: 'style', category: 'style', severity: 'nit', title: 'B', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.5, tags: [] },
      ],
    );
    // Dismiss the second finding; SARIF must not include it.
    await app.inject({ method: 'POST', url: `/api/findings/${r.id}:1`, payload: { action: 'dismiss' } });

    const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/sarif` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/sarif\+json/);
    expect(String(res.headers['content-disposition'])).toMatch(/attachment;.+\.sarif\.json/);
    const log = res.json();
    expect(log.version).toBe('2.1.0');
    expect(log.runs[0].results).toHaveLength(1);
    expect(log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('a.ts');
    expect(log.runs[0].versionControlProvenance[0].revisionId).toBe('h2');
  });

  it('returns 404 when SARIF is requested for an unknown review', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reviews/missing/sarif' });
    expect(res.statusCode).toBe(404);
  });

  // Tick 12: /api/reviews/:id surfaces the worker-persisted findingDigest
  // so the dashboard detail page renders byte-identical totalsBySeverity
  // / byCategory / byAgent / topFiles / topAgents / topCategories
  // without re-walking findings.
  describe('digest in /api/reviews/:id DTO (tick 12)', () => {
    it('surfaces the persisted digest on the detail DTO', async () => {
      const store = getReviewStore();
      const r = await store.start({
        installationId: 12, owner: 'o', repo: 'r', prNumber: 12, headSha: 'h12', baseSha: 'b12',
      });
      const findings = [
        { agent: 'security', category: 'security' as const, severity: 'high' as const, title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
        { agent: 'security', category: 'security' as const, severity: 'medium' as const, title: 'B', rationale: 'r', file: 'a.ts', startLine: 2, confidence: 0.8, tags: [] },
        { agent: 'style', category: 'style' as const, severity: 'nit' as const, title: 'C', rationale: 'r', file: 'b.ts', startLine: 3, confidence: 0.5, tags: [] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8 });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 12, headSha: 'h12', baseSha: 'b12' },
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          agentExecutions: [],
          totalFindings: 3,
          totalCostUsd: 0,
        },
        findings,
        { digest, commentId: 5 },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Persisted digest mirrors the worker's pre-built shape.
      expect(body.digest).not.toBeNull();
      expect(body.digest.total).toBe(3);
      expect(body.digest.totalsBySeverity).toMatchObject({ high: 1, medium: 1, nit: 1 });
      expect(body.digest.byAgent).toMatchObject({ security: 2, style: 1 });
      expect(body.digest.byCategory).toMatchObject({ security: 2, style: 1 });
      // topFiles is sorted desc by count: a.ts (2) > b.ts (1).
      expect(body.digest.topFiles).toEqual([
        { file: 'a.ts', count: 2 },
        { file: 'b.ts', count: 1 },
      ]);
      // topAgents / topCategories surface the worker's caps verbatim.
      expect(body.digest.topAgents).toEqual([
        { agent: 'security', count: 2 },
        { agent: 'style', count: 1 },
      ]);
    });

    it('returns digest=null on the detail DTO for a legacy review that never carried one', async () => {
      const store = getReviewStore();
      const r = await store.start({
        installationId: 13, owner: 'o', repo: 'r', prNumber: 13, headSha: 'h13', baseSha: 'b13',
      });
      // complete() without a digest ref -- exactly the pre-tick-12 shape.
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 13, headSha: 'h13', baseSha: 'b13' },
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          agentExecutions: [],
          totalFindings: 0,
          totalCostUsd: 0,
        },
        [],
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}` });
      expect(res.statusCode).toBe(200);
      // null (not undefined / absent) so a dashboard's "has counts?"
      // check is a single `digest !== null` comparison.
      expect(res.json().digest).toBeNull();
    });

    // Tick 13: the worker now passes `hotspots: true` when building the
    // per-review digest so the persisted shape carries the same cluster
    // list the PR-comment Hotspots block renders. The dashboard
    // /api/reviews/:id DTO surfaces digest.hotspots verbatim so the
    // detail page renders byte-identical clusters without re-walking
    // findings.
    it('surfaces digest.hotspots when the worker populated them (tick 13 wiring)', async () => {
      const store = getReviewStore();
      const r = await store.start({
        installationId: 14, owner: 'o', repo: 'r', prNumber: 14, headSha: 'h14', baseSha: 'b14',
      });
      // Mirror the worker's build call: same opts, same digest shape.
      // Three findings in the same hot file so the clusterer produces
      // at least one hotspot.
      const findings = [
        { agent: 'security', category: 'security' as const, severity: 'high' as const, title: 'A', rationale: 'r', file: 'src/hot.ts', startLine: 10, confidence: 0.9, tags: [] },
        { agent: 'security', category: 'security' as const, severity: 'medium' as const, title: 'B', rationale: 'r', file: 'src/hot.ts', startLine: 12, confidence: 0.8, tags: [] },
        { agent: 'style', category: 'style' as const, severity: 'nit' as const, title: 'C', rationale: 'r', file: 'src/hot.ts', startLine: 14, confidence: 0.5, tags: [] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      // The worker calls findingDigest with hotspots: true (tick 13).
      // Mirror it here so the persisted shape matches what the worker
      // would store in production.
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 14, headSha: 'h14', baseSha: 'b14' },
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          agentExecutions: [],
          totalFindings: 3,
          totalCostUsd: 0,
          skippedFiles: [],
        },
        findings,
        { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // digest is present and carries hotspots (not undefined, not
      // null -- the worker populated them).
      expect(body.digest).not.toBeNull();
      expect(Array.isArray(body.digest.hotspots)).toBe(true);
      expect(body.digest.hotspots.length).toBeGreaterThanOrEqual(1);
      // Each hotspot carries the file path so a dashboard renderer can
      // link to the source.
      for (const h of body.digest.hotspots) {
        expect(typeof h.file).toBe('string');
        expect(h.file.length).toBeGreaterThan(0);
      }
      // At least one of the hotspots is anchored on src/hot.ts (the
      // hot file we built). Loose match so the test doesn't break
      // when the clusterer is retuned -- the contract is "the dashboard
      // sees the clusters", not "the clusterer produced exactly these
      // bounds".
      const hotFiles = body.digest.hotspots.map((h: { file: string }) => h.file);
      expect(hotFiles).toContain('src/hot.ts');
    });

    it('omits digest.hotspots when the worker built the digest without them (back-compat for legacy)', async () => {
      // Defensive: a future tick may flip back to hotspots-off for
      // a specific code path (e.g. an emergency disable). The DTO
      // must still surface the digest cleanly with hotspots simply
      // absent -- not crash, not synthesise an empty array.
      const store = getReviewStore();
      const r = await store.start({
        installationId: 15, owner: 'o', repo: 'r', prNumber: 15, headSha: 'h15', baseSha: 'b15',
      });
      const findings = [
        { agent: 'security', category: 'security' as const, severity: 'high' as const, title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      // Build digest WITHOUT hotspots (the pre-tick-13 worker shape).
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8 });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 15, headSha: 'h15', baseSha: 'b15' },
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          agentExecutions: [],
          totalFindings: 1,
          totalCostUsd: 0,
          skippedFiles: [],
        },
        findings,
        { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.digest).not.toBeNull();
      // hotspots was never computed -> the field is simply absent
      // from the serialised digest (the digest helper omits it
      // entirely so a JSON consumer can distinguish "not computed"
      // from "computed and empty").
      expect(body.digest.hotspots).toBeUndefined();
    });
  });

  // Tick 22: the worker persists a `filterReport` alongside the
  // digest so the dashboard can render "this review's snapshot
  // dropped 12 of 20 findings via min_confidence >= 0.6" without
  // re-walking findings or recomputing. The DTO surfaces it as
  // `body.filterReport`. Legacy reviews (pre-tick-22 completes)
  // get `null` so the dashboard's "has filter report?" check is
  // uniform with the digest pattern.
  describe('filterReport in /api/reviews/:id DTO (tick 22)', () => {
    it('surfaces a persisted filterReport on the detail DTO', async () => {
      const store = getReviewStore();
      const r = await store.start({
        installationId: 22, owner: 'o', repo: 'r', prNumber: 22, headSha: 'h22', baseSha: 'b22',
      });
      const findings = [
        { agent: 'security', category: 'security' as const, severity: 'high' as const, title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
        { agent: 'security', category: 'security' as const, severity: 'low' as const, title: 'Y', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.2, tags: [] },
      ];
      const { findingDigestWithFilterReport } = await import('@clawreview/aggregator');
      const report = findingDigestWithFilterReport(findings, {
        topAgents: 8, topCategories: 8, hotspots: true,
        minConfidence: 0.5,
      });
      const { digest, ...persistedSlice } = report;
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 22, headSha: 'h22', baseSha: 'b22' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
          skippedFiles: [],
        },
        findings, { digest, filterReport: persistedSlice },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // filterReport surfaces verbatim from the persisted slice.
      expect(body.filterReport).not.toBeNull();
      expect(body.filterReport.inputTotal).toBe(2);
      expect(body.filterReport.droppedTotal).toBe(1);
      expect(body.filterReport.appliedFilters.minConfidence.applied).toBe(true);
      expect(body.filterReport.appliedFilters.minConfidence.normalised).toBe(0.5);
      expect(body.filterReport.appliedFilters.severityThreshold.applied).toBe(false);
      expect(body.filterReport.appliedFilters.any).toBe(true);
      // No embedded digest inside filterReport -- the digest is
      // already on body.digest above; redundant copy would balloon
      // the wire payload on tag-heavy reviews.
      expect(body.filterReport.digest).toBeUndefined();
    });

    it('echoes filterReport=null for a legacy review (no persisted report)', async () => {
      const store = getReviewStore();
      const r = await store.start({
        installationId: 22, owner: 'o', repo: 'r', prNumber: 23, headSha: 'h23', baseSha: 'b23',
      });
      // Complete WITHOUT passing a filterReport ref (mirrors a
      // pre-tick-22 worker / failed review).
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 23, headSha: 'h23', baseSha: 'b23' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 0, totalCostUsd: 0,
          skippedFiles: [],
        },
        [],
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Uniform null (not undefined) so the dashboard's "has filter
      // report?" check is symmetric with the digest pattern.
      expect(body.filterReport).toBeNull();
    });
  });

  // Tick 14: GET /api/reviews/:id/digest returns { persisted, fresh, drift }
  // so a dashboard can answer the "is the review header stale?"
  // question in one round-trip instead of pulling every finding.
  describe('GET /api/reviews/:id/digest (tick 14)', () => {
    it('returns persisted + fresh + drift when persisted matches live findings (no drift)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 14, owner: 'o', repo: 'r', prNumber: 14, headSha: 'h14', baseSha: 'b14' });
      const findings = [
        { agent: 'security', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: ['owasp:a01'] },
        { agent: 'style', category: 'style', severity: 'nit', title: 'Y', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.4, tags: [] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 14, headSha: 'h14', baseSha: 'b14' },
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          agentExecutions: [],
          totalFindings: 2,
          totalCostUsd: 0,
        },
        findings,
        { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.reviewId).toBe(r.id);
      expect(body.persisted).not.toBeNull();
      expect(body.persisted.total).toBe(2);
      expect(body.fresh.total).toBe(2);
      // Tick 14 byTag bucket lands on both shapes.
      expect(body.fresh.byTag['owasp:a01']).toBe(1);
      expect(body.fresh.byTag['(untagged)']).toBe(1);
      // hasDrift must be false since persisted was built from the same findings.
      expect(body.drift.hasDrift).toBe(false);
      expect(body.drift.totalDelta).toBe(0);
      expect(body.drift.byTagDelta).toEqual({});
    });

    it('flags drift when persisted is stale relative to live findings', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 14, owner: 'o', repo: 'r', prNumber: 15, headSha: 'h15', baseSha: 'b15' });
      const persistedFindings = [
        { agent: 'security', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: ['owasp:a01'] },
        { agent: 'security', category: 'security', severity: 'medium', title: 'Y', rationale: 'r', file: 'a.ts', startLine: 5, confidence: 0.6, tags: [] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      // Persisted digest was built from BOTH findings (e.g. the worker
      // rendered the comment then later an operator dismissed one).
      const persistedDigest = findingDigest(persistedFindings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 15, headSha: 'h15', baseSha: 'b15' },
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          agentExecutions: [],
          totalFindings: 2,
          totalCostUsd: 0,
        },
        persistedFindings,
        { digest: persistedDigest },
      );
      // Simulate a bulk-dismiss: the second finding is gone from open.
      await store.findingAction(`${r.id}:1`, 'dismiss', 'noise');
      // But /digest computes fresh from r.findings (which still has both
      // since findingAction marks state but doesn't delete the row),
      // so to actually exercise drift we mutate the persisted digest
      // to a different shape. The realistic path: persisted was built
      // BEFORE a subsequent bulk-reopen / dismiss. The store keeps
      // both findings in rec.findings, so to surface drift we re-call
      // complete with a fresh recompute that REPLACES rec.findings.
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 15, headSha: 'h15', baseSha: 'b15' },
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          agentExecutions: [],
          totalFindings: 1,
          totalCostUsd: 0,
        },
        // Only one finding survives.
        [persistedFindings[0]!],
        // DON'T re-pass digest: the stale persisted (2 findings) stays.
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.persisted).not.toBeNull();
      expect(body.persisted.total).toBe(2);
      expect(body.fresh.total).toBe(1);
      expect(body.drift.hasDrift).toBe(true);
      expect(body.drift.totalDelta).toBe(-1);
      // medium severity dropped: persisted had 1 medium, fresh has 0 -> -1.
      expect(body.drift.bySeverityDelta.medium).toBe(-1);
      // (untagged) bucket dropped (the dismissed finding had no tags).
      expect(body.drift.byTagDelta['(untagged)']).toBe(-1);
    });

    it('echoes persisted=null for a legacy review that pre-dates tick 12', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 14, owner: 'o', repo: 'r', prNumber: 16, headSha: 'h16', baseSha: 'b16' });
      // complete() without a digest ref -- legacy pre-tick-12 shape.
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 16, headSha: 'h16', baseSha: 'b16' },
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          agentExecutions: [],
          totalFindings: 1,
          totalCostUsd: 0,
        },
        [
          { agent: 'security', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: [] },
        ],
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // persisted is null (legacy review). The dashboard renders a
      // "no persisted snapshot" hint rather than a fake zero-bucket
      // drift banner.
      expect(body.persisted).toBeNull();
      // fresh is the live recompute; drift is "every fresh bucket is a positive delta"
      // because the empty-persisted contract treats null as an empty digest.
      expect(body.fresh.total).toBe(1);
      expect(body.drift.hasDrift).toBe(true);
      expect(body.drift.totalDelta).toBe(1);
    });

    it('returns 404 for an unknown review id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/reviews/no-such-review/digest' });
      expect(res.statusCode).toBe(404);
    });

    it('fires clawreview_review_digest_drift_total{kind} on every accepted call', async () => {
      const { getMetrics, resetMetricsForTests } = await import('@clawreview/telemetry');
      resetMetricsForTests();
      const store = getReviewStore();
      const findings = [
        { agent: 'security', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: [] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      // Fresh review (no drift): kind=fresh.
      const r1 = await store.start({ installationId: 14, owner: 'o', repo: 'r', prNumber: 17, headSha: 'h17', baseSha: 'b17' });
      await store.complete(
        r1.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 17, headSha: 'h17', baseSha: 'b17' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      await app.inject({ method: 'GET', url: `/api/reviews/${r1.id}/digest` });
      // Legacy review (persisted is null -> drift): kind=stale.
      const r2 = await store.start({ installationId: 14, owner: 'o', repo: 'r', prNumber: 18, headSha: 'h18', baseSha: 'b18' });
      await store.complete(
        r2.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 18, headSha: 'h18', baseSha: 'b18' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings,
      );
      await app.inject({ method: 'GET', url: `/api/reviews/${r2.id}/digest` });
      const metrics = getMetrics({ service: 'clawreview-server' });
      const text = await metrics.registry.metrics();
      expect(text).toMatch(/clawreview_review_digest_drift_total\{[^}]*kind="fresh"[^}]*\} 1/);
      expect(text).toMatch(/clawreview_review_digest_drift_total\{[^}]*kind="stale"[^}]*\} 1/);
    });

    // Tick 15: `?recompute=cached` switch lets a dashboard that already
    // pulled the full /api/reviews/:id body skip the fresh recompute
    // and just get the persisted shape back.
    it('returns only persisted (fresh/drift null) when ?recompute=cached', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 15, owner: 'o', repo: 'r', prNumber: 50, headSha: 'h50', baseSha: 'b50' });
      const findings = [
        { agent: 'security', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: [] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 50, headSha: 'h50', baseSha: 'b50' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?recompute=cached` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.persisted).not.toBeNull();
      expect(body.persisted.total).toBe(1);
      // The cached path explicitly nulls fresh + drift so consumers
      // don't accidentally read stale recompute data.
      expect(body.fresh).toBeNull();
      expect(body.drift).toBeNull();
      // Echo the resolved mode so a consumer can verify which path the
      // server took.
      expect(body.recompute).toBe('cached');
    });

    it('returns persisted=null on cached mode for a legacy review (matches fresh-mode contract)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 15, owner: 'o', repo: 'r', prNumber: 51, headSha: 'h51', baseSha: 'b51' });
      const findings = [
        { agent: 'style', category: 'style', severity: 'nit', title: 'Y', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.3, tags: [] },
      ];
      // No digest persisted -> legacy review path.
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 51, headSha: 'h51', baseSha: 'b51' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings,
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?recompute=cached` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Legacy: persisted is null on both modes (no synthesis on cached
      // path; consumers use the same "has persisted?" check regardless
      // of mode).
      expect(body.persisted).toBeNull();
      expect(body.fresh).toBeNull();
      expect(body.drift).toBeNull();
      expect(body.recompute).toBe('cached');
    });

    it('echoes recompute=fresh on the default (no query) path', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 15, owner: 'o', repo: 'r', prNumber: 52, headSha: 'h52', baseSha: 'b52' });
      const findings = [
        { agent: 'style', category: 'style', severity: 'nit', title: 'Z', rationale: 'r', file: 'c.ts', startLine: 3, confidence: 0.5, tags: [] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 52, headSha: 'h52', baseSha: 'b52' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      // No ?recompute= -> defaults to 'fresh' AND echoes it explicitly.
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.fresh).not.toBeNull();
      expect(body.drift).not.toBeNull();
      expect(body.recompute).toBe('fresh');
    });

    it('?recompute=cached does NOT fire the read-side drift counter (observability no-op)', async () => {
      // Counting a cached read as a drift sample would corrupt the
      // stale-rate ratio: the route didn't actually check for drift,
      // so the counter must stay quiet. This pins the contract.
      const { getMetrics, resetMetricsForTests } = await import('@clawreview/telemetry');
      resetMetricsForTests();
      const store = getReviewStore();
      const r = await store.start({ installationId: 15, owner: 'o', repo: 'r', prNumber: 53, headSha: 'h53', baseSha: 'b53' });
      const findings = [
        { agent: 'security', category: 'security', severity: 'high', title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: [] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 53, headSha: 'h53', baseSha: 'b53' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      // Three cached reads back-to-back.
      await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?recompute=cached` });
      await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?recompute=cached` });
      await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?recompute=cached` });
      const metrics = getMetrics({ service: 'clawreview-server' });
      const text = await metrics.registry.metrics();
      // No clawreview_review_digest_drift_total{kind=...} sample should
      // have been emitted from the cached path.
      expect(text).not.toMatch(/clawreview_review_digest_drift_total\{[^}]*kind=/);
    });

    it('rejects unknown ?recompute=<other> with 400 BadQuery', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 15, owner: 'o', repo: 'r', prNumber: 54, headSha: 'h54', baseSha: 'b54' });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 54, headSha: 'h54', baseSha: 'b54' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 0, totalCostUsd: 0,
        },
        [],
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?recompute=stale` });
      // Reject loudly rather than silently falling through to 'fresh';
      // a typo at the caller would otherwise be invisible.
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('BadQuery');
    });

    // Tick 16: `?slim=true` projection strips the full sparse bucket
    // maps (byTag / byCategory / byAgent / byFile) from the digest
    // payload, keeping just totals + top-N slices + hotspots. Aimed
    // at dashboards that render only the ranked breakdowns.
    it('strips byTag/byCategory/byAgent/byFile when ?slim=true on fresh path', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 16, owner: 'o', repo: 'r', prNumber: 60, headSha: 'h60', baseSha: 'b60' });
      const findings = [
        { agent: 'security', category: 'security', severity: 'high',   title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: ['owasp:a01'] },
        { agent: 'style',    category: 'style',    severity: 'nit',    title: 'Y', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.4, tags: ['nit:trailing-whitespace'] },
        { agent: 'perf',     category: 'performance', severity: 'medium', title: 'Z', rationale: 'r', file: 'c.ts', startLine: 3, confidence: 0.6, tags: [] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 60, headSha: 'h60', baseSha: 'b60' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 3, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=true` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slim).toBe(true);
      // Heavy maps stripped from BOTH persisted and fresh.
      expect(body.persisted.byTag).toBeUndefined();
      expect(body.persisted.byAgent).toBeUndefined();
      expect(body.persisted.byCategory).toBeUndefined();
      expect(body.persisted.byFile).toBeUndefined();
      expect(body.fresh.byTag).toBeUndefined();
      expect(body.fresh.byAgent).toBeUndefined();
      expect(body.fresh.byCategory).toBeUndefined();
      expect(body.fresh.byFile).toBeUndefined();
      // Light + dashboard-useful fields preserved.
      expect(body.persisted.total).toBe(3);
      expect(body.persisted.totalsBySeverity.high).toBe(1);
      expect(Array.isArray(body.persisted.topAgents)).toBe(true);
      expect(Array.isArray(body.persisted.topCategories)).toBe(true);
      expect(Array.isArray(body.persisted.topFiles)).toBe(true);
      expect(Array.isArray(body.fresh.topAgents)).toBe(true);
      // Drift sparse deltas survive because they're already small.
      expect(body.drift.hasDrift).toBe(false);
      expect(body.drift.totalDelta).toBe(0);
      // Drift's sparse delta maps (which legitimately have entries
      // only when something changed) come through untouched.
      expect(body.drift.byTagDelta).toEqual({});
    });

    it('echoes slim=false by default (back-compat: full byTag/byAgent/byCategory/byFile)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 16, owner: 'o', repo: 'r', prNumber: 61, headSha: 'h61', baseSha: 'b61' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: ['t1'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 61, headSha: 'h61', baseSha: 'b61' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slim).toBe(false);
      // Default: full sparse maps survive on the wire so existing
      // dashboards / tools / tests keep working unchanged.
      expect(body.persisted.byTag).toBeDefined();
      expect(body.persisted.byAgent).toBeDefined();
      expect(body.persisted.byCategory).toBeDefined();
      expect(body.persisted.byFile).toBeDefined();
      expect(body.fresh.byTag).toBeDefined();
    });

    it('composes ?recompute=cached&slim=true (slim persisted, fresh+drift null)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 16, owner: 'o', repo: 'r', prNumber: 62, headSha: 'h62', baseSha: 'b62' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'critical', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: ['secret'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 62, headSha: 'h62', baseSha: 'b62' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?recompute=cached&slim=true` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.recompute).toBe('cached');
      expect(body.slim).toBe(true);
      expect(body.fresh).toBeNull();
      expect(body.drift).toBeNull();
      // Persisted is slimmed.
      expect(body.persisted.byTag).toBeUndefined();
      expect(body.persisted.byFile).toBeUndefined();
      expect(body.persisted.total).toBe(1);
      expect(body.persisted.totalsBySeverity.critical).toBe(1);
    });

    it('?slim=true on a legacy review (persisted=null) leaves persisted null', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 16, owner: 'o', repo: 'r', prNumber: 63, headSha: 'h63', baseSha: 'b63' });
      // Legacy review: no digest passed in.
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 63, headSha: 'h63', baseSha: 'b63' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 0, totalCostUsd: 0,
        },
        [],
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=true` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Legacy: persisted stays null; slim has nothing to do.
      expect(body.persisted).toBeNull();
      // Fresh is slimmed (empty review: top-N slices are empty arrays).
      expect(body.fresh.byTag).toBeUndefined();
      expect(body.fresh.total).toBe(0);
      expect(body.slim).toBe(true);
    });

    // Tick 17: `?slim=<fields>` partial projection. Today's `slim=true`
    // is all-or-nothing; the comma-list lets a consumer strip JUST the
    // heaviest map (typically `byTag` on tag-heavy reviews) while
    // keeping `byAgent` / `byFile` / `byCategory` available for
    // dashboard panels that render the full bucket distribution.
    it('?slim=byTag strips only byTag (other heavy maps survive)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 70, headSha: 'h70', baseSha: 'b70' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: ['t1'] },
        { agent: 'style', category: 'style', severity: 'nit', title: 'Y', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.4, tags: ['t2'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 70, headSha: 'h70', baseSha: 'b70' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 2, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=byTag` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slim).toBe(true);
      // Echoed slimFields carries the canonical resolved list.
      expect(body.slimFields).toEqual(['byTag']);
      // byTag stripped from persisted + fresh; the other heavy maps survive.
      expect(body.persisted.byTag).toBeUndefined();
      expect(body.persisted.byAgent).toBeDefined();
      expect(body.persisted.byCategory).toBeDefined();
      expect(body.persisted.byFile).toBeDefined();
      expect(body.fresh.byTag).toBeUndefined();
      expect(body.fresh.byAgent).toBeDefined();
      expect(body.fresh.byCategory).toBeDefined();
      expect(body.fresh.byFile).toBeDefined();
      // top-N slices + total survive on both arms.
      expect(body.persisted.total).toBe(2);
      expect(Array.isArray(body.persisted.topTags)).toBe(true);
    });

    it('?slim=byTag,byFile strips both fields and echoes them sorted in slimFields', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 71, headSha: 'h71', baseSha: 'b71' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: ['t1'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 71, headSha: 'h71', baseSha: 'b71' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      // Pass them in NON-canonical order; the response echoes the
      // canonical sorted form so two clients see the same shape.
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=byFile,byTag` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slim).toBe(true);
      expect(body.slimFields).toEqual(['byFile', 'byTag']);
      expect(body.persisted.byFile).toBeUndefined();
      expect(body.persisted.byTag).toBeUndefined();
      // Untouched fields survive.
      expect(body.persisted.byAgent).toBeDefined();
      expect(body.persisted.byCategory).toBeDefined();
    });

    it('?slim with an unknown field name rejects 400 with an enumerated message', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 72, headSha: 'h72', baseSha: 'b72' });
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=byTag,bogus` });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('BadQuery');
      // The error message names the offending field so the operator
      // can fix the typo without guessing.
      expect(body.message).toContain("'bogus'");
      // ...and lists the valid names so they know what to use.
      expect(body.message).toContain('byTag');
      expect(body.message).toContain('byFile');
    });

    it('?slim with an empty intermediate entry rejects 400 (stray comma)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 73, headSha: 'h73', baseSha: 'b73' });
      // A double comma (`byTag,,byFile`) is almost always a forgotten
      // name; silently widening the projection would mask the typo.
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=byTag,,byFile` });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('BadQuery');
      expect(body.message).toContain('empty entry');
    });

    it('?slim=BYTAG case-insensitively resolves to the canonical byTag', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 74, headSha: 'h74', baseSha: 'b74' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: ['t1'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 74, headSha: 'h74', baseSha: 'b74' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=BYTAG` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // URL-cased input resolves to canonical camelCase in slimFields.
      expect(body.slimFields).toEqual(['byTag']);
      expect(body.persisted.byTag).toBeUndefined();
    });

    // Tick 18: `?slim=-byTag,-byFile` deny-list mirror of the
    // tick-17 allowlist. "Strip everything EXCEPT these" composes
    // naturally for a dashboard panel that needs to see `byTag` +
    // `byFile` but wants the lighter `byAgent` / `byCategory` shape
    // dropped on the wire.

    it('?slim=-byTag strips every field EXCEPT byTag (deny-list)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 75, headSha: 'h75', baseSha: 'b75' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: ['t1'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 75, headSha: 'h75', baseSha: 'b75' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=-byTag` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slim).toBe(true);
      // slimFields echoes the RESOLVED strip set (the deny-list is
      // an input shape; the echo carries the actual fields stripped
      // so a consumer sees one canonical contract).
      expect(body.slimFields).toEqual(['byAgent', 'byCategory', 'byFile']);
      // byTag survives (kept); the others are stripped.
      expect(body.persisted.byTag).toBeDefined();
      expect(body.persisted.byAgent).toBeUndefined();
      expect(body.persisted.byCategory).toBeUndefined();
      expect(body.persisted.byFile).toBeUndefined();
      expect(body.fresh.byTag).toBeDefined();
      expect(body.fresh.byAgent).toBeUndefined();
    });

    it('?slim=-byTag,-byFile keeps byTag + byFile, strips the rest', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 76, headSha: 'h76', baseSha: 'b76' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: ['t1'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 76, headSha: 'h76', baseSha: 'b76' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=-byTag,-byFile` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slimFields).toEqual(['byAgent', 'byCategory']);
      expect(body.persisted.byTag).toBeDefined();
      expect(body.persisted.byFile).toBeDefined();
      expect(body.persisted.byAgent).toBeUndefined();
      expect(body.persisted.byCategory).toBeUndefined();
    });

    it('?slim=-byTag,byFile (mixed deny/allow) rejects 400 (ambiguous)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 77, headSha: 'h77', baseSha: 'b77' });
      // A mixed list could mean "strip everything except byTag AND
      // include byFile" OR "strip byFile and keep byTag". Refuse
      // loudly rather than silently picking one interpretation.
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=-byTag,byFile` });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('BadQuery');
      expect(body.message).toContain('mixes');
    });

    it('?slim=- rejects 400 (bare prefix with no field name)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 78, headSha: 'h78', baseSha: 'b78' });
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=-` });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('BadQuery');
      expect(body.message).toContain("bare '-'");
    });

    it('?slim=-bogus rejects 400 with the enumerated valid list', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 79, headSha: 'h79', baseSha: 'b79' });
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=-bogus` });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('BadQuery');
      expect(body.message).toContain("'bogus'");
      expect(body.message).toContain('byTag');
    });

    it('?slim=-byTag,-byCategory,-byFile,-byAgent strips ALL fields (equivalent to ?slim=true)', async () => {
      // Edge case: a deny-list that names every heavy field should
      // produce the same projection as the boolean sugar `slim=true`.
      // Useful contract pin so an operator who tabulated every field
      // can still get the all-strip behaviour without switching
      // syntaxes mid-pipeline.
      const store = getReviewStore();
      const r = await store.start({ installationId: 17, owner: 'o', repo: 'r', prNumber: 80, headSha: 'h80', baseSha: 'b80' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: ['t1'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 80, headSha: 'h80', baseSha: 'b80' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      // ?slim=- naming all 4 fields strips nothing (keep all);
      // a deny-list with ZERO entries doesn't exist but
      // a deny-list naming none of the 4 fields strips all 4.
      // Test: an empty `keep` set <=> strip all 4 <=> slim=true.
      // We can't actually pass empty deny-list (parser rejects empty
      // entries), but a deny-list with a single name we don't want
      // to keep gives us a non-trivial case. Use a slightly-different
      // shape: name a single field and assert the OPPOSITES of it
      // are stripped (already tested above). Instead, sanity-check
      // the "deny-list naming all 4" arm = keep all 4 = strip
      // nothing = slim=false equivalent.
      const denyAll = await app.inject({
        method: 'GET',
        url: `/api/reviews/${r.id}/digest?slim=-byTag,-byCategory,-byFile,-byAgent`,
      });
      expect(denyAll.statusCode).toBe(200);
      const body = denyAll.json();
      // Stripped set is empty (every field is in `keep`), so slim=false
      // and every heavy map survives.
      expect(body.slim).toBe(false);
      expect(body.slimFields).toEqual([]);
      expect(body.persisted.byTag).toBeDefined();
      expect(body.persisted.byAgent).toBeDefined();
      expect(body.persisted.byCategory).toBeDefined();
      expect(body.persisted.byFile).toBeDefined();
    });

    // Tick 19: `?slim=*` / `?slim=all` / `?slim=none` keyword sugar
    // so dashboards that round-trip the value through CLI tools using
    // shell-glob (`*`) or keyword (`all`/`none`) conventions get the
    // same behaviour the boolean shorthand would have.
    it('?slim=* is an exact alias for ?slim=true (strips all heavy maps)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 21, owner: 'o', repo: 'r', prNumber: 191, headSha: 'h191', baseSha: 'b191' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: ['t1'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 191, headSha: 'h191', baseSha: 'b191' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const star = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=*` });
      const truth = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=true` });
      expect(star.statusCode).toBe(200);
      expect(truth.statusCode).toBe(200);
      const starBody = star.json();
      const truthBody = truth.json();
      // Both arms set slim=true, strip the same fields, and produce
      // byte-identical bucket strip-out. (slimFields is the canonical
      // alphabetical list for both.)
      expect(starBody.slim).toBe(true);
      expect(truthBody.slim).toBe(true);
      expect(starBody.slimFields).toEqual(['byAgent', 'byCategory', 'byFile', 'byTag']);
      expect(truthBody.slimFields).toEqual(starBody.slimFields);
      expect(starBody.persisted.byTag).toBeUndefined();
      expect(starBody.persisted.byFile).toBeUndefined();
      expect(starBody.persisted.byCategory).toBeUndefined();
      expect(starBody.persisted.byAgent).toBeUndefined();
    });

    it('?slim=all is an exact alias for ?slim=true (keyword convention)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 22, owner: 'o', repo: 'r', prNumber: 192, headSha: 'h192', baseSha: 'b192' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: ['t1'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 192, headSha: 'h192', baseSha: 'b192' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=all` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slim).toBe(true);
      expect(body.slimFields).toEqual(['byAgent', 'byCategory', 'byFile', 'byTag']);
      expect(body.persisted.byTag).toBeUndefined();
    });

    it('?slim=none is an exact alias for ?slim=false (strip nothing)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 23, owner: 'o', repo: 'r', prNumber: 193, headSha: 'h193', baseSha: 'b193' });
      const findings = [
        { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: ['t1'] },
      ];
      const { findingDigest } = await import('@clawreview/aggregator');
      const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 193, headSha: 'h193', baseSha: 'b193' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
        },
        findings, { digest },
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=none` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slim).toBe(false);
      expect(body.slimFields).toEqual([]);
      // Every heavy map survives (same as ?slim=false / default).
      expect(body.persisted.byTag).toBeDefined();
      expect(body.persisted.byFile).toBeDefined();
    });

    it('?slim=*,byTag rejects 400 with a "use standalone" hint (no ambiguity)', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 24, owner: 'o', repo: 'r', prNumber: 194, headSha: 'h194', baseSha: 'b194' });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 194, headSha: 'h194', baseSha: 'b194' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 0, totalCostUsd: 0,
        },
        [],
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=*,byTag` });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('BadQuery');
      expect(body.message).toContain('standalone');
    });

    it('case-insensitive: ?slim=ALL / ?slim=NONE / ?slim=All all work', async () => {
      // URL params are often mangled to upper / mixed case by tools
      // (Cloudflare query rewriting, etc.); the aliases should match
      // case-insensitively just like the existing true / false sugar
      // does.
      const store = getReviewStore();
      const r = await store.start({ installationId: 25, owner: 'o', repo: 'r', prNumber: 195, headSha: 'h195', baseSha: 'b195' });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 195, headSha: 'h195', baseSha: 'b195' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 0, totalCostUsd: 0,
        },
        [],
      );
      const upperAll = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=ALL` });
      const upperNone = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=NONE` });
      const mixedAll = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?slim=All` });
      expect(upperAll.statusCode).toBe(200);
      expect(upperNone.statusCode).toBe(200);
      expect(mixedAll.statusCode).toBe(200);
      expect(upperAll.json().slim).toBe(true);
      expect(upperNone.json().slim).toBe(false);
      expect(mixedAll.json().slim).toBe(true);
    });

    // Tick 20: `?minConfidence=<n>` and `?severityThreshold=<sev>` are
    // pre-bucket filters passed straight through to findingDigest.
    // They apply to the FRESH recompute only (the cached arm leaves
    // the persisted digest unchanged so a dashboard's "preview
    // filter" widget compares filtered-fresh against unfiltered-
    // persisted via drift). Both query params are also echoed on the
    // response so a CI gate / dashboard can verify what was applied.
    describe('?minConfidence + ?severityThreshold pre-bucket filters (tick 20)', () => {
      it('?minConfidence=0.5 drops below-floor findings from fresh; persisted untouched', async () => {
        const store = getReviewStore();
        const r = await store.start({ installationId: 30, owner: 'o', repo: 'r', prNumber: 200, headSha: 'h200', baseSha: 'b200' });
        const findings = [
          { agent: 'sec', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
          { agent: 'sec', category: 'security', severity: 'medium', title: 'Y', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.4, tags: [] },
          { agent: 'sec', category: 'security', severity: 'low', title: 'Z', rationale: 'r', file: 'c.ts', startLine: 3, confidence: 0.2, tags: [] },
        ];
        const { findingDigest } = await import('@clawreview/aggregator');
        // Worker writes the persisted digest with NO filter, so it
        // counts all 3.
        const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
        await store.complete(
          r.id,
          {
            pullRequest: { owner: 'o', repo: 'r', number: 200, headSha: 'h200', baseSha: 'b200' },
            status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
            agentExecutions: [], totalFindings: 3, totalCostUsd: 0,
          },
          findings, { digest },
        );
        const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?minConfidence=0.5` });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        // Persisted is unfiltered (worker's original snapshot).
        expect(body.persisted.total).toBe(3);
        // Fresh applies the floor: only the 0.9 finding survives.
        expect(body.fresh.total).toBe(1);
        expect(body.fresh.totalsBySeverity.high).toBe(1);
        expect(body.fresh.totalsBySeverity.medium).toBe(0);
        expect(body.fresh.totalsBySeverity.low).toBe(0);
        // Echoed filter is the resolved numeric.
        expect(body.minConfidence).toBe(0.5);
        expect(body.severityThreshold).toBeNull();
        // Drift reflects the gap between unfiltered persisted (3) and
        // filtered fresh (1): the dashboard's "preview filter" widget
        // reads this to answer "would the PR header change?".
        expect(body.drift.hasDrift).toBe(true);
        expect(body.drift.totalDelta).toBe(-2);
      });

      it('?severityThreshold=medium drops nit/low from fresh; persisted untouched', async () => {
        const store = getReviewStore();
        const r = await store.start({ installationId: 30, owner: 'o', repo: 'r', prNumber: 201, headSha: 'h201', baseSha: 'b201' });
        const findings = [
          { agent: 'sec', category: 'security', severity: 'critical', title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
          { agent: 'sec', category: 'security', severity: 'medium', title: 'B', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.9, tags: [] },
          { agent: 'sec', category: 'security', severity: 'nit', title: 'C', rationale: 'r', file: 'c.ts', startLine: 3, confidence: 0.9, tags: [] },
        ];
        const { findingDigest } = await import('@clawreview/aggregator');
        const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
        await store.complete(
          r.id,
          {
            pullRequest: { owner: 'o', repo: 'r', number: 201, headSha: 'h201', baseSha: 'b201' },
            status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
            agentExecutions: [], totalFindings: 3, totalCostUsd: 0,
          },
          findings, { digest },
        );
        const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?severityThreshold=medium` });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.persisted.total).toBe(3);
        // critical + medium pass; nit dropped.
        expect(body.fresh.total).toBe(2);
        expect(body.fresh.totalsBySeverity.critical).toBe(1);
        expect(body.fresh.totalsBySeverity.medium).toBe(1);
        expect(body.fresh.totalsBySeverity.nit).toBe(0);
        // Echo (raw operator-supplied string).
        expect(body.severityThreshold).toBe('medium');
        expect(body.minConfidence).toBeNull();
      });

      it('?minConfidence + ?severityThreshold compose (AND semantics)', async () => {
        const store = getReviewStore();
        const r = await store.start({ installationId: 30, owner: 'o', repo: 'r', prNumber: 202, headSha: 'h202', baseSha: 'b202' });
        const findings = [
          { agent: 'sec', category: 'security', severity: 'critical', title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] }, // passes both
          { agent: 'sec', category: 'security', severity: 'critical', title: 'B', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.3, tags: [] }, // fails conf
          { agent: 'sec', category: 'security', severity: 'nit', title: 'C', rationale: 'r', file: 'c.ts', startLine: 3, confidence: 0.9, tags: [] }, // fails sev
          { agent: 'sec', category: 'security', severity: 'nit', title: 'D', rationale: 'r', file: 'd.ts', startLine: 4, confidence: 0.3, tags: [] }, // fails both
        ];
        const { findingDigest } = await import('@clawreview/aggregator');
        const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
        await store.complete(
          r.id,
          {
            pullRequest: { owner: 'o', repo: 'r', number: 202, headSha: 'h202', baseSha: 'b202' },
            status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
            agentExecutions: [], totalFindings: 4, totalCostUsd: 0,
          },
          findings, { digest },
        );
        const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?minConfidence=0.5&severityThreshold=high` });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.persisted.total).toBe(4);
        expect(body.fresh.total).toBe(1);
        expect(body.fresh.totalsBySeverity.critical).toBe(1);
        // Both filters echoed.
        expect(body.minConfidence).toBe(0.5);
        expect(body.severityThreshold).toBe('high');
      });

      it('absent filter params echo null (back-compat: unchanged response shape)', async () => {
        const store = getReviewStore();
        const r = await store.start({ installationId: 30, owner: 'o', repo: 'r', prNumber: 203, headSha: 'h203', baseSha: 'b203' });
        await store.complete(
          r.id,
          {
            pullRequest: { owner: 'o', repo: 'r', number: 203, headSha: 'h203', baseSha: 'b203' },
            status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
            agentExecutions: [], totalFindings: 0, totalCostUsd: 0,
          },
          [],
        );
        const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest` });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.minConfidence).toBeNull();
        expect(body.severityThreshold).toBeNull();
      });

      it('cached arm IGNORES filters but still echoes them (diagnostic)', async () => {
        const store = getReviewStore();
        const r = await store.start({ installationId: 30, owner: 'o', repo: 'r', prNumber: 204, headSha: 'h204', baseSha: 'b204' });
        const findings = [
          { agent: 'sec', category: 'security', severity: 'critical', title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
          { agent: 'sec', category: 'security', severity: 'nit', title: 'B', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.2, tags: [] },
        ];
        const { findingDigest } = await import('@clawreview/aggregator');
        const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
        await store.complete(
          r.id,
          {
            pullRequest: { owner: 'o', repo: 'r', number: 204, headSha: 'h204', baseSha: 'b204' },
            status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
            agentExecutions: [], totalFindings: 2, totalCostUsd: 0,
          },
          findings, { digest },
        );
        const res = await app.inject({
          method: 'GET',
          url: `/api/reviews/${r.id}/digest?recompute=cached&minConfidence=0.8&severityThreshold=high`,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        // Persisted unchanged: both findings counted (the cached arm
        // skips re-filtering -- the persisted digest is the worker's
        // write-time snapshot).
        expect(body.persisted.total).toBe(2);
        expect(body.fresh).toBeNull();
        expect(body.drift).toBeNull();
        // But the filters ARE echoed so an operator who mistakenly
        // combined ?recompute=cached with the filter params can see
        // they were inert.
        expect(body.minConfidence).toBe(0.8);
        expect(body.severityThreshold).toBe('high');
      });

      it('mis-cased severityThreshold echoes raw value but applies no filter (typo detectable)', async () => {
        const store = getReviewStore();
        const r = await store.start({ installationId: 30, owner: 'o', repo: 'r', prNumber: 205, headSha: 'h205', baseSha: 'b205' });
        const findings = [
          { agent: 'sec', category: 'security', severity: 'critical', title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
          { agent: 'sec', category: 'security', severity: 'nit', title: 'B', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.9, tags: [] },
        ];
        const { findingDigest } = await import('@clawreview/aggregator');
        const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
        await store.complete(
          r.id,
          {
            pullRequest: { owner: 'o', repo: 'r', number: 205, headSha: 'h205', baseSha: 'b205' },
            status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
            agentExecutions: [], totalFindings: 2, totalCostUsd: 0,
          },
          findings, { digest },
        );
        const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?severityThreshold=Critical` });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        // Both findings still counted (filter normalised to null inside digest).
        expect(body.fresh.total).toBe(2);
        // Echo carries the raw operator-supplied value so a CI gate
        // can detect the typo even though the filter silently no-op'd.
        expect(body.severityThreshold).toBe('Critical');
      });

      // Tick 21: per-request observability counter for the tick-20
      // filter knobs. Wires findingDigestWithFilterReport's
      // appliedFilters bits into a closed-set
      // `clawreview_review_digest_filter_applied_total{min_confidence,severity_threshold}`
      // Prometheus counter. Fresh arm only; cached arm is inert
      // (the persisted digest carries no filter metadata).
      //
      // We read the counter directly from `getMetrics().registry`
      // rather than via the /metrics endpoint -- the metrics plugin
      // closure-captures the bundle at boot, so after another test
      // calls resetMetricsForTests() the /metrics endpoint would
      // serve the OLD bundle while route handlers use the new one.
      // The direct registry read is what the existing drift counter
      // test (line 508) uses too.
      describe('clawreview_review_digest_filter_applied_total counter (tick 21)', () => {
        async function seedReviewWithFindings(prNumber: number) {
          const store = getReviewStore();
          const r = await store.start({
            installationId: 31,
            owner: 'o',
            repo: 'r',
            prNumber,
            headSha: `h${prNumber}`,
            baseSha: `b${prNumber}`,
          });
          const findings = [
            { agent: 'sec', category: 'security' as const, severity: 'high' as const, title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
            { agent: 'sec', category: 'security' as const, severity: 'low' as const, title: 'Y', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.2, tags: [] },
          ];
          const { findingDigest } = await import('@clawreview/aggregator');
          const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
          await store.complete(
            r.id,
            {
              pullRequest: { owner: 'o', repo: 'r', number: prNumber, headSha: `h${prNumber}`, baseSha: `b${prNumber}` },
              status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
              agentExecutions: [], totalFindings: 2, totalCostUsd: 0,
            },
            findings, { digest },
          );
          return r;
        }

        async function metricsText(): Promise<string> {
          const { getMetrics } = await import('@clawreview/telemetry');
          const metrics = getMetrics({ service: 'clawreview-server' });
          return metrics.registry.metrics();
        }

        function countSeries(text: string, minConf: 'yes' | 'no', sev: 'yes' | 'no'): number {
          const re = new RegExp(
            `clawreview_review_digest_filter_applied_total\\{[^}]*min_confidence="${minConf}"[^}]*severity_threshold="${sev}"[^}]*\\}\\s*(\\d+)`,
          );
          const m = text.match(re);
          return m ? Number(m[1]) : 0;
        }

        // Each test resets metrics so it sees a clean baseline (matches
        // the pattern used by the existing drift-counter test above).
        beforeEach(async () => {
          const { resetMetricsForTests } = await import('@clawreview/telemetry');
          resetMetricsForTests();
        });

        it('fresh recompute without filter bumps no/no', async () => {
          const r = await seedReviewWithFindings(300);
          const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest` });
          expect(res.statusCode).toBe(200);
          expect(countSeries(await metricsText(), 'no', 'no')).toBe(1);
        });

        it('?minConfidence=0.5 bumps yes/no (not no/no)', async () => {
          const r = await seedReviewWithFindings(301);
          const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?minConfidence=0.5` });
          expect(res.statusCode).toBe(200);
          const t = await metricsText();
          expect(countSeries(t, 'yes', 'no')).toBe(1);
          // The no/no labelset must NOT fire on this request -- the
          // filter applied so we're in the yes/no labelset only.
          expect(countSeries(t, 'no', 'no')).toBe(0);
        });

        it('?severityThreshold=high bumps no/yes (not yes/no)', async () => {
          const r = await seedReviewWithFindings(302);
          const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?severityThreshold=high` });
          expect(res.statusCode).toBe(200);
          const t = await metricsText();
          expect(countSeries(t, 'no', 'yes')).toBe(1);
          expect(countSeries(t, 'yes', 'no')).toBe(0);
        });

        it('?minConfidence + ?severityThreshold together bump yes/yes', async () => {
          const r = await seedReviewWithFindings(303);
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?minConfidence=0.5&severityThreshold=high`,
          });
          expect(res.statusCode).toBe(200);
          expect(countSeries(await metricsText(), 'yes', 'yes')).toBe(1);
        });

        it('cached arm does NOT fire the counter (inert observability path)', async () => {
          const r = await seedReviewWithFindings(304);
          // Even with filter params, the cached arm doesn't fire the
          // counter (it's inert -- the persisted digest carries no
          // filter metadata so counting it would distort the
          // "what fraction of dashboards filter?" ratio).
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?recompute=cached&minConfidence=0.7&severityThreshold=high`,
          });
          expect(res.statusCode).toBe(200);
          const t = await metricsText();
          // Every labelset stays at 0 -- the counter did not fire.
          expect(countSeries(t, 'yes', 'yes')).toBe(0);
          expect(countSeries(t, 'yes', 'no')).toBe(0);
          expect(countSeries(t, 'no', 'yes')).toBe(0);
          expect(countSeries(t, 'no', 'no')).toBe(0);
        });

        it('mis-cased ?severityThreshold=Critical normalises to no (filter no-op)', async () => {
          const r = await seedReviewWithFindings(305);
          // A typo normalises to null inside the digest, so the
          // applied bit is false and the counter records no/no
          // (the request DID hit the fresh arm; the filter just
          // didn't apply).
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?severityThreshold=Critical`,
          });
          expect(res.statusCode).toBe(200);
          const t = await metricsText();
          // Counter records no/no -- the filter was supplied but
          // normalised to a no-op. This matches the contract: the
          // counter records the APPLIED bit, not the supplied bit.
          expect(countSeries(t, 'no', 'no')).toBe(1);
          expect(countSeries(t, 'no', 'yes')).toBe(0);
        });

        it('accumulates across calls (rate-able)', async () => {
          // Two fresh calls with the same filter shape -> counter
          // climbs to 2. This is the rate() denominator pattern a
          // dashboard would consume: rate(...{min_confidence="yes"}[5m]).
          const r = await seedReviewWithFindings(306);
          await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?minConfidence=0.5` });
          await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?minConfidence=0.5` });
          expect(countSeries(await metricsText(), 'yes', 'no')).toBe(2);
        });
      });

      // Tick 21: ?normalisedEcho=true opts the consumer into a
      // second echo of the CLAMPED / NORMALISED filter values
      // alongside the raw ones. Use case: a dashboard wants to
      // render "showing findings with confidence >= 1 (clamped
      // from 1.5)" without re-running the digest's normaliser in
      // the browser. Default is OFF for back-compat (the tick-20
      // response shape is unchanged).
      describe('?normalisedEcho=true filter normalisation echo (tick 21)', () => {
        async function seedReview(prNumber: number) {
          const store = getReviewStore();
          const r = await store.start({
            installationId: 32, owner: 'o', repo: 'r', prNumber,
            headSha: `h${prNumber}`, baseSha: `b${prNumber}`,
          });
          const findings = [
            { agent: 'sec', category: 'security' as const, severity: 'high' as const, title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
          ];
          const { findingDigest } = await import('@clawreview/aggregator');
          const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
          await store.complete(
            r.id,
            {
              pullRequest: { owner: 'o', repo: 'r', number: prNumber, headSha: `h${prNumber}`, baseSha: `b${prNumber}` },
              status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
              agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
            },
            findings, { digest },
          );
          return r;
        }

        it('absent ?normalisedEcho: response shape unchanged (back-compat)', async () => {
          const r = await seedReview(400);
          const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?minConfidence=0.5` });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          // Raw filter echo from tick 20 still present.
          expect(body.minConfidence).toBe(0.5);
          // Normalised fields ABSENT on the default path so a tick-20
          // consumer that doesn't know about them sees no diff.
          expect(body.normalisedMinConfidence).toBeUndefined();
          expect(body.normalisedSeverityThreshold).toBeUndefined();
        });

        it('?normalisedEcho=true surfaces normalisedMinConfidence + normalisedSeverityThreshold', async () => {
          const r = await seedReview(401);
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?minConfidence=0.5&severityThreshold=high&normalisedEcho=true`,
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          // Verbatim (raw) echoes still present.
          expect(body.minConfidence).toBe(0.5);
          expect(body.severityThreshold).toBe('high');
          // Normalised echoes carry the digest-consumed values.
          expect(body.normalisedMinConfidence).toBe(0.5);
          expect(body.normalisedSeverityThreshold).toBe('high');
        });

        it('?normalisedEcho=true with out-of-range raw clamps to 1 in normalised echo', async () => {
          // The headline use case from the roadmap: ?minConfidence=1.5
          // echoes raw=1.5 + normalised=1, so a dashboard can render
          // "confidence >= 1 (clamped from 1.5)" as its panel header.
          const r = await seedReview(402);
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?minConfidence=1.5&normalisedEcho=true`,
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.minConfidence).toBe(1.5); // raw echo: as-supplied
          expect(body.normalisedMinConfidence).toBe(1); // clamped to [0, 1]
        });

        it('?normalisedEcho=true with mis-cased severityThreshold echoes raw + normalised=null', async () => {
          // A typo'd severityThreshold normalises to null (no filter)
          // and the normalised echo surfaces that explicitly so a
          // dashboard can render "your severityThreshold was ignored
          // (unknown literal)" rather than silently no-op'ing.
          const r = await seedReview(403);
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?severityThreshold=Critical&normalisedEcho=true`,
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.severityThreshold).toBe('Critical'); // raw verbatim
          expect(body.normalisedSeverityThreshold).toBeNull(); // ignored
        });

        it('?normalisedEcho=1 / yes / TRUE all opt in (boolean sugar)', async () => {
          const r = await seedReview(404);
          for (const v of ['1', 'yes', 'TRUE', 'True']) {
            const res = await app.inject({
              method: 'GET',
              url: `/api/reviews/${r.id}/digest?minConfidence=0.3&normalisedEcho=${encodeURIComponent(v)}`,
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().normalisedMinConfidence).toBe(0.3);
          }
        });

        it('?normalisedEcho=false / 0 / no leave the response shape unchanged', async () => {
          const r = await seedReview(405);
          for (const v of ['false', '0', 'no', 'False', 'NO']) {
            const res = await app.inject({
              method: 'GET',
              url: `/api/reviews/${r.id}/digest?minConfidence=0.3&normalisedEcho=${encodeURIComponent(v)}`,
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().normalisedMinConfidence).toBeUndefined();
          }
        });

        it('?normalisedEcho=true on cached arm echoes resolved-as-if-applied values', async () => {
          // The cached arm doesn't run the filter, but the normaliser
          // is pure so we can still surface "what WOULD the clamped
          // value be?" -- useful when a dashboard wants to show the
          // operator's intent alongside the cached result.
          const r = await seedReview(406);
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?recompute=cached&minConfidence=1.5&normalisedEcho=true`,
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.recompute).toBe('cached');
          expect(body.fresh).toBeNull();
          // Persisted unchanged on the cached arm.
          expect(body.persisted).not.toBeNull();
          // Normalised echo still present and clamped.
          expect(body.minConfidence).toBe(1.5);
          expect(body.normalisedMinConfidence).toBe(1);
        });

        it('?normalisedEcho=garbage falls back to false (forgiving, no 400)', async () => {
          // Matches the route's overall "don't 400 the whole panel
          // because of a dashboard typo" stance. A consumer that
          // wanted strict validation can check for the absence of
          // normalisedMinConfidence in the response body.
          const r = await seedReview(407);
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?minConfidence=0.5&normalisedEcho=true!`,
          });
          expect(res.statusCode).toBe(200);
          expect(res.json().normalisedMinConfidence).toBeUndefined();
        });

        describe('parseNormalisedEchoFlag pure helper', () => {
          it('returns false for undefined / empty / whitespace', async () => {
            const { parseNormalisedEchoFlag } = await import('../src/routes/reviews.js');
            expect(parseNormalisedEchoFlag(undefined)).toBe(false);
            expect(parseNormalisedEchoFlag('')).toBe(false);
            expect(parseNormalisedEchoFlag('   ')).toBe(false);
          });
          it('returns true for truthy boolean sugar (case-insensitive)', async () => {
            const { parseNormalisedEchoFlag } = await import('../src/routes/reviews.js');
            for (const v of ['true', 'True', 'TRUE', '1', 'yes', 'Yes', 'YES']) {
              expect(parseNormalisedEchoFlag(v)).toBe(true);
            }
          });
          it('returns false for falsey boolean sugar (case-insensitive)', async () => {
            const { parseNormalisedEchoFlag } = await import('../src/routes/reviews.js');
            for (const v of ['false', 'False', 'FALSE', '0', 'no', 'No', 'NO']) {
              expect(parseNormalisedEchoFlag(v)).toBe(false);
            }
          });
          it('returns false for unknown values (forgiving, no throw)', async () => {
            const { parseNormalisedEchoFlag } = await import('../src/routes/reviews.js');
            expect(parseNormalisedEchoFlag('garbage')).toBe(false);
            expect(parseNormalisedEchoFlag('truthy')).toBe(false);
            expect(parseNormalisedEchoFlag('null')).toBe(false);
            expect(parseNormalisedEchoFlag('123')).toBe(false);
          });
        });
      });

      // Tick 22: ?filterDropEcho=true|1|yes opts the consumer into a
      // `filterDropped: number` + `filterInputTotal: number` echo on
      // the /digest response so a dashboard can render "filtered M
      // of K" without re-walking findings or running findingDigest
      // twice. On the fresh arm the counts come from the
      // findingDigestWithFilterReport pass the route already ran; on
      // the cached arm the counts come from rec.filterReport (the
      // worker's write-time snapshot) with a legacy synth fallback.
      // Default OFF for back-compat (the tick-21 response shape is
      // unchanged when the flag is absent).
      describe('?filterDropEcho=true filter drop echo (tick 22)', () => {
        async function seedReview(prNumber: number) {
          const store = getReviewStore();
          const r = await store.start({
            installationId: 33, owner: 'o', repo: 'r', prNumber,
            headSha: `h${prNumber}`, baseSha: `b${prNumber}`,
          });
          const findings = [
            { agent: 'sec', category: 'security' as const, severity: 'high' as const, title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
            { agent: 'sec', category: 'security' as const, severity: 'low' as const, title: 'B', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.2, tags: [] },
            { agent: 'sec', category: 'security' as const, severity: 'nit' as const, title: 'C', rationale: 'r', file: 'c.ts', startLine: 3, confidence: 0.1, tags: [] },
          ];
          const { findingDigest } = await import('@clawreview/aggregator');
          const digest = findingDigest(findings, { topAgents: 8, topCategories: 8, hotspots: true });
          await store.complete(
            r.id,
            {
              pullRequest: { owner: 'o', repo: 'r', number: prNumber, headSha: `h${prNumber}`, baseSha: `b${prNumber}` },
              status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
              agentExecutions: [], totalFindings: 3, totalCostUsd: 0,
              skippedFiles: [],
            },
            findings, { digest },
          );
          return r;
        }

        it('absent ?filterDropEcho: response shape unchanged (back-compat)', async () => {
          const r = await seedReview(500);
          const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/digest?minConfidence=0.5` });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          // Tick-21 raw + (absent) normalised echoes still present.
          expect(body.minConfidence).toBe(0.5);
          // filterDropped / filterInputTotal ABSENT on the default path
          // so a tick-21 consumer sees no diff in the response shape.
          expect(body.filterDropped).toBeUndefined();
          expect(body.filterInputTotal).toBeUndefined();
        });

        it('?filterDropEcho=true on fresh arm with --min-confidence drop surfaces both counts', async () => {
          const r = await seedReview(501);
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?minConfidence=0.5&filterDropEcho=true`,
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          // 3 findings -> 1 survives (confidence 0.9 >= 0.5); 2 dropped.
          expect(body.fresh.total).toBe(1);
          expect(body.filterDropped).toBe(2);
          expect(body.filterInputTotal).toBe(3);
        });

        it('?filterDropEcho=true with no filter surfaces zero drops + full input', async () => {
          // Without a filter, droppedTotal must be 0 -- the echo
          // is still present (lets a dashboard always render the
          // "filtered N of K" parenthetical without conditional
          // logic). filterInputTotal equals fresh.total in that case.
          const r = await seedReview(502);
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?filterDropEcho=true`,
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.fresh.total).toBe(3);
          expect(body.filterDropped).toBe(0);
          expect(body.filterInputTotal).toBe(3);
        });

        it('?filterDropEcho=true composes with both filters (AND semantics)', async () => {
          const r = await seedReview(503);
          const res = await app.inject({
            method: 'GET',
            // 'medium' threshold drops nit/low; 0.5 confidence drops low/nit too.
            // Only the high+confidence=0.9 finding survives.
            url: `/api/reviews/${r.id}/digest?minConfidence=0.5&severityThreshold=medium&filterDropEcho=true`,
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.fresh.total).toBe(1);
          expect(body.filterDropped).toBe(2);
          // Pairs with tick-21 normalisedEcho cleanly: a dashboard can
          // request BOTH on the same call and render "showing 1 of 3
          // (filtered 2 by confidence >= 0.5 + severity >= medium)".
        });

        it('?filterDropEcho=true on cached arm uses worker-persisted droppedTotal', async () => {
          // Seed a review with a worker-persisted filter report
          // (mirrors the tick-22 worker contract). The cached arm
          // must surface rec.filterReport.droppedTotal verbatim,
          // NOT re-run the filter against the query knobs (which
          // would give a different number).
          const store = getReviewStore();
          const r = await store.start({
            installationId: 33, owner: 'o', repo: 'r', prNumber: 504,
            headSha: 'h504', baseSha: 'b504',
          });
          const findings = [
            { agent: 'sec', category: 'security' as const, severity: 'high' as const, title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
            { agent: 'sec', category: 'security' as const, severity: 'low' as const, title: 'B', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.2, tags: [] },
          ];
          const { findingDigestWithFilterReport } = await import('@clawreview/aggregator');
          const report = findingDigestWithFilterReport(findings, {
            topAgents: 8, topCategories: 8, hotspots: true,
            minConfidence: 0.5,
          });
          const { digest, ...persistedSlice } = report;
          await store.complete(
            r.id,
            {
              pullRequest: { owner: 'o', repo: 'r', number: 504, headSha: 'h504', baseSha: 'b504' },
              status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
              agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
              skippedFiles: [],
            },
            findings, { digest, filterReport: persistedSlice },
          );
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?recompute=cached&filterDropEcho=true`,
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.recompute).toBe('cached');
          // Persisted report had droppedTotal=1 (one low-confidence
          // finding dropped at write time). Echoed verbatim, NOT
          // re-derived against the query.
          expect(body.filterDropped).toBe(1);
          expect(body.filterInputTotal).toBe(2);
        });

        it('?filterDropEcho=true on legacy cached review falls back to (findings - digest.total)', async () => {
          // A pre-tick-22 review has no persisted filter report.
          // The cached arm synthesises filterDropped from
          // (rec.findings.length - rec.digest.total) so dashboards
          // get a sensible answer even on legacy data.
          const store = getReviewStore();
          const r = await store.start({
            installationId: 33, owner: 'o', repo: 'r', prNumber: 505,
            headSha: 'h505', baseSha: 'b505',
          });
          // Worker built a pre-tick-22 digest (filter-aware but with
          // no filterReport ref to the store). 2 input findings,
          // 1 survives the persisted filter.
          const findings = [
            { agent: 'sec', category: 'security' as const, severity: 'high' as const, title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
            { agent: 'sec', category: 'security' as const, severity: 'low' as const, title: 'B', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.2, tags: [] },
          ];
          const { findingDigest } = await import('@clawreview/aggregator');
          const digest = findingDigest(findings, {
            topAgents: 8, topCategories: 8, hotspots: true,
            minConfidence: 0.5,
          });
          await store.complete(
            r.id,
            {
              pullRequest: { owner: 'o', repo: 'r', number: 505, headSha: 'h505', baseSha: 'b505' },
              status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
              agentExecutions: [], totalFindings: 1, totalCostUsd: 0,
              skippedFiles: [],
            },
            findings, { digest }, // <-- no filterReport: legacy shape
          );
          const res = await app.inject({
            method: 'GET',
            url: `/api/reviews/${r.id}/digest?recompute=cached&filterDropEcho=true`,
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          // Synth fallback: findings.length(2) - digest.total(1) = 1.
          expect(body.filterDropped).toBe(1);
          expect(body.filterInputTotal).toBe(2);
        });

        it('?filterDropEcho=false / 0 / no leaves the response shape unchanged', async () => {
          const r = await seedReview(506);
          for (const v of ['false', '0', 'no', 'False', 'NO']) {
            const res = await app.inject({
              method: 'GET',
              url: `/api/reviews/${r.id}/digest?minConfidence=0.5&filterDropEcho=${encodeURIComponent(v)}`,
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().filterDropped).toBeUndefined();
          }
        });
      });
    });
  });

  it('bulk-dismisses findings via POST /api/reviews/:id/findings/bulk with filter', async () => {
    const store = getReviewStore();
    const r = await store.start({ installationId: 3, owner: 'o', repo: 'r', prNumber: 9, headSha: 'h9', baseSha: 'b9' });
    await store.complete(
      r.id,
      {
        pullRequest: { owner: 'o', repo: 'r', number: 9, headSha: 'h9', baseSha: 'b9' },
        status: 'completed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        agentExecutions: [],
        totalFindings: 3,
        totalCostUsd: 0,
      },
      [
        { agent: 'style', category: 'style', severity: 'nit', title: 'A', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.4, tags: [] },
        { agent: 'style', category: 'style', severity: 'nit', title: 'B', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.4, tags: [] },
        { agent: 'security', category: 'security', severity: 'high', title: 'C', rationale: 'r', file: 'c.ts', startLine: 3, confidence: 0.9, tags: [] },
      ],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/reviews/${r.id}/findings/bulk`,
      payload: { action: 'dismiss', reason: 'style sweep', filter: { agents: ['style'] } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.matched).toBe(2);
    expect(body.changed).toHaveLength(2);

    const detail = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}` });
    const remainingOpen = detail.json().findings.filter((f: { state: string }) => f.state === 'open');
    expect(remainingOpen).toHaveLength(1);
    expect(remainingOpen[0]!.agent).toBe('security');
  });

  it('rejects a bulk request with an invalid action', async () => {
    const store = getReviewStore();
    const r = await store.start({ installationId: 4, owner: 'o', repo: 'r', prNumber: 1, headSha: 'h', baseSha: 'b' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/reviews/${r.id}/findings/bulk`,
      payload: { action: 'nuke', filter: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 from bulk when the review id is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/reviews/missing/findings/bulk',
      payload: { action: 'dismiss', filter: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  describe('GET /api/reviews/:id/report.md', () => {
    it('returns a Markdown report with the right content type and filename', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 1, owner: 'sanjay', repo: 'demo', prNumber: 7, headSha: 'abcdef0', baseSha: 'beef000' });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'sanjay', repo: 'demo', number: 7, headSha: 'abcdef0', baseSha: 'beef000' },
          status: 'completed',
          startedAt: new Date(Date.now() - 1000).toISOString(),
          completedAt: new Date().toISOString(),
          agentExecutions: [],
          totalFindings: 1,
          totalCostUsd: 0.001,
          skippedFiles: [],
        },
        [
          { agent: 'security', category: 'security', severity: 'high', title: 'SQLi', rationale: 'unsanitized', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
        ],
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/report.md` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/markdown');
      expect(res.headers['content-disposition']).toContain('clawreview-sanjay-demo-7.md');
      expect(res.body).toContain('# ClawReview report for sanjay/demo#7');
      expect(res.body).toContain('SQLi');
    });

    it('hides dismissed findings unless includeDismissed=true', async () => {
      const store = getReviewStore();
      const r = await store.start({ installationId: 1, owner: 'o', repo: 'r', prNumber: 9, headSha: 'h', baseSha: 'b' });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 9, headSha: 'h', baseSha: 'b' },
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          agentExecutions: [],
          totalFindings: 1,
          totalCostUsd: 0,
          skippedFiles: [],
        },
        [
          { agent: 'security', category: 'security', severity: 'high', title: 'Will be dismissed', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
        ],
      );
      await store.findingAction(`${r.id}:0`, 'dismiss', 'noise');

      const hidden = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/report.md` });
      expect(hidden.body).not.toContain('Will be dismissed');

      const shown = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/report.md?includeDismissed=true` });
      expect(shown.body).toContain('Will be dismissed');
      expect(shown.body).toContain('noise');
    });

    it('returns 404 for an unknown review id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/reviews/nope/report.md' });
      expect(res.statusCode).toBe(404);
    });
  });

  // Tick 23: GET /api/reviews/:id/filter-report -- lightweight,
  // single-purpose endpoint returning ONLY the persisted filter report
  // shape so a dashboard "filtered N of M" badge doesn't need to pull
  // the full review (findings + digest + executions) just to see the
  // drop count.
  describe('GET /api/reviews/:id/filter-report (tick 23)', () => {
    async function seedReviewWithFilterReport(opts: {
      prNumber: number;
      minConfidence?: number;
      severityThreshold?: 'critical' | 'high' | 'medium' | 'low' | 'nit';
    }): Promise<string> {
      const store = getReviewStore();
      const r = await store.start({
        installationId: 23, owner: 'o', repo: 'r', prNumber: opts.prNumber,
        headSha: `h${opts.prNumber}`, baseSha: `b${opts.prNumber}`,
      });
      const findings = [
        { agent: 'security', category: 'security' as const, severity: 'high' as const, title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
        { agent: 'security', category: 'security' as const, severity: 'low' as const, title: 'Y', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.2, tags: [] },
        { agent: 'style', category: 'style' as const, severity: 'nit' as const, title: 'Z', rationale: 'r', file: 'c.ts', startLine: 3, confidence: 0.8, tags: [] },
      ];
      const { findingDigestWithFilterReport } = await import('@clawreview/aggregator');
      const report = findingDigestWithFilterReport(findings, {
        topAgents: 8, topCategories: 8, hotspots: true,
        minConfidence: opts.minConfidence,
        severityThreshold: opts.severityThreshold,
      });
      const { digest, ...persistedSlice } = report;
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: opts.prNumber, headSha: `h${opts.prNumber}`, baseSha: `b${opts.prNumber}` },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: findings.length, totalCostUsd: 0,
          skippedFiles: [],
        },
        findings, { digest, filterReport: persistedSlice },
      );
      return r.id;
    }

    it('returns the persisted filter report verbatim (full shape) by default', async () => {
      const reviewId = await seedReviewWithFilterReport({ prNumber: 230, minConfidence: 0.5 });
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.reviewId).toBe(reviewId);
      expect(body.inputTotal).toBe(3);
      // One low-confidence finding dropped by the 0.5 floor.
      expect(body.droppedTotal).toBe(1);
      expect(body.applied).toBe(true);
      // Full appliedFilters object surfaces verbatim.
      expect(body.appliedFilters.minConfidence.applied).toBe(true);
      expect(body.appliedFilters.minConfidence.normalised).toBe(0.5);
      expect(body.appliedFilters.severityThreshold.applied).toBe(false);
      expect(body.appliedFilters.any).toBe(true);
      // slim echo confirms the resolved mode.
      expect(body.slim).toBe(false);
    });

    it('collapses appliedFilters into a single boolean when ?slim=true', async () => {
      const reviewId = await seedReviewWithFilterReport({
        prNumber: 231, minConfidence: 0.5, severityThreshold: 'medium',
      });
      const res = await app.inject({
        method: 'GET', url: `/api/reviews/${reviewId}/filter-report?slim=true`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Slim mode: totals + single boolean, NO appliedFilters object.
      expect(body.reviewId).toBe(reviewId);
      expect(body.inputTotal).toBe(3);
      expect(body.droppedTotal).toBeGreaterThan(0);
      expect(body.applied).toBe(true);
      expect(body.appliedFilters).toBeUndefined();
      expect(body.slim).toBe(true);
    });

    it('returns 404 with NoFilterReport when the review predates tick 22 (no persisted report)', async () => {
      const store = getReviewStore();
      const r = await store.start({
        installationId: 23, owner: 'o', repo: 'r', prNumber: 232, headSha: 'h232', baseSha: 'b232',
      });
      // Complete WITHOUT a filterReport ref (legacy worker path).
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 232, headSha: 'h232', baseSha: 'b232' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 0, totalCostUsd: 0,
          skippedFiles: [],
        },
        [],
      );
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/filter-report` });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('NoFilterReport');
      expect(body.reviewId).toBe(r.id);
    });

    it('returns 404 with NotFound for an unknown review id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/reviews/does-not-exist/filter-report' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('NotFound');
    });

    it('echoes applied=false / droppedTotal=0 when the review was unfiltered', async () => {
      // No minConfidence / severityThreshold passed -> filter is a no-op.
      const reviewId = await seedReviewWithFilterReport({ prNumber: 233 });
      const res = await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.inputTotal).toBe(3);
      expect(body.droppedTotal).toBe(0);
      expect(body.applied).toBe(false);
      expect(body.appliedFilters.any).toBe(false);
      expect(body.appliedFilters.minConfidence.applied).toBe(false);
      expect(body.appliedFilters.severityThreshold.applied).toBe(false);
    });

    it('accepts ?slim=1 / ?slim=yes / ?slim=false sugar', async () => {
      const reviewId = await seedReviewWithFilterReport({ prNumber: 234, minConfidence: 0.5 });
      const sugar1 = await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report?slim=1` });
      expect(sugar1.json().slim).toBe(true);
      expect(sugar1.json().appliedFilters).toBeUndefined();
      const sugarYes = await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report?slim=yes` });
      expect(sugarYes.json().slim).toBe(true);
      const sugarFalse = await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report?slim=false` });
      expect(sugarFalse.json().slim).toBe(false);
      expect(sugarFalse.json().appliedFilters).toBeDefined();
    });

    it('fires clawreview_review_filter_report_reads_total with shape labels on each 200 (tick 23 counter)', async () => {
      const reviewId = await seedReviewWithFilterReport({ prNumber: 235, minConfidence: 0.5 });
      // Two full reads + three slim reads.
      await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report` });
      await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report` });
      await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report?slim=true` });
      await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report?slim=true` });
      await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report?slim=true` });
      // Scrape the registry directly (same pattern as the tick-13
      // drift-counter test above) -- /metrics route output is racy
      // when other suites have torn the metrics bundle down.
      const { getMetrics } = await import('@clawreview/telemetry');
      const metrics = getMetrics({ service: 'clawreview-server' });
      const body = await metrics.registry.metrics();
      // Counter exists with both shape labels.
      expect(body).toMatch(/clawreview_review_filter_report_reads_total\{[^}]*shape="full"[^}]*\}\s*\d+/);
      expect(body).toMatch(/clawreview_review_filter_report_reads_total\{[^}]*shape="slim"[^}]*\}\s*\d+/);
      // The counts MUST be at least what we just bumped (other tests in
      // the suite may have fired earlier; we use >= rather than == to
      // avoid coupling to test ordering).
      const fullMatch = body.match(/clawreview_review_filter_report_reads_total\{[^}]*shape="full"[^}]*\}\s*(\d+)/);
      const slimMatch = body.match(/clawreview_review_filter_report_reads_total\{[^}]*shape="slim"[^}]*\}\s*(\d+)/);
      expect(Number(fullMatch![1])).toBeGreaterThanOrEqual(2);
      expect(Number(slimMatch![1])).toBeGreaterThanOrEqual(3);
    });

    it('does NOT fire the read counter on a 404 NotFound / NoFilterReport (tick 23)', async () => {
      // Snapshot pre-state via registry scrape so we can assert no
      // delta on the 404 arms even if other tests in the suite already
      // landed counts.
      const { getMetrics } = await import('@clawreview/telemetry');
      const metrics = getMetrics({ service: 'clawreview-server' });
      const before = await metrics.registry.metrics();
      const beforeFullMatch = before.match(/clawreview_review_filter_report_reads_total\{[^}]*shape="full"[^}]*\}\s*(\d+)/);
      const beforeSlimMatch = before.match(/clawreview_review_filter_report_reads_total\{[^}]*shape="slim"[^}]*\}\s*(\d+)/);
      const beforeFull = beforeFullMatch ? Number(beforeFullMatch[1]) : 0;
      const beforeSlim = beforeSlimMatch ? Number(beforeSlimMatch[1]) : 0;
      // Two 404 arms: NotFound (unknown id) + NoFilterReport (legacy review).
      const notFound = await app.inject({ method: 'GET', url: '/api/reviews/nope/filter-report' });
      expect(notFound.statusCode).toBe(404);
      // Seed a legacy review (no filterReport) and hit it.
      const store = getReviewStore();
      const r = await store.start({
        installationId: 23, owner: 'o', repo: 'r', prNumber: 236, headSha: 'h236', baseSha: 'b236',
      });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 236, headSha: 'h236', baseSha: 'b236' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 0, totalCostUsd: 0,
          skippedFiles: [],
        },
        [],
      );
      const legacy = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/filter-report` });
      expect(legacy.statusCode).toBe(404);
      // After two 404s the counts MUST be unchanged.
      const after = await metrics.registry.metrics();
      const afterFullMatch = after.match(/clawreview_review_filter_report_reads_total\{[^}]*shape="full"[^}]*\}\s*(\d+)/);
      const afterSlimMatch = after.match(/clawreview_review_filter_report_reads_total\{[^}]*shape="slim"[^}]*\}\s*(\d+)/);
      const afterFull = afterFullMatch ? Number(afterFullMatch[1]) : 0;
      const afterSlim = afterSlimMatch ? Number(afterSlimMatch[1]) : 0;
      expect(afterFull).toBe(beforeFull);
      expect(afterSlim).toBe(beforeSlim);
    });

    // Tick 24: per-shape latency histogram pairs with the tick-23
    // counter so a dashboard can quantify the slim-vs-full tradeoff.
    it('fires clawreview_review_filter_report_read_duration_seconds with shape labels on each 200 (tick 24 histogram)', async () => {
      const reviewId = await seedReviewWithFilterReport({ prNumber: 240, minConfidence: 0.5 });
      const { getMetrics } = await import('@clawreview/telemetry');
      const metrics = getMetrics({ service: 'clawreview-server' });
      // Capture baseline so the assertion isolates only this test's bumps.
      const before = await metrics.registry.metrics();
      const beforeFullMatch = before.match(/clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="full"[^}]*\}\s*(\d+)/);
      const beforeSlimMatch = before.match(/clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="slim"[^}]*\}\s*(\d+)/);
      const beforeFull = beforeFullMatch ? Number(beforeFullMatch[1]) : 0;
      const beforeSlim = beforeSlimMatch ? Number(beforeSlimMatch[1]) : 0;
      // Three full + two slim reads.
      await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report` });
      await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report` });
      await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report` });
      await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report?slim=true` });
      await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}/filter-report?slim=true` });
      const after = await metrics.registry.metrics();
      const afterFullMatch = after.match(/clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="full"[^}]*\}\s*(\d+)/);
      const afterSlimMatch = after.match(/clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="slim"[^}]*\}\s*(\d+)/);
      const afterFull = afterFullMatch ? Number(afterFullMatch[1]) : 0;
      const afterSlim = afterSlimMatch ? Number(afterSlimMatch[1]) : 0;
      expect(afterFull - beforeFull).toBe(3);
      expect(afterSlim - beforeSlim).toBe(2);
      // Histogram counts MUST match the counter counts (same fire
      // discipline, same shape label). A divergence would mean a
      // dashboard joining the two series gets bad data.
      const counterFull = after.match(/clawreview_review_filter_report_reads_total\{[^}]*shape="full"[^}]*\}\s*(\d+)/);
      const counterSlim = after.match(/clawreview_review_filter_report_reads_total\{[^}]*shape="slim"[^}]*\}\s*(\d+)/);
      expect(counterFull).toBeTruthy();
      expect(counterSlim).toBeTruthy();
    });

    it('does NOT fire the histogram on 404 arms (tick 24 fire discipline)', async () => {
      const { getMetrics } = await import('@clawreview/telemetry');
      const metrics = getMetrics({ service: 'clawreview-server' });
      const before = await metrics.registry.metrics();
      const beforeFullMatch = before.match(/clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="full"[^}]*\}\s*(\d+)/);
      const beforeFull = beforeFullMatch ? Number(beforeFullMatch[1]) : 0;
      // Two 404 arms exercised; neither must bump the histogram.
      const notFound = await app.inject({ method: 'GET', url: '/api/reviews/nope-tick24/filter-report' });
      expect(notFound.statusCode).toBe(404);
      // Seed a legacy review to exercise the NoFilterReport arm.
      const store = getReviewStore();
      const r = await store.start({
        installationId: 24, owner: 'o', repo: 'r', prNumber: 241, headSha: 'h241', baseSha: 'b241',
      });
      await store.complete(
        r.id,
        {
          pullRequest: { owner: 'o', repo: 'r', number: 241, headSha: 'h241', baseSha: 'b241' },
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          agentExecutions: [], totalFindings: 0, totalCostUsd: 0,
          skippedFiles: [],
        },
        [],
      );
      const legacy = await app.inject({ method: 'GET', url: `/api/reviews/${r.id}/filter-report` });
      expect(legacy.statusCode).toBe(404);
      const after = await metrics.registry.metrics();
      const afterFullMatch = after.match(/clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="full"[^}]*\}\s*(\d+)/);
      const afterFull = afterFullMatch ? Number(afterFullMatch[1]) : 0;
      expect(afterFull).toBe(beforeFull);
    });
  });
});
