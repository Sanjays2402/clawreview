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
const { getMetrics, resetMetricsForTests } = await import('@clawreview/telemetry');

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

describe('operatorPollForceParam (pure)', () => {
  it('returns true for the documented truthy values', () => {
    expect(_internals.operatorPollForceParam('/api/internal/webhook/recent?force=1')).toBe(true);
    expect(_internals.operatorPollForceParam('/api/internal/webhook/stats?force=true')).toBe(true);
    expect(_internals.operatorPollForceParam('/api/internal/webhook/stats?force=TRUE')).toBe(true);
    expect(_internals.operatorPollForceParam('/api/internal/webhook/stats?force=yes')).toBe(true);
  });

  it('returns false in the absence of a force key', () => {
    expect(_internals.operatorPollForceParam('/api/internal/webhook/recent')).toBe(false);
    expect(_internals.operatorPollForceParam('/api/internal/webhook/recent?event=push')).toBe(false);
    expect(_internals.operatorPollForceParam('/api/internal/webhook/stats?')).toBe(false);
  });

  it('returns false for non-truthy force values', () => {
    expect(_internals.operatorPollForceParam('/api/internal/webhook/recent?force=0')).toBe(false);
    expect(_internals.operatorPollForceParam('/api/internal/webhook/recent?force=false')).toBe(false);
    expect(_internals.operatorPollForceParam('/api/internal/webhook/recent?force=')).toBe(false);
    expect(_internals.operatorPollForceParam('/api/internal/webhook/recent?force=maybe')).toBe(false);
  });

  it('parses force regardless of position in the query string', () => {
    expect(
      _internals.operatorPollForceParam('/api/internal/webhook/stats?event=push&force=1&buckets=24'),
    ).toBe(true);
    expect(
      _internals.operatorPollForceParam('/api/internal/webhook/stats?force=1&event=push'),
    ).toBe(true);
    expect(
      _internals.operatorPollForceParam('/api/internal/webhook/stats?event=push&buckets=24'),
    ).toBe(false);
  });

  it('does not confuse `forcefully` or other longer keys with `force`', () => {
    expect(_internals.operatorPollForceParam('/api/internal/webhook/recent?forcefully=1')).toBe(false);
    expect(_internals.operatorPollForceParam('/api/internal/webhook/recent?force_me=1')).toBe(false);
  });
});

describe('operator-poll bypass via ?force=1 (wired into fastify)', () => {
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as unknown as { apiAuth?: { tokenName: string } }).apiAuth = {
        tokenName: 'rl-op-bypass',
      };
    });
  });
  afterEach(async () => {
    await app.close();
  });

  it('does NOT decrement the bucket when ?force=1 is present', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 2 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    // Bypass twenty times even though the bucket holds two.
    for (let i = 0; i < 20; i++) {
      const probe = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/recent?force=1',
      });
      expect(probe.statusCode).toBe(200);
      // Bypass header is set; remaining header is NOT (the request
      // didn't draw down the bucket, so reporting a number would be
      // misleading).
      expect(probe.headers['x-ratelimit-operator-bypass']).toBe('force');
      expect(probe.headers['x-ratelimit-operator-remaining']).toBeUndefined();
    }
    // Two genuine UI polling calls should still both succeed (bucket
    // is untouched by the 20 probes above).
    expect((await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' })).statusCode).toBe(200);
    // Third UI call exhausts the bucket and gets 429.
    const blocked = await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' });
    expect(blocked.statusCode).toBe(429);
  });

  it('treats only documented truthy values as a bypass; force=0 still counts', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 1 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    // force=0 is NOT a bypass; it counts toward the bucket.
    expect(
      (await app.inject({ method: 'GET', url: '/api/internal/webhook/recent?force=0' })).statusCode,
    ).toBe(200);
    // Bucket of 1 is now empty; next request 429s.
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?force=0',
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('still exempts /api/reviews and other non-polling routes from the bypass entirely', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 1 });
    app.get('/api/reviews', async () => ({ ok: true }));
    await app.ready();

    // force=1 is meaningless on a non-polling route (the limiter never
    // looks at it). The point of this test is just that the route
    // continues to bypass the operator-poll path classifier entirely;
    // no bypass header should leak onto unrelated routes.
    const res = await app.inject({ method: 'GET', url: '/api/reviews?force=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-operator-bypass']).toBeUndefined();
    expect(res.headers['x-ratelimit-operator-limit']).toBeUndefined();
  });
});

