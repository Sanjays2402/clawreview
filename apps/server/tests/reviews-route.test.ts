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
});
