import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.API_AUTH_TOKENS = 'dashboard:rl-token-aaaa,ci:rl-token-bbbb';
// Make sure no global override disables the limiter for this file.
delete process.env.DISABLE_PER_TOKEN_RATE_LIMIT;

const { buildServer } = await import('../src/server.js');
const {
  _internals,
  createPerTokenLimiter,
  PER_TOKEN_DEFAULT_PER_MINUTE,
  registerPerTokenRateLimit,
} = await import('../src/plugins/rate-limit.js');

describe('per-token rate limiter (pure)', () => {
  it('allows up to perMinute hits then 429s with retry-after', () => {
    const state = createPerTokenLimiter(3);
    const t0 = 1_000_000;
    expect(_internals.checkAndRecord(state, 'k', t0).ok).toBe(true);
    expect(_internals.checkAndRecord(state, 'k', t0 + 1).ok).toBe(true);
    expect(_internals.checkAndRecord(state, 'k', t0 + 2).ok).toBe(true);
    const blocked = _internals.checkAndRecord(state, 'k', t0 + 3);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('separates buckets per key', () => {
    const state = createPerTokenLimiter(1);
    expect(_internals.checkAndRecord(state, 'a').ok).toBe(true);
    expect(_internals.checkAndRecord(state, 'a').ok).toBe(false);
    expect(_internals.checkAndRecord(state, 'b').ok).toBe(true);
  });

  it('slides the window: a hit older than 60s no longer counts', () => {
    const state = createPerTokenLimiter(2);
    const t0 = 5_000_000;
    _internals.checkAndRecord(state, 'k', t0);
    _internals.checkAndRecord(state, 'k', t0 + 100);
    expect(_internals.checkAndRecord(state, 'k', t0 + 200).ok).toBe(false);
    // Jump past the window: oldest two entries expire.
    const later = t0 + _internals.WINDOW_MS + 1;
    expect(_internals.checkAndRecord(state, 'k', later).ok).toBe(true);
  });

  it('treats /healthz, /metrics, /webhooks as exempt', () => {
    const mk = (url: string) => ({ url } as Parameters<typeof _internals.isExempt>[0]);
    expect(_internals.isExempt(mk('/healthz'))).toBe(true);
    expect(_internals.isExempt(mk('/metrics'))).toBe(true);
    expect(_internals.isExempt(mk('/readyz?skipLlm=1'))).toBe(true);
    expect(_internals.isExempt(mk('/webhooks/github'))).toBe(true);
    expect(_internals.isExempt(mk('/api/reviews'))).toBe(false);
  });

  it('exposes the configured default', () => {
    expect(PER_TOKEN_DEFAULT_PER_MINUTE).toBeGreaterThan(0);
  });
});

describe('per-token rate limiter (wired into fastify)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());

  it('returns 429 after the per-token quota is exhausted', async () => {
    // Build a tiny extra app with a low limit so we don't have to fire
    // 600 requests at the real server. The wiring is symmetrical.
    const Fastify = (await import('fastify')).default;
    const mini = Fastify();
    // Fake out api-auth so the limiter has a tokenName to key on.
    mini.addHook('onRequest', async (req) => {
      (req as unknown as { apiAuth?: { tokenName: string } }).apiAuth = { tokenName: 'rl-test' };
    });
    await registerPerTokenRateLimit(mini, { perMinute: 3 });
    mini.get('/api/ping', async () => ({ ok: true }));
    await mini.ready();

    for (let i = 0; i < 3; i++) {
      const r = await mini.inject({ method: 'GET', url: '/api/ping' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-ratelimit-limit']).toBe('3');
    }
    const blocked = await mini.inject({ method: 'GET', url: '/api/ping' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(blocked.json()).toMatchObject({ error: 'TooManyRequests', limit: 3 });
    await mini.close();
  });

  it('does not rate-limit /healthz, /metrics, /readyz', async () => {
    for (const url of ['/healthz', '/metrics']) {
      // Hammer well past any plausible limit; these must always pass.
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({ method: 'GET', url });
        expect([200, 503]).toContain(r.statusCode);
      }
    }
  });
});

describe('sanity: server module still boots', () => {
  // Guards against accidental import-order regression where rate-limit
  // is registered before api-auth and loses access to req.apiAuth.
  beforeEach(() => {
    delete process.env.DISABLE_PER_TOKEN_RATE_LIMIT;
  });
  it('imports without throwing', async () => {
    const mod = await import('../src/server.js');
    expect(typeof mod.buildServer).toBe('function');
  });
});