describe('operatorPollProbeParam (pure)', () => {
  it('returns the sanitised probe name when present', () => {
    expect(
      _internals.operatorPollProbeParam('/api/internal/webhook/recent?probe=stats-sidebar'),
    ).toBe('stats-sidebar');
    expect(
      _internals.operatorPollProbeParam('/api/internal/webhook/stats?probe=replay.recent'),
    ).toBe('replay.recent');
    // Underscores survive the strict allowlist.
    expect(
      _internals.operatorPollProbeParam('/api/internal/webhook/stats?probe=top_repos_widget'),
    ).toBe('top_repos_widget');
  });

  it('lower-cases the probe name so Casing variations agree', () => {
    expect(
      _internals.operatorPollProbeParam('/api/internal/webhook/recent?probe=Stats-Sidebar'),
    ).toBe('stats-sidebar');
    expect(
      _internals.operatorPollProbeParam('/api/internal/webhook/recent?probe=REPLAY'),
    ).toBe('replay');
  });

  it('returns null when no probe is present, or when the value is empty', () => {
    expect(_internals.operatorPollProbeParam('/api/internal/webhook/recent')).toBeNull();
    expect(_internals.operatorPollProbeParam('/api/internal/webhook/recent?force=1')).toBeNull();
    expect(_internals.operatorPollProbeParam('/api/internal/webhook/recent?probe=')).toBeNull();
  });

  it('strips disallowed characters and falls back to "unknown" when the value collapses', () => {
    // Slashes are not in the allowlist -> dropped.
    expect(
      _internals.operatorPollProbeParam('/api/internal/webhook/stats?probe=stats/sidebar'),
    ).toBe('statssidebar');
    // All-disallowed value -> the bucket is still surfaced as "unknown"
    // so a dashboard with a fully bogus probe param is still
    // attributable to "someone fed us nonsense" rather than silently
    // dropped.
    expect(
      _internals.operatorPollProbeParam('/api/internal/webhook/stats?probe=!@#$%^&buckets=24'),
    ).toBe('unknown');
  });

  it('decodes percent-escapes before sanitising', () => {
    // %2D == '-', %2E == '.'. Both survive the sanitiser.
    expect(
      _internals.operatorPollProbeParam('/api/internal/webhook/stats?probe=stats%2Dsidebar'),
    ).toBe('stats-sidebar');
    expect(
      _internals.operatorPollProbeParam('/api/internal/webhook/stats?probe=v1%2Estats'),
    ).toBe('v1.stats');
  });

  it('caps at 64 chars so a paste accident does not blow up log size', () => {
    const long = 'a'.repeat(120);
    const out = _internals.operatorPollProbeParam(
      `/api/internal/webhook/stats?probe=${long}`,
    );
    expect(out).not.toBeNull();
    expect(out!.length).toBe(64);
    expect(out!.startsWith('a'.repeat(64))).toBe(true);
  });

  it('parses probe alongside other params (force / event / buckets) regardless of position', () => {
    expect(
      _internals.operatorPollProbeParam(
        '/api/internal/webhook/stats?force=1&probe=stats-sidebar&buckets=24',
      ),
    ).toBe('stats-sidebar');
    expect(
      _internals.operatorPollProbeParam(
        '/api/internal/webhook/stats?probe=stats-sidebar&force=1',
      ),
    ).toBe('stats-sidebar');
    expect(
      _internals.operatorPollProbeParam('/api/internal/webhook/recent?event=push&probe=replay'),
    ).toBe('replay');
  });
});

