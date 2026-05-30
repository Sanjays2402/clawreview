import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { env } from '../env.js';
import {
  createRedisRateLimitBackend,
  type RedisRateLimitBackend,
} from './rate-limit-redis.js';

/**
 * Default per-token budget for /api/* requests. This sits on top of the
 * global per-IP limit registered in server.ts so an authenticated client
 * that bursts past its token quota gets a 429 keyed by token, even if
 * the IP budget still has headroom (and vice versa: an unauthenticated
 * flood still hits the IP limit first).
 *
 * 600 req/min averages 10 rps sustained: well above normal dashboard
 * polling but low enough to contain a runaway script before it
 * exhausts the shared per-IP budget for everyone behind the same NAT.
 */
export const PER_TOKEN_DEFAULT_PER_MINUTE = 600;
export const WINDOW_MS = 60_000;

/**
 * Paths that must never be rate-limited. Liveness/readiness probes and
 * Prometheus scraping are infrastructure traffic; throttling them would
 * create cascading false-positive outages. Inbound GitHub webhooks are
 * authenticated by HMAC and bursty by design.
 */
function isExempt(req: FastifyRequest): boolean {
  const path = req.url.split('?', 1)[0];
  if (path === '/healthz' || path === '/readyz' || path === '/metrics' || path === '/version') {
    return true;
  }
  if (path.startsWith('/webhooks/')) return true;
  return false;
}

interface Bucket {
  // Timestamps of recent hits, oldest first. A sliding window keeps
  // bursts honest without the smoothing artefacts of a token bucket
  // when the window crosses a minute boundary.
  hits: number[];
}

export interface RateLimiterState {
  buckets: Map<string, Bucket>;
  perMinute: number;
  // Returns the number of currently active keys. Exposed for /metrics or
  // diagnostic endpoints.
  size: () => number;
  // Test/operational hook to drop state without restarting the process.
  reset: () => void;
}

export function createPerTokenLimiter(perMinute: number): RateLimiterState {
  const buckets = new Map<string, Bucket>();
  return {
    buckets,
    perMinute,
    size: () => buckets.size,
    reset: () => buckets.clear(),
  };
}

/**
 * Returns { ok, remaining, retryAfterSec } and records the hit when ok.
 * Window is a sliding 60s; the bucket trims expired entries on every
 * touch so memory stays bounded by the number of recently active keys.
 */
export function checkAndRecord(
  state: RateLimiterState,
  key: string,
  now: number = Date.now(),
): { ok: boolean; remaining: number; retryAfterSec: number } {
  let bucket = state.buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    state.buckets.set(key, bucket);
  }
  const cutoff = now - WINDOW_MS;
  // Drop expired hits. Linear scan is fine: bucket length is capped by
  // perMinute, and we'd evict bursty entries quickly anyway.
  while (bucket.hits.length > 0 && bucket.hits[0] <= cutoff) {
    bucket.hits.shift();
  }
  if (bucket.hits.length >= state.perMinute) {
    const oldest = bucket.hits[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    return { ok: false, remaining: 0, retryAfterSec };
  }
  bucket.hits.push(now);
  return { ok: true, remaining: state.perMinute - bucket.hits.length, retryAfterSec: 0 };
}

/**
 * Periodically drops idle buckets to prevent slow leaks from clients
 * that hit us once and never return. Runs every minute and removes any
 * bucket whose newest hit is older than the window.
 */
function startSweeper(state: RateLimiterState, intervalMs = WINDOW_MS): NodeJS.Timeout {
  const t = setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, bucket] of state.buckets) {
      const newest = bucket.hits[bucket.hits.length - 1] ?? 0;
      if (newest <= cutoff) state.buckets.delete(key);
    }
  }, intervalMs);
  // Don't keep the event loop alive purely for the sweeper.
  if (typeof t.unref === 'function') t.unref();
  return t;
}

export interface PerTokenRateLimitOptions {
  perMinute?: number;
  /**
   * Optional distributed backend. When provided, the limiter consults
   * Redis instead of the in-process map so quotas hold across replicas.
   * Failures fall back to the in-process state to avoid turning a
   * Redis outage into a request blackout.
   */
  redis?: RedisRateLimitBackend;
}

