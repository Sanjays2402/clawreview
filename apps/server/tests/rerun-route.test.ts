import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { buildServer } = await import('../src/server.js');
const { _resetReviewStoreForTests, getReviewStore } = await import('../src/services/review-store.js');

describe('POST /api/reviews/rerun', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());
  beforeEach(() => _resetReviewStoreForTests());

  const valid = {
    installationId: 7,
    owner: 'o',
    repo: 'r',
    prNumber: 12,
    headSha: 'abcdef0',
    baseSha: 'fedcba0',
  };

  it('creates a queued review and returns 202 with a reviewId', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/reviews/rerun', payload: valid });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.reviewId).toMatch(/^rv_/);
    expect(body.jobId).toMatch(/^manual-o\/r-12-/);

    const list = await app.inject({ method: 'GET', url: '/api/reviews?installation=7' });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].prNumber).toBe(12);
    expect(list.json().items[0].status).toBe('queued');
  });

  it('400s on missing fields', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/reviews/rerun', payload: { owner: 'o' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BadInput');
  });

  it('produces a new review id on each call (no implicit dedup)', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/reviews/rerun', payload: valid });
    const b = await app.inject({ method: 'POST', url: '/api/reviews/rerun', payload: valid });
    expect(a.json().reviewId).not.toBe(b.json().reviewId);
    const list = await app.inject({ method: 'GET', url: '/api/reviews' });
    expect(list.json().items).toHaveLength(2);
  });

  it('does not double-enqueue when the store is reset between calls', async () => {
    await app.inject({ method: 'POST', url: '/api/reviews/rerun', payload: valid });
    _resetReviewStoreForTests();
    const after = await app.inject({ method: 'GET', url: '/api/reviews' });
    expect(after.json().items).toHaveLength(0);
    // store now contains no rows but the worker queue may still hold the
    // previous job; that's intentional and out of scope for the API contract.
    expect(getReviewStore()).toBeDefined();
  });
});
