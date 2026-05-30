import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

describe('health endpoints', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());

  it('returns ok on /healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('returns shape on /readyz with skipLlm=1', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz?skipLlm=1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.queue.backend).toBe('memory');
    expect(body.checks.queue.ok).toBe(true);
    expect(body.checks.llm).toBeUndefined();
  });

  it('returns version info', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('clawreview-server');
  });
});
