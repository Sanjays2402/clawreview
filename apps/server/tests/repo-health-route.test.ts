import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { buildServer } = await import('../src/server.js');
const { _resetRepoHealthForTests, getRepoHealth } = await import('../src/services/repo-health.js');

describe('repo health routes', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    _resetRepoHealthForTests();
  });

  it('lists empty when nothing has been tracked', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/repos/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it('returns 404 for unknown repo detail', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/repos/o/r/health' });
    expect(res.statusCode).toBe(404);
  });

  it('manual pause then resume flips state', async () => {
    const pause = await app.inject({
      method: 'POST',
      url: '/api/repos/o/r/pause',
      payload: { reason: 'maintenance' },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().state.manuallyPaused).toBe(true);
    expect(getRepoHealth().isPaused('o', 'r')).toBe(true);

    const resume = await app.inject({ method: 'POST', url: '/api/repos/o/r/resume' });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().state.manuallyPaused).toBe(false);
    expect(getRepoHealth().isPaused('o', 'r')).toBe(false);
  });

  it('resume on an unknown repo returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/repos/o/missing/resume' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an absurd duration on pause', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/o/r/pause',
      payload: { durationMs: 999 * 86400_000 },
    });
    expect(res.statusCode).toBe(400);
  });
});
