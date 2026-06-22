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
});