describe('operator-poll probe annotation (wired into fastify)', () => {
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as unknown as { apiAuth?: { tokenName: string } }).apiAuth = {
        tokenName: 'rl-op-probe',
      };
    });
  });
  afterEach(async () => {
    await app.close();
  });

  it('mirrors the probe identifier on the response via x-ratelimit-operator-probe', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 10 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?probe=stats-sidebar',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-operator-probe']).toBe('stats-sidebar');
  });

  it('omits the probe header when no probe param is present', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 10 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-operator-probe']).toBeUndefined();
  });

  it('attaches the probe header alongside the bypass header when both flags are set', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 2 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    // force=1 bypasses the bucket; probe attribute survives so an
    // operator can see WHICH widget did the bypass.
    const res = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?force=1&probe=stats-sidebar',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-operator-bypass']).toBe('force');
    expect(res.headers['x-ratelimit-operator-probe']).toBe('stats-sidebar');
    // Remaining header is still absent on a bypass (the request did
    // not draw down the bucket).
    expect(res.headers['x-ratelimit-operator-remaining']).toBeUndefined();
  });

  it('logs the probe via req.log.info so operators can grep by probe name', async () => {
    const logged: Array<{ obj: unknown; msg: string }> = [];
    const probeApp = Fastify({
      loggerInstance: {
        info: (obj: unknown, msg?: string) => {
          if (typeof msg === 'string' && msg === 'operator-poll probe') {
            logged.push({ obj, msg });
          }
        },
        warn: () => {},
        error: () => {},
        debug: () => {},
        trace: () => {},
        fatal: () => {},
        silent: () => {},
        level: 'info',
        child() { return this; },
      } as unknown as never,
    });
    probeApp.addHook('onRequest', async (req: import('fastify').FastifyRequest) => {
      (req as unknown as { apiAuth?: { tokenName: string } }).apiAuth = {
        tokenName: 'rl-op-probe-log',
      };
    });
    await registerOperatorPollRateLimit(probeApp, { perMinute: 10 });
    probeApp.get('/api/internal/webhook/stats', async () => ({ ok: true }));
    await probeApp.ready();

    await probeApp.inject({
      method: 'GET',
      url: '/api/internal/webhook/stats?probe=replay-recent&buckets=24',
    });

    // At least one info call landed with our probe attribution.
    const probeLogs = logged.filter(
      (l) => (l.obj as { probe?: string }).probe === 'replay-recent',
    );
    expect(probeLogs.length).toBeGreaterThanOrEqual(1);
    // The recorded path is the bare route (no query string) so the
    // log groups by endpoint instead of fragmenting per call.
    expect((probeLogs[0]!.obj as { path?: string }).path).toBe(
      '/api/internal/webhook/stats',
    );
    await probeApp.close();
  });

  it('does not surface the probe header on non-polling routes', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 5 });
    app.get('/api/reviews', async () => ({ ok: true }));
    await app.ready();

    // The probe header is gated behind the operator-poll classifier;
    // unrelated /api routes never see it.
    const res = await app.inject({ method: 'GET', url: '/api/reviews?probe=stats-sidebar' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-operator-probe']).toBeUndefined();
  });
});

