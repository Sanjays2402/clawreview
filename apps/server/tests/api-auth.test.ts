import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.API_AUTH_TOKENS = 'dashboard:supersecrettoken-aaaa,ci:anothersecret-bbbb';

const { buildServer } = await import('../src/server.js');
const { _internals } = await import('../src/plugins/api-auth.js');

describe('api auth plugin', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());

  it('parses named and anonymous tokens', () => {
    const out = _internals.loadTokens('name1:tok1, tok2 ,name3:tok3');
    expect(out.map((t) => t.name)).toEqual(['name1', 'token-2', 'name3']);
    expect(out.map((t) => t.buf.toString())).toEqual(['tok1', 'tok2', 'tok3']);
  });

  it('treats /healthz, /readyz, /metrics and /webhooks as public', () => {
    expect(_internals.isPublicPath('/healthz')).toBe(true);
    expect(_internals.isPublicPath('/readyz')).toBe(true);
    expect(_internals.isPublicPath('/metrics')).toBe(true);
    expect(_internals.isPublicPath('/webhooks/github')).toBe(true);
    expect(_internals.isPublicPath('/api/reviews')).toBe(false);
  });

  it('rejects /api/* without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reviews' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    expect(res.json()).toMatchObject({ error: 'Unauthorized' });
  });

  it('rejects /api/* with a wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reviews',
      headers: { authorization: 'Bearer not-the-right-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid Bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reviews',
      headers: { authorization: 'Bearer supersecrettoken-aaaa' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts x-api-key header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reviews',
      headers: { 'x-api-key': 'anothersecret-bbbb' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('still serves /healthz and /metrics without a token', async () => {
    const h = await app.inject({ method: 'GET', url: '/healthz' });
    expect(h.statusCode).toBe(200);
    const m = await app.inject({ method: 'GET', url: '/metrics' });
    expect(m.statusCode).toBe(200);
  });

  it('still accepts unauthenticated webhooks (HMAC-verified separately)', async () => {
    // No signature header, so the webhook route itself returns 401 with
    // its own signature-failure message; auth middleware must not pre-empt
    // with the bearer-token 401.
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    const body = res.body || '';
    expect(body).not.toMatch(/missing bearer token|invalid token/);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });
});
