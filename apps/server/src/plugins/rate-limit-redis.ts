import { Redis } from 'ioredis';

/**
 * Distributed sliding-window rate-limit backend backed by Redis.
 *
 * The in-memory limiter in rate-limit.ts is correct for a single
 * process but breaks the moment we run more than one replica: a
 * misbehaving token can burst N times the intended budget when traffic
 * fans out across pods. This backend keeps the same sliding-window
 * semantics but stores hits in a Redis sorted set keyed by token name
 * (or client IP for unauthenticated callers), so every replica reads
 * and writes the same counter.
 *
 * The check + record is implemented as a single Lua script so it is
 * atomic and survives concurrent writers without a CAS loop. The
 * script:
 *   1. Trims entries older than (now - windowMs) from the sorted set.
 *   2. Reads the remaining cardinality.
 *   3. If >= perMinute, returns { 0, retryAfterSec }.
 *   4. Else adds the new hit (score = now, member = "now-randint" to
 *      avoid score collisions in the same millisecond), refreshes the
 *      key TTL to windowMs * 2 so idle buckets self-expire, and
 *      returns { 1, remaining }.
 *
 * When Redis is unavailable the caller is expected to fall back to the
 * in-memory limiter; this backend deliberately surfaces errors instead
 * of swallowing them so an outage cannot silently turn into "no rate
 * limit at all".
 */

const SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local perMinute = tonumber(ARGV[3])
local member = ARGV[4]
local cutoff = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = tonumber(redis.call('ZCARD', key) or '0')
if count >= perMinute then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestScore = now
  if oldest and oldest[2] then oldestScore = tonumber(oldest[2]) end
  local retryMs = (oldestScore + windowMs) - now
  if retryMs < 1000 then retryMs = 1000 end
  return {0, math.ceil(retryMs / 1000)}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs * 2)
return {1, perMinute - (count + 1)}
`;

export interface RedisRateLimitOptions {
  redisUrl: string;
  keyPrefix?: string;
  windowMs: number;
  perMinute: number;
  /** Optional injected client for tests. When provided, redisUrl is ignored. */
  client?: Redis;
}

export interface RedisRateLimitBackend {
  /** Returns { ok, remaining, retryAfterSec } and records the hit when ok. */
  checkAndRecord: (
    key: string,
    now?: number,
  ) => Promise<{ ok: boolean; remaining: number; retryAfterSec: number }>;
  /** Drops all state for a single key. Used in tests. */
  reset: (key: string) => Promise<void>;
  /** Drops all state under the configured prefix. Used in tests. */
  resetAll: () => Promise<void>;
  close: () => Promise<void>;
  /** Underlying client, exposed for diagnostics. Do not rely on this in app code. */
  readonly client: Redis;
}

export function createRedisRateLimitBackend(opts: RedisRateLimitOptions): RedisRateLimitBackend {
  const prefix = opts.keyPrefix ?? 'clawreview:rl:';
  const client =
    opts.client ??
    new Redis(opts.redisUrl, {
      // Keep retries bounded so a Redis outage surfaces quickly instead
      // of stalling every request behind exponential reconnects.
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
    });

  let counter = 0;

  async function checkAndRecord(key: string, now: number = Date.now()) {
    counter += 1;
    const member = `${now}-${counter}-${Math.floor(Math.random() * 1e6)}`;
    const result = (await client.eval(
      SCRIPT,
      1,
      `${prefix}${key}`,
      String(now),
      String(opts.windowMs),
      String(opts.perMinute),
      member,
    )) as [number, number];
    const ok = result[0] === 1;
    return {
      ok,
      remaining: ok ? result[1] : 0,
      retryAfterSec: ok ? 0 : result[1],
    };
  }

  async function reset(key: string): Promise<void> {
    await client.del(`${prefix}${key}`);
  }

  async function resetAll(): Promise<void> {
    // SCAN rather than KEYS so we do not block Redis when the prefix
    // has accumulated a lot of buckets. Test-only path.
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (batch.length > 0) await client.del(...batch);
    } while (cursor !== '0');
  }

  async function close(): Promise<void> {
    // quit() flushes pending commands; disconnect() drops them. quit()
    // is the right call from a process-shutdown path.
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  return { checkAndRecord, reset, resetAll, close, get client() { return client; } };
}