describe('operator-poll Prometheus counter (tick 11 wired)', () => {
  // Verifies the rate-limit hook bumps
  // `clawreview_operator_poll_total{probe,result}` once per request,
  // tagging the outcome (ok / bypass / throttled) and the probe
  // attribution. Pairs with the unit tests for observeOperatorPoll
  // in the telemetry package -- those pin the helper contract; these
  // pin the wiring from the Fastify hook to the registry.

  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    resetMetricsForTests();
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as unknown as { apiAuth?: { tokenName: string } }).apiAuth = {
        tokenName: 'rl-op-prom',
      };
    });
  });
  afterEach(async () => {
    await app.close();
    resetMetricsForTests();
  });

  it('counts an accepted polling request as result=ok against the probe label', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 10 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?probe=stats-sidebar',
    });
    expect(res.statusCode).toBe(200);

    const text = await getMetrics({
      service: 'clawreview-server',
      defaultMetrics: false,
    }).registry.metrics();
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="stats-sidebar"[^}]*result="ok"[^}]*\} 1/,
    );
  });

  it('counts a force=1 bypass as result=bypass without drawing down the bucket', async () => {
    // A bucket of 1 + two bypass calls would 429 without the bypass;
    // we verify both calls succeed AND that they land under the
    // bypass counter (not ok / throttled).
    await registerOperatorPollRateLimit(app, { perMinute: 1 });
    app.get('/api/internal/webhook/stats', async () => ({ ok: true }));
    await app.ready();

    const r1 = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/stats?force=1&probe=replay-recent',
    });
    const r2 = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/stats?force=1&probe=replay-recent',
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.headers['x-ratelimit-operator-bypass']).toBe('force');

    const text = await getMetrics({
      service: 'clawreview-server',
      defaultMetrics: false,
    }).registry.metrics();
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="replay-recent"[^}]*result="bypass"[^}]*\} 2/,
    );
    // The bypass path must NOT count as ok.
    expect(text).not.toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="replay-recent"[^}]*result="ok"[^}]*\}/,
    );
  });

  it('counts a 429 from an exhausted bucket as result=throttled against the probe', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 1 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    // First call goes through (result=ok); second trips the bucket.
    const ok = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?probe=stats-sidebar',
    });
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?probe=stats-sidebar',
    });
    expect(ok.statusCode).toBe(200);
    expect(blocked.statusCode).toBe(429);

    const text = await getMetrics({
      service: 'clawreview-server',
      defaultMetrics: false,
    }).registry.metrics();
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="stats-sidebar"[^}]*result="ok"[^}]*\} 1/,
    );
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="stats-sidebar"[^}]*result="throttled"[^}]*\} 1/,
    );
  });

  it('attributes anonymous polling (no ?probe=) to the (none) probe label', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 5 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    // Two anonymous polls -- one should still surface the
    // operator-poll counter with the `(none)` bucket so dashboards
    // can spot un-attributed polling.
    await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' });
    await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' });

    const text = await getMetrics({
      service: 'clawreview-server',
      defaultMetrics: false,
    }).registry.metrics();
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="\(none\)"[^}]*result="ok"[^}]*\} 2/,
    );
  });

  it('does not increment the counter on non-operator-poll routes', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 5 });
    app.get('/api/reviews', async () => ({ ok: true }));
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    // Two unrelated /api/reviews calls plus one polling call. Only
    // the polling call should bump the counter.
    await app.inject({ method: 'GET', url: '/api/reviews' });
    await app.inject({ method: 'GET', url: '/api/reviews' });
    await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' });

    const text = await getMetrics({
      service: 'clawreview-server',
      defaultMetrics: false,
    }).registry.metrics();
    // Exactly one polling-class increment (the /api/internal/webhook/recent call).
    const matches = text.match(/clawreview_operator_poll_total\{[^}]*\}/g) ?? [];
    // One sample line per (probe,result) pair, here just (none)/ok.
    expect(matches.length).toBe(1);
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="\(none\)"[^}]*result="ok"[^}]*\} 1/,
    );
  });

  // Tick 12: dedicated bypass attribution counter.
  // operatorPollTotal{result="bypass"} counts VOLUME; this counter
  // counts WHY each bypass was authorised so a security audit can
  // graph drift in the bypass surface separately from volume.
  it('also bumps clawreview_operator_poll_bypass_total{probe,reason} on a force=1 bypass', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 1 });
    app.get('/api/internal/webhook/stats', async () => ({ ok: true }));
    await app.ready();

    const r1 = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/stats?force=1&probe=stats-sidebar',
    });
    const r2 = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/stats?force=1&probe=stats-sidebar',
    });
    const r3 = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/stats?force=1&probe=stats-sidebar',
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);

    const text = await getMetrics({
      service: 'clawreview-server',
      defaultMetrics: false,
    }).registry.metrics();
    // Bypass attribution counter fires once per bypass with reason=force.
    expect(text).toContain('# TYPE clawreview_operator_poll_bypass_total counter');
    expect(text).toMatch(
      /clawreview_operator_poll_bypass_total\{[^}]*probe="stats-sidebar"[^}]*reason="force"[^}]*\} 3/,
    );
    // Reconciles with the volume counter on the bypass result label:
    // the per-probe total-by-bypass count must match the attribution
    // total. Three bypasses = 3 on both counters.
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="stats-sidebar"[^}]*result="bypass"[^}]*\} 3/,
    );
  });

  it('attributes anonymous bypass (no ?probe=) to the (none) probe label on the bypass counter', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 1 });
    app.get('/api/internal/webhook/stats', async () => ({ ok: true }));
    await app.ready();

    // Two anonymous bypass calls (no probe set).
    await app.inject({ method: 'GET', url: '/api/internal/webhook/stats?force=1' });
    await app.inject({ method: 'GET', url: '/api/internal/webhook/stats?force=true' });

    const text = await getMetrics({
      service: 'clawreview-server',
      defaultMetrics: false,
    }).registry.metrics();
    expect(text).toMatch(
      /clawreview_operator_poll_bypass_total\{[^}]*probe="\(none\)"[^}]*reason="force"[^}]*\} 2/,
    );
  });

  it('does NOT bump the bypass counter on a normal (non-bypass) poll', async () => {
    await registerOperatorPollRateLimit(app, { perMinute: 5 });
    app.get('/api/internal/webhook/recent', async () => ({ ok: true }));
    await app.ready();

    // Two genuine polls (no force=1) -- volume counter bumps, attribution
    // counter must stay silent so a "bypass drift" Prom query never lies.
    await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?probe=stats-sidebar',
    });
    await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?probe=stats-sidebar',
    });

    const text = await getMetrics({
      service: 'clawreview-server',
      defaultMetrics: false,
    }).registry.metrics();
    // operatorPollTotal sees two oks; bypass attribution stays at zero
    // (no series emitted at all, since the counter was never incremented).
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="stats-sidebar"[^}]*result="ok"[^}]*\} 2/,
    );
    expect(text).not.toMatch(
      /clawreview_operator_poll_bypass_total\{[^}]*probe="stats-sidebar"[^}]*\}/,
    );
  });
});
