import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRedisRateLimitBackend,
  type RedisRateLimitBackend,
} from '../src/plugins/rate-limit-redis.js';
import {
  registerPerTokenRateLimit,
  _internals,
} from '../src/plugins/rate-limit.js';

/**
 * Minimal stub of the ioredis surface area used by the backend. It
 * reimplements the sliding-window Lua atomically in JS so we can prove
 * the limiter wiring works end-to-end without standing up a real
 * Redis. The Lua script itself is exercised by the integration test
 * suite when REDIS_URL is set.
 */
function makeStubRedis(): {
  redis: unknown;
  evals: number;
  pinged: number;
  closed: boolean;
} {
  const sets = new Map<string, Array<{ score: number; member: string }>>();
  const state = { evals: 0, pinged: 0, closed: false };

  const client = {
    async ping() {
      state.pinged += 1;
      return 'PONG';
    },
    async eval(
      _script: string,
      _numKeys: number,
      key: string,
      nowStr: string,
      windowMsStr: string,
      perMinuteStr: string,
      member: string,
    ): Promise<[number, number]> {
      state.evals += 1;
      const now = Number(nowStr);
      const windowMs = Number(windowMsStr);
      const perMinute = Number(perMinuteStr);
      const cutoff = now - windowMs;
      const arr = sets.get(key) ?? [];
      const live = arr.filter((e) => e.score > cutoff);
      if (live.length >= perMinute) {
        const oldest = live[0].score;
        const retryMs = Math.max(1000, oldest + windowMs - now);
        sets.set(key, live);
        return [0, Math.ceil(retryMs / 1000)];
      }
      live.push({ score: now, member });
      live.sort((a, b) => a.score - b.score);
      sets.set(key, live);
      return [1, perMinute - live.length];
    },
    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const k of keys) if (sets.delete(k)) removed += 1;
      return removed;
    },
    async scan(_cursor: string, _match: string, _pattern: string, _count: string, _n: string) {
      return ['0', Array.from(sets.keys())];
    },
    async quit() {
      state.closed = true;
      return 'OK';
    },
    disconnect() {
      state.closed = true;
    },
  };

  return { redis: client, get evals() { return state.evals; }, get pinged() { return state.pinged; }, get closed() { return state.closed; } };
}

describe('redis-backed rate limiter', () => {
  let backend: RedisRateLimitBackend | null = null;

  afterEach(async () => {
    if (backend) {
      await backend.close();
      backend = null;
    }
  });

  it('allows up to perMinute hits then 429s with retry-after', async () => {
    const stub = makeStubRedis();
    backend = createRedisRateLimitBackend({
      redisUrl: 'redis://ignored',
      windowMs: _internals.WINDOW_MS,
      perMinute: 3,
      client: stub.redis as never,
    });

    const t0 = 2_000_000;
    expect((await backend.checkAndRecord('k', t0)).ok).toBe(true);
    expect((await backend.checkAndRecord('k', t0 + 1)).ok).toBe(true);
    expect((await backend.checkAndRecord('k', t0 + 2)).ok).toBe(true);
    const blocked = await backend.checkAndRecord('k', t0 + 3);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(stub.evals).toBe(4);
  });

  it('separates buckets per key', async () => {
    const stub = makeStubRedis();
    backend = createRedisRateLimitBackend({
      redisUrl: 'redis://ignored',
      windowMs: _internals.WINDOW_MS,
      perMinute: 1,
      client: stub.redis as never,
    });

    expect((await backend.checkAndRecord('a')).ok).toBe(true);
    expect((await backend.checkAndRecord('a')).ok).toBe(false);
    expect((await backend.checkAndRecord('b')).ok).toBe(true);
  });

  it('reset() drops a single bucket so the next hit is allowed again', async () => {
    const stub = makeStubRedis();
    backend = createRedisRateLimitBackend({
      redisUrl: 'redis://ignored',
      windowMs: _internals.WINDOW_MS,
      perMinute: 1,
      client: stub.redis as never,
    });

    expect((await backend.checkAndRecord('k')).ok).toBe(true);
    expect((await backend.checkAndRecord('k')).ok).toBe(false);
    await backend.reset('k');
    expect((await backend.checkAndRecord('k')).ok).toBe(true);
  });

  it('close() quits the underlying client', async () => {
    const stub = makeStubRedis();
    backend = createRedisRateLimitBackend({
      redisUrl: 'redis://ignored',
      windowMs: _internals.WINDOW_MS,
      perMinute: 1,
      client: stub.redis as never,
    });
    await backend.close();
    backend = null;
    expect(stub.closed).toBe(true);
  });
});

describe('per-token limiter wired with a redis backend', () => {
  it('enforces a shared quota across simulated replicas', async () => {
    // The headline correctness property: two Fastify apps sharing one
    // Redis backend must observe the same per-token budget.
    const stub = makeStubRedis();
    const shared = createRedisRateLimitBackend({
      redisUrl: 'redis://ignored',
      windowMs: _internals.WINDOW_MS,
      perMinute: 4,
      client: stub.redis as never,
    });

    const Fastify = (await import('fastify')).default;
    const buildReplica = async () => {
      const app = Fastify();
      app.addHook('onRequest', async (req) => {
        (req as unknown as { apiAuth?: { tokenName: string } }).apiAuth = { tokenName: 'shared' };
      });
      await registerPerTokenRateLimit(app, { perMinute: 4, redis: shared });
      app.get('/api/ping', async () => ({ ok: true }));
      await app.ready();
      return app;
    };

    const a = await buildReplica();
    const b = await buildReplica();

    // 4 requests split across pods should all succeed; the 5th must 429
    // no matter which pod serves it.
    expect((await a.inject({ method: 'GET', url: '/api/ping' })).statusCode).toBe(200);
    expect((await b.inject({ method: 'GET', url: '/api/ping' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/ping' })).statusCode).toBe(200);
    expect((await b.inject({ method: 'GET', url: '/api/ping' })).statusCode).toBe(200);
    const blockedOnA = await a.inject({ method: 'GET', url: '/api/ping' });
    expect(blockedOnA.statusCode).toBe(429);
    expect(blockedOnA.headers['retry-after']).toBeDefined();
    const blockedOnB = await b.inject({ method: 'GET', url: '/api/ping' });
    expect(blockedOnB.statusCode).toBe(429);

    await a.close();
    await b.close();
    await shared.close();
  });

  it('falls back to the in-memory limiter when the redis backend throws', async () => {
    const failing = {
      async checkAndRecord() {
        throw new Error('redis down');
      },
      async reset() {},
      async resetAll() {},
      async close() {},
      client: {} as never,
    };

    const Fastify = (await import('fastify')).default;
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      (req as unknown as { apiAuth?: { tokenName: string } }).apiAuth = { tokenName: 'fb' };
    });
    const warn = vi.fn();
    app.log.warn = warn as never;
    await registerPerTokenRateLimit(app, { perMinute: 2, redis: failing });
    app.get('/api/ping', async () => ({ ok: true }));
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/api/ping' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/ping' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/ping' })).statusCode).toBe(429);
    // Each request should have logged the backend failure exactly once.
    expect(warn).toHaveBeenCalled();
    await app.close();
  });
});