/**
 * Registers a per-token rate limiter scoped to /api/*. Keys are the
 * authenticated token name (set by the api-auth plugin); requests
 * without a token are bucketed by client IP so unauthenticated probes
 * still get counted somewhere instead of bypassing the limit entirely.
 */
export async function registerPerTokenRateLimit(
  app: FastifyInstance,
  opts: PerTokenRateLimitOptions = {},
): Promise<RateLimiterState> {
  const perMinute = opts.perMinute ?? PER_TOKEN_DEFAULT_PER_MINUTE;
  const state = createPerTokenLimiter(perMinute);
  startSweeper(state);

  const redis = opts.redis;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (isExempt(req)) return;
    if (!req.url.startsWith('/api/')) return;

    const tokenName = req.apiAuth?.tokenName;
    const key = tokenName ? `token:${tokenName}` : `ip:${req.ip ?? 'unknown'}`;

    let result: { ok: boolean; remaining: number; retryAfterSec: number };
    if (redis) {
      try {
        result = await redis.checkAndRecord(key);
      } catch (err) {
        // Redis is down or the script errored. Fall back to the in-process
        // limiter so the API keeps serving with at-least-one-replica
        // protection. Log once per request so operators can alert on it.
        req.log.warn({ err }, 'rate-limit redis backend failed, using in-memory fallback');
        result = checkAndRecord(state, key);
      }
    } else {
      result = checkAndRecord(state, key);
    }

    reply.header('x-ratelimit-limit', String(perMinute));
    reply.header('x-ratelimit-remaining', String(Math.max(0, result.remaining)));

    if (!result.ok) {
      reply.header('retry-after', String(result.retryAfterSec));
      reply.code(429);
      return reply.send({
        error: 'TooManyRequests',
        message: `rate limit exceeded for ${tokenName ? 'token ' + tokenName : 'ip ' + req.ip}`,
        limit: perMinute,
        retryAfter: result.retryAfterSec,
        requestId: req.id,
      });
    }
  });

  app.log.info(
    { perMinute, windowMs: WINDOW_MS, backend: redis ? 'redis' : 'memory' },
    'per-token rate limit enabled for /api/*',
  );

  // Tear the Redis client down with the server so tests and graceful
  // shutdowns do not leak connections.
  if (redis) {
    app.addHook('onClose', async () => {
      try {
        await redis.close();
      } catch {
        /* already closed */
      }
    });
  }

  return state;
}

/**
 * Convenience entrypoint used by server.ts. Honours
 * DISABLE_PER_TOKEN_RATE_LIMIT=1 for tests that need to hammer the API
 * without tripping limits; never honours it in production.
 */
export async function registerRateLimit(app: FastifyInstance): Promise<RateLimiterState | null> {
  if (env.NODE_ENV !== 'production' && process.env.DISABLE_PER_TOKEN_RATE_LIMIT === '1') {
    app.log.warn('per-token rate limit disabled by DISABLE_PER_TOKEN_RATE_LIMIT');
    return null;
  }

  // Multi-replica deployments must coordinate quotas through Redis,
  // otherwise each pod enforces its own private budget and the
  // aggregate ceiling is replicaCount * perMinute. When REDIS_URL is
  // empty we stay on the in-memory limiter; that is correct for
  // single-process dev and test, and the Helm chart documents the
  // production requirement in values.yaml.
  let redis: RedisRateLimitBackend | undefined;
  if (env.REDIS_URL && env.NODE_ENV !== 'test') {
    try {
      redis = createRedisRateLimitBackend({
        redisUrl: env.REDIS_URL,
        windowMs: WINDOW_MS,
        perMinute: PER_TOKEN_DEFAULT_PER_MINUTE,
      });
      // Cheap liveness probe so a misconfigured URL fails loud at boot
      // instead of every first request after a deploy.
      await redis.client.ping();
    } catch (err) {
      app.log.error({ err }, 'failed to attach redis rate-limit backend, falling back to in-memory');
      if (redis) {
        try { await redis.close(); } catch { /* ignore */ }
      }
      redis = undefined;
    }
  }

  return registerPerTokenRateLimit(app, { redis });
}

// Exported for tests.
export const _internals = { isExempt, checkAndRecord, createPerTokenLimiter, WINDOW_MS };
