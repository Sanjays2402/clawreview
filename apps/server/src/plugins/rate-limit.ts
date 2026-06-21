import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { getMetrics, observeOperatorPoll } from '@clawreview/telemetry';

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

/**
 * Paths that operate as the "operator dashboard polling" class. These
 * are the endpoints a dashboard or on-call CLI walks on a tight loop
 * (every few seconds) to render a live status view — they generate
 * far more traffic per session than ordinary `/api/*` reads, so a
 * chatty dashboard would otherwise eat the operator's default token
 * budget for genuine work like rerun / replay / config edits.
 *
 * Today: webhook recent/stats. Easy to extend as more polling endpoints
 * land (queue stats, sla, repo-health summaries).
 *
 * Match is by path PREFIX so query strings (`?event=push&limit=25`)
 * don't break the classification.
 */
export function isOperatorPollPath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? '';
  return (
    path === '/api/internal/webhook/recent' ||
    path === '/api/internal/webhook/stats'
  );
}

/**
 * Default budget for the operator-polling class. ~5x the default
 * per-token budget so a dashboard polling every 2-3 seconds for a long
 * shift never exhausts it, while still bounding a runaway
 * `while true; do curl ...; done` script.
 *
 * The class consumes its own bucket first; on the way through, the
 * default per-token limiter still observes the hit, so a wildly
 * misbehaving client still trips that limit at PER_TOKEN_DEFAULT_PER_MINUTE.
 */
export const OPERATOR_POLL_DEFAULT_PER_MINUTE = 3000;

/**
 * Whether a request asked the operator-poll limiter to bypass the
 * bucket via `?force=1` (or `?force=true`). Returns true for the
 * documented truthy values and false for everything else (including
 * the absence of the query string).
 *
 * Use case: a dashboard's in-band health probe pings
 * /api/internal/webhook/{recent,stats} on a fast timer (every 1-2s)
 * just to confirm the endpoint is reachable. Without a bypass those
 * probes eat the operator-poll bucket and cause the genuine UI
 * polling to 429. `?force=1` is the explicit opt-out: when the
 * dashboard knows the call is a probe and shouldn't count against
 * the budget, it sets the flag and the limiter lets it through
 * without recording the hit.
 *
 * Safety: the bypass affects ONLY the operator-poll class. The
 * default per-token limiter (`registerPerTokenRateLimit`) still
 * observes the hit, so a wildly misbehaving client that hammers
 * /api/internal/webhook/stats?force=1 still trips that class at its
 * configured ceiling. The dashboard's probe is well-behaved -- ~1
 * req/s -- and lands far below the per-token budget.
 *
 * Pure / exported for tests so the truthy-value contract is unit-
 * testable independently of the route wiring.
 */
export function operatorPollForceParam(url: string): boolean {
  // Cheap query-string scan that avoids URL constructor overhead on
  // every request. Matches `force=` exactly; the value is one of the
  // documented truthy strings.
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return false;
  const query = url.slice(qIdx + 1);
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (key !== 'force') continue;
    const value = eq < 0 ? '' : part.slice(eq + 1).toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
  }
  return false;
}

/**
 * Optional probe identifier from a `?probe=<name>` query parameter.
 * Returns the sanitised name when present, `null` otherwise. Pairs
 * with `?force=1` so a dashboard can both bypass the operator-poll
 * bucket AND tell operators which named widget did the bypass.
 *
 * Use case: a dashboard has several widgets that each ping the
 * polling endpoints on their own timers. When something starts
 * misbehaving (a chatty new widget, a wedged auto-refresh), the
 * operator wants to know which one without going through every
 * client. Tagging probes with a stable identifier (`probe=stats-
 * sidebar` / `probe=replay-recent`) gives `req.log` a label to
 * attach to the audit line so dashboard noise becomes attributable.
 *
 * Sanitisation rules (keep log noise / cardinality bounded):
 *   - Trimmed; values that collapse to empty return `null`.
 *   - Lower-cased so `stats-sidebar` and `Stats-Sidebar` agree.
 *   - Only `[a-z0-9._-]` survives; everything else is dropped.
 *     This is strict on purpose: a probe identifier is a developer-
 *     chosen label, not arbitrary user input. Garbage in -> bucket
 *     under `'unknown'` rather than letting a hostile / typo'd
 *     value pollute the log.
 *   - Capped at 64 chars so a long mistakenly-pasted token can't
 *     blow up log size.
 *
 * Pure / exported for tests; the route wiring is a thin call into
 * this helper followed by a `req.log.info({ probe, ... })`.
 */
export function operatorPollProbeParam(url: string): string | null {
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return null;
  const query = url.slice(qIdx + 1);
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (key !== 'probe') continue;
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    if (rawValue.length === 0) return null;
    // Percent-decode lightly so `probe=stats%2Dsidebar` works without
    // pulling in `URL` for the cheap path. Failures (malformed escape)
    // fall back to the raw value so we don't lose the probe entirely.
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      value = rawValue;
    }
    const cleaned = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '');
    if (cleaned.length === 0) return 'unknown';
    return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
  }
  return null;
}

