import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
// Token list is not consulted in these tests (we stub req.apiAuth
// directly on the test app), but the env var is still needed so the
// api-auth module's strict require-on-import doesn't trip.
process.env.API_AUTH_TOKENS = 'dashboard:rl-op-token-aaaa,ci:rl-op-token-bbbb';
delete process.env.DISABLE_PER_TOKEN_RATE_LIMIT;

const { _internals, registerOperatorPollRateLimit, OPERATOR_POLL_DEFAULT_PER_MINUTE } =
  await import('../src/plugins/rate-limit.js');
const Fastify = (await import('fastify')).default;

/**
 * The operator-poll class is the dedicated rate-limit bucket for
 * dashboard polling endpoints (today: /api/internal/webhook/recent and
 * /api/internal/webhook/stats). The tests below cover three concerns:
 *
 *   1. path classification: only the two operator-poll URLs match,
 *      with query strings preserved and other /api paths excluded.
 *   2. wired behaviour: the class returns 429 with the dedicated
 *      headers + payload when its bucket is exhausted, and 200 for
 *      everything else.
 *   3. isolation: polling load on the operator-poll path does NOT
 *      consume the default per-token bucket -- the two limiters key
 *      independently on the same token name.
 */

describe('operator-poll rate-limit class (pure)', () => {
  it('matches the two webhook polling endpoints and excludes other /api paths', () => {
    expect(_internals.isOperatorPollPath('/api/internal/webhook/recent')).toBe(true);
    expect(_internals.isOperatorPollPath('/api/internal/webhook/stats')).toBe(true);
    // Query strings must not break classification.
    expect(
      _internals.isOperatorPollPath('/api/internal/webhook/recent?event=push&limit=25'),
    ).toBe(true);
    expect(
      _internals.isOperatorPollPath(
        '/api/internal/webhook/stats?granularity=minute&buckets=30',
      ),
    ).toBe(true);
    // Adjacent or sibling internal paths must NOT be classified -- the
    // operator's rerun/replay calls must still land in the default
    // per-token bucket.
    expect(_internals.isOperatorPollPath('/api/internal/webhook/replay/abc')).toBe(false);
    expect(_internals.isOperatorPollPath('/api/internal/queue')).toBe(false);
    expect(_internals.isOperatorPollPath('/api/reviews')).toBe(false);
    expect(_internals.isOperatorPollPath('/healthz')).toBe(false);
  });

  it('exposes a configured default budget > 0', () => {
    expect(OPERATOR_POLL_DEFAULT_PER_MINUTE).toBeGreaterThan(0);
    // Must be strictly greater than the default per-token limit so the
    // operator-poll class actually relieves dashboard pressure.
    expect(OPERATOR_POLL_DEFAULT_PER_MINUTE).toBeGreaterThan(600);
  });
});

describe('operator-poll rate-limit class (wired into fastify)', () => {
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    app = Fastify();
    // Fake api-auth so the limiter has a tokenName to key on.
    app.addHook('onRequest', async (req) => {
      (req as unknown as { apiAuth?: { tokenName: string } }).apiAuth = {
        tokenName: 'rl-op-test',
      };
    });
  });
  afterEach(async () => {
    await app.close();
  });

  it('returns 429 with operator-poll headers + class once the bucket is exhausted', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 3 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-ratelimit-operator-limit']).toBe('3');
    }
    const blocked = await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(blocked.json()).toMatchObject({
      error: 'TooManyRequests',
      class: 'operator-poll',
      limit: 3,
    });
  });

  it('does not throttle non-polling /api routes even after the polling bucket is empty', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 2 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    app.get('/api/reviews', async () => ({ ok: true }));
    await app.ready();

    // Drain the polling bucket twice over.
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' });
    }
    const other = await app.inject({ method: 'GET', url: '/api/reviews' });
    expect(other.statusCode).toBe(200);
    // The polling-class headers must not bleed onto unrelated routes:
    // we want them ONLY on the operator-poll responses so a client can
    // tell which class it hit.
    expect(other.headers['x-ratelimit-operator-limit']).toBeUndefined();
  });

  it('throttles /stats and /recent under the same shared bucket per token', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 4 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    app.get('/api/internal/webhook/stats', async () => ({ ok: true }));
    await app.ready();

    // Mix the two endpoints. The class is one shared bucket per token
    // because a dashboard typically polls both.
    expect((await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/internal/webhook/stats' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/internal/webhook/stats' })).statusCode).toBe(200);
    // The fifth request crosses the limit regardless of which endpoint.
    const blocked = await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' });
    expect(blocked.statusCode).toBe(429);
  });

  it('keys per-token: two tokens do not share the same operator-poll budget', async () => {
    let tokenName = 'team-a';
    const dynamicApp = Fastify();
    dynamicApp.addHook('onRequest', async (req: import('fastify').FastifyRequest) => {
      (req as unknown as { apiAuth?: { tokenName: string } }).apiAuth = { tokenName };
    });
    await registerOperatorPollRateLimit(dynamicApp, { perMinute: 2 });
    dynamicApp.get('/api/internal/webhook/stats', async () => ({ ok: true }));
    await dynamicApp.ready();

    // Drain team-a.
    expect((await dynamicApp.inject({ method: 'GET', url: '/api/internal/webhook/stats' })).statusCode).toBe(200);
    expect((await dynamicApp.inject({ method: 'GET', url: '/api/internal/webhook/stats' })).statusCode).toBe(200);
    expect((await dynamicApp.inject({ method: 'GET', url: '/api/internal/webhook/stats' })).statusCode).toBe(429);

    // Switch token to team-b and verify the bucket is fresh.
    tokenName = 'team-b';
    expect((await dynamicApp.inject({ method: 'GET', url: '/api/internal/webhook/stats' })).statusCode).toBe(200);
    expect((await dynamicApp.inject({ method: 'GET', url: '/api/internal/webhook/stats' })).statusCode).toBe(200);
    expect((await dynamicApp.inject({ method: 'GET', url: '/api/internal/webhook/stats' })).statusCode).toBe(429);

    await dynamicApp.close();
  });

  it('falls back to ip-keyed budget when no api-auth token is present', async () => {
    const ipApp = Fastify();
    // NO api-auth hook here -- request lands without req.apiAuth.
    await registerOperatorPollRateLimit(ipApp, { perMinute: 1 });
    ipApp.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await ipApp.ready();

    expect((await ipApp.inject({ method: 'GET', url: '/api/internal/webhook/recent' })).statusCode).toBe(200);
    const blocked = await ipApp.inject({ method: 'GET', url: '/api/internal/webhook/recent' });
    expect(blocked.statusCode).toBe(429);
    // The message should name the keying as 'ip ...' (no token).
    expect(blocked.json()).toMatchObject({ class: 'operator-poll' });
    expect((blocked.json() as { message: string }).message).toMatch(/ip /);
    await ipApp.close();
  });
});
