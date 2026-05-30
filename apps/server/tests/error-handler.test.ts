import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

/**
 * The error handler should always respond with a structured JSON body
 * containing the request id, regardless of whether Sentry is configured.
 * With SENTRY_DSN unset (the default in tests) the captureException call
 * is a no-op and must not throw or block the response.
 */
describe('error handler + sentry no-op path', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    app.get('/__test/boom', async () => {
      throw new Error('deliberate test failure');
    });
    await app.ready();
  });
  afterAll(async () => app.close());

  it('returns a sanitised 500 with request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/boom' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(body.message).toBe('Internal Server Error');
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(res.headers['x-request-id']).toBe(body.requestId);
  });
});