/**
 * Registers the operator-polling rate limit class. Runs BEFORE the
 * default per-token limiter (registered in server.ts) so dashboards
 * land in the dedicated bucket and don't compete with the operator's
 * default budget for rerun / replay / config edits.
 *
 * Keys are the same shape as the default limiter: `token:<name>` when
 * api-auth resolved a token, else `ip:<addr>`. Path classification is
 * `isOperatorPollPath`; non-matching requests are pass-through.
 *
 * The Redis backend is intentionally NOT plumbed here in tick 8: the
 * default per-token limiter remains the canonical multi-replica
 * coordinator (it sees every request), and the dashboard class is an
 * in-process cushion so dashboards don't eat the operator budget on a
 * single pod. A future tick can swap in a class-aware Redis backend
 * once we run multi-pod with chatty dashboards.
 */
export async function registerOperatorPollRateLimit(
  app: FastifyInstance,
  opts: { perMinute?: number } = {},
): Promise<RateLimiterState> {
  const perMinute = opts.perMinute ?? OPERATOR_POLL_DEFAULT_PER_MINUTE;
  const state = createPerTokenLimiter(perMinute);
  startSweeper(state);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isOperatorPollPath(req.url)) return;

    // Optional probe identifier: a dashboard can tag each named widget
    // with `?probe=<name>` so the operator can attribute polling
    // traffic to a specific UI surface. The probe label survives BOTH
    // the bypass and the normal-flow paths so operators see consistent
    // attribution either way -- and so a chatty client polling without
    // ?force=1 is still attributable.
    const probe = operatorPollProbeParam(req.url);
    if (probe !== null) {
      // Single structured log line so an operator grep can filter by
      // probe name without parsing free-form text. The route name and
      // request id are already in the request log context.
      req.log.info({ probe, path: req.url.split('?', 1)[0] }, 'operator-poll probe');
      // Mirror the probe on the response so a client / proxy can see
      // its own attribution without consulting server logs. Distinct
      // header name so it doesn't clash with the rate-limit headers.
      reply.header('x-ratelimit-operator-probe', probe);
    }

    const metrics = getMetrics({ service: 'clawreview-server' });

    // In-band probe bypass: a dashboard can send `?force=1` on its
    // own health-check ping so the limiter does NOT count it against
    // the bucket. This keeps the dashboard's sanity-probe-every-second
    // from eating the genuine UI polling budget. The bypass is the
    // operator-poll class ONLY: the default per-token limiter (running
    // later in the request chain) still sees the hit, so a runaway
    // client cannot hide behind force=1 forever.
    if (operatorPollForceParam(req.url)) {
      reply.header('x-ratelimit-operator-limit', String(perMinute));
      // No 'remaining' header on a bypass: the request didn't draw
      // down the bucket, so reporting a number would be misleading. A
      // dedicated `bypass` header makes the bypass auditable in
      // server logs / dev tools without parsing the response body.
      reply.header('x-ratelimit-operator-bypass', 'force');
      // Prom counter: attribute the bypass to its named probe (or
      // '(none)') so an operator can graph dashboard health-probe
      // volume separately from genuine polling. Counted BEFORE
      // returning so a thrown plugin downstream can never silently
      // skip the increment.
      observeOperatorPoll(metrics, probe, 'bypass');
      return;
    }

    const tokenName = req.apiAuth?.tokenName;
    const key = tokenName ? `token:${tokenName}` : `ip:${req.ip ?? 'unknown'}`;
    const result = checkAndRecord(state, key);

    // Use distinct header names so an operator (or a client library)
    // can tell which class a 429 came from. The default per-token
    // headers still land on the response when the request makes it
    // through this hook.
    reply.header('x-ratelimit-operator-limit', String(perMinute));
    reply.header(
      'x-ratelimit-operator-remaining',
      String(Math.max(0, result.remaining)),
    );

    if (!result.ok) {
      reply.header('retry-after', String(result.retryAfterSec));
      reply.code(429);
      // Throttled outcome counted BEFORE reply.send so the metric
      // fires even if the client disconnects mid-response.
      observeOperatorPoll(metrics, probe, 'throttled');
      return reply.send({
        error: 'TooManyRequests',
        message:
          `operator-poll rate limit exceeded for ` +
          `${tokenName ? 'token ' + tokenName : 'ip ' + (req.ip ?? 'unknown')}`,
        class: 'operator-poll',
        limit: perMinute,
        retryAfter: result.retryAfterSec,
        requestId: req.id,
      });
    }
    // Accepted -- the request consumed one slot from the bucket and
    // will reach the route handler. One increment per accepted request
    // so rate() in Prom gives ops/sec for the polling class.
    observeOperatorPoll(metrics, probe, 'ok');
  });

  app.log.info(
    { perMinute, windowMs: WINDOW_MS, class: 'operator-poll' },
    'operator-poll rate limit enabled for /api/internal/webhook/{recent,stats}',
  );

  return state;
}

/**
 * Convenience entrypoint mirroring `registerRateLimit`. Honours
 * DISABLE_PER_TOKEN_RATE_LIMIT=1 in tests so the same env knob disables
 * BOTH classes for hammer-the-API integration tests.
 */
export async function registerOperatorPollRateLimitWithEnv(
  app: FastifyInstance,
): Promise<RateLimiterState | null> {
  if (env.NODE_ENV !== 'production' && process.env.DISABLE_PER_TOKEN_RATE_LIMIT === '1') {
    app.log.warn('operator-poll rate limit disabled by DISABLE_PER_TOKEN_RATE_LIMIT');
    return null;
  }
  return registerOperatorPollRateLimit(app);
}

// Exported for tests.
export const _internals = { isExempt, isOperatorPollPath, operatorPollForceParam, operatorPollProbeParam, checkAndRecord, createPerTokenLimiter, WINDOW_MS };
