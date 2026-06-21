import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';
import { getQueue, REVIEW_JOB } from '../src/queue.js';

/**
 * Smoke-tests the /api/internal/queue endpoint. The server runs with
 * NODE_ENV=test so InMemoryQueue is the shared adapter; we drive it
 * directly to seed pending jobs and assert the route returns the same
 * snapshot via HTTP.
 */
describe('GET /api/internal/queue', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());

  it('returns backend, totals, byName, and recentFailures', async () => {
    const queue = getQueue();
    await queue.enqueue(REVIEW_JOB, { synthetic: true });
    await queue.enqueue(REVIEW_JOB, { synthetic: true });

    const res = await app.inject({ method: 'GET', url: '/api/internal/queue' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestId).toBeTruthy();
    expect(body.backend).toBe('memory');
    expect(body.ok).toBe(true);
    expect(body.pending).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.byName)).toBe(true);
    const reviewRow = body.byName.find(
      (r: { name: string }) => r.name === REVIEW_JOB,
    );
    expect(reviewRow?.pending).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.recentFailures)).toBe(true);
    expect(body.sampledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
