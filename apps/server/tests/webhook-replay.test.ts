import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const { computeSignature } = await import('@clawreview/github');
const { buildServer } = await import('../src/server.js');
const { getWebhookStore, _resetWebhookStoreForTests } = await import(
  '../src/services/webhook-store.js'
);
const { getMetrics, resetMetricsForTests } = await import('@clawreview/telemetry');

const BASE_PR = {
  action: 'opened',
  number: 11,
  pull_request: {
    id: 1,
    number: 11,
    title: 'Replay PR',
    state: 'open',
    draft: false,
    head: { sha: 'sha-aaaa111', ref: 'feat/replay' },
    base: { sha: 'sha-bbbb222', ref: 'main' },
    user: { login: 'sanjay' },
  },
  repository: {
    id: 42,
    name: 'demo',
    full_name: 'sanjay/demo',
    owner: { login: 'sanjay', id: 1 },
  },
  installation: { id: 77 },
};

async function deliver(
  app: Awaited<ReturnType<typeof buildServer>>,
  deliveryId: string,
  payload: object,
): Promise<void> {
  const body = JSON.stringify(payload);
  const sig = computeSignature(body, 'test-secret');
  await app.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': sig,
      'content-type': 'application/json',
    },
    payload: body,
  });
}

describe('/api/internal/webhook/recent + /replay/:deliveryId', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    _resetWebhookStoreForTests();
  });
  afterAll(async () => app.close());

  it('captures incoming webhook deliveries into the store with action+repo+installation', async () => {
    _resetWebhookStoreForTests();
    await deliver(app, 'rec-1', BASE_PR);
    const store = getWebhookStore();
    expect(store.size()).toBeGreaterThanOrEqual(1);
    const entry = store.get('rec-1');
    expect(entry).toBeDefined();
    expect(entry!.event).toBe('pull_request');
    expect(entry!.action).toBe('opened');
    expect(entry!.repoFullName).toBe('sanjay/demo');
    expect(entry!.installationId).toBe(77);
  });

  it('lists recent deliveries newest-first via /recent', async () => {
    _resetWebhookStoreForTests();
    await deliver(app, 'rec-a', BASE_PR);
    await deliver(app, 'rec-b', BASE_PR);
    await deliver(app, 'rec-c', BASE_PR);

    const res = await app.inject({ method: 'GET', url: '/api/internal/webhook/recent' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.size).toBeGreaterThanOrEqual(3);
    expect(body.entries[0].deliveryId).toBe('rec-c');
    expect(body.entries[1].deliveryId).toBe('rec-b');
    expect(body.entries[2].deliveryId).toBe('rec-a');
    // limit param is honored and capped
    const lim = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?limit=1',
    });
    expect(lim.json().entries).toHaveLength(1);
    expect(lim.json().limit).toBe(1);
  });

  it('replays a stored delivery through dispatchWebhook and returns the dispatch result', async () => {
    _resetWebhookStoreForTests();
    await deliver(app, 'orig-1', BASE_PR);

    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/webhook/replay/orig-1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.originalDelivery).toBe('orig-1');
    expect(body.replayDelivery).toMatch(/^orig-1::replay-\d+-\d+$/);
    expect(body.event).toBe('pull_request');
    expect(body.dispatched).toMatchObject({
      ok: true,
      queued: expect.stringMatching(/^pr-sanjay\/demo-11-sha-aaaa111$/),
    });
  });

  it('returns 404 for an unknown deliveryId', async () => {
    _resetWebhookStoreForTests();
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/webhook/replay/does-not-exist',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NotFound');
  });

  it('a replay bypasses the idempotency cache (creates a new review row)', async () => {
    _resetWebhookStoreForTests();
    await deliver(app, 'orig-2', BASE_PR);
    const first = await app.inject({
      method: 'POST',
      url: '/api/internal/webhook/replay/orig-2',
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/internal/webhook/replay/orig-2',
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Each replay gets its own replayDelivery suffix, so neither short-circuits.
    expect(first.json().replayDelivery).not.toBe(second.json().replayDelivery);
    expect(first.json().dispatched.ok).toBe(true);
    expect(second.json().dispatched.ok).toBe(true);
  });

  it('propagates the dispatch ignored outcome verbatim (e.g. draft PR)', async () => {
    _resetWebhookStoreForTests();
    const draftPayload = {
      ...BASE_PR,
      pull_request: { ...BASE_PR.pull_request, draft: true },
    };
    await deliver(app, 'draft-1', draftPayload);
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/webhook/replay/draft-1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatched).toMatchObject({
      ok: true,
      ignored: true,
      reason: 'draft',
    });
  });

  it('filters /recent by ?event=', async () => {
    _resetWebhookStoreForTests();
    await deliver(app, 'pr-1', BASE_PR);
    await deliver(app, 'pr-2', BASE_PR);
    // Push a non-pull_request entry directly into the store so we don't
    // need a second receiver path. The route still walks the same store.
    getWebhookStore().put({
      deliveryId: 'push-1',
      event: 'push',
      action: undefined,
      payload: {},
      receivedAt: new Date().toISOString(),
      repoFullName: 'sanjay/demo',
    });

    const all = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent',
    });
    expect(all.json().entries.length).toBe(3);

    const onlyPush = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?event=push',
    });
    expect(onlyPush.json().entries.length).toBe(1);
    expect(onlyPush.json().entries[0].event).toBe('push');
    expect(onlyPush.json().appliedFilters).toMatchObject({ event: 'push' });

    const onlyPr = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?event=pull_request',
    });
    expect(onlyPr.json().entries.length).toBe(2);
    for (const e of onlyPr.json().entries) {
      expect(e.event).toBe('pull_request');
    }
  });

  it('filters /recent by ?sinceMs= (only entries newer than the cutoff)', async () => {
    _resetWebhookStoreForTests();
    // Manually populate so we can control receivedAt; the receiver
    // stamps it with `now`, which is fine for the cutoff = "now - 1h"
    // case below.
    const now = Date.now();
    const oneDayAgo = new Date(now - 24 * 3600_000).toISOString();
    const oneHourAgo = new Date(now - 3600_000).toISOString();
    const recent = new Date(now - 60_000).toISOString();
    getWebhookStore().put({
      deliveryId: 'old', event: 'pull_request', payload: {}, receivedAt: oneDayAgo, repoFullName: 'a/b',
    });
    getWebhookStore().put({
      deliveryId: 'mid', event: 'pull_request', payload: {}, receivedAt: oneHourAgo, repoFullName: 'a/b',
    });
    getWebhookStore().put({
      deliveryId: 'new', event: 'pull_request', payload: {}, receivedAt: recent, repoFullName: 'a/b',
    });

    const cutoff = now - 30 * 60_000; // 30 minutes ago
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/webhook/recent?sinceMs=${cutoff}`,
    });
    const ids = res.json().entries.map((e: { deliveryId: string }) => e.deliveryId);
    expect(ids).toEqual(['new']);
    expect(res.json().appliedFilters.sinceMs).toBe(cutoff);
  });

  it('accepts ?since= as an ISO-8601 alternative to ?sinceMs=', async () => {
    _resetWebhookStoreForTests();
    const now = Date.now();
    const earlier = new Date(now - 2 * 3600_000).toISOString();
    const later = new Date(now - 60_000).toISOString();
    getWebhookStore().put({ deliveryId: 'a', event: 'pull_request', payload: {}, receivedAt: earlier });
    getWebhookStore().put({ deliveryId: 'b', event: 'pull_request', payload: {}, receivedAt: later });
    const cutoffIso = new Date(now - 3600_000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/webhook/recent?since=${encodeURIComponent(cutoffIso)}`,
    });
    const ids = res.json().entries.map((e: { deliveryId: string }) => e.deliveryId);
    expect(ids).toEqual(['b']);
  });

  it('filters /recent by ?repo= (repoFullName equality)', async () => {
    _resetWebhookStoreForTests();
    const t = new Date().toISOString();
    getWebhookStore().put({
      deliveryId: 'a', event: 'pull_request', payload: {}, receivedAt: t, repoFullName: 'team/web',
    });
    getWebhookStore().put({
      deliveryId: 'b', event: 'pull_request', payload: {}, receivedAt: t, repoFullName: 'team/api',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?repo=team/api',
    });
    const ids = res.json().entries.map((e: { deliveryId: string }) => e.deliveryId);
    expect(ids).toEqual(['b']);
  });

  it('combines event + sinceMs filters with AND semantics', async () => {
    _resetWebhookStoreForTests();
    const now = Date.now();
    const oldPr = new Date(now - 24 * 3600_000).toISOString();
    const newPr = new Date(now - 60_000).toISOString();
    const newPush = new Date(now - 30_000).toISOString();
    getWebhookStore().put({ deliveryId: 'oldpr', event: 'pull_request', payload: {}, receivedAt: oldPr });
    getWebhookStore().put({ deliveryId: 'newpr', event: 'pull_request', payload: {}, receivedAt: newPr });
    getWebhookStore().put({ deliveryId: 'newpush', event: 'push', payload: {}, receivedAt: newPush });
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/webhook/recent?event=pull_request&sinceMs=${now - 3600_000}`,
    });
    const ids = res.json().entries.map((e: { deliveryId: string }) => e.deliveryId);
    expect(ids).toEqual(['newpr']);
  });

  it('paginates with ?after=<deliveryId>: walks the store newest-first one page at a time', async () => {
    _resetWebhookStoreForTests();
    // Seed 5 entries; insertion order is oldest -> newest, so the
    // newest-first list is e5, e4, e3, e2, e1.
    for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) {
      getWebhookStore().put({
        deliveryId: id,
        event: 'pull_request',
        payload: {},
        receivedAt: new Date().toISOString(),
      });
    }
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?limit=2',
    });
    expect(page1.statusCode).toBe(200);
    let body = page1.json();
    expect(body.entries.map((e: { deliveryId: string }) => e.deliveryId)).toEqual(['e5', 'e4']);
    expect(body.nextCursor).toBe('e4');

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/internal/webhook/recent?limit=2&after=${body.nextCursor}`,
    });
    body = page2.json();
    expect(body.entries.map((e: { deliveryId: string }) => e.deliveryId)).toEqual(['e3', 'e2']);
    expect(body.nextCursor).toBe('e2');
    expect(body.appliedFilters.after).toBe('e4');

    const page3 = await app.inject({
      method: 'GET',
      url: `/api/internal/webhook/recent?limit=2&after=${body.nextCursor}`,
    });
    body = page3.json();
    expect(body.entries.map((e: { deliveryId: string }) => e.deliveryId)).toEqual(['e1']);
    // Page didn't fill -> no further cursor.
    expect(body.nextCursor).toBeNull();
  });

  it('returns an empty page (and null cursor) for a stale or unknown ?after=', async () => {
    _resetWebhookStoreForTests();
    getWebhookStore().put({
      deliveryId: 'alive',
      event: 'pull_request',
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?after=evicted-or-fake',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('emits a nextCursor only when the page filled to the limit', async () => {
    _resetWebhookStoreForTests();
    for (const id of ['a', 'b', 'c']) {
      getWebhookStore().put({
        deliveryId: id,
        event: 'pull_request',
        payload: {},
        receivedAt: new Date().toISOString(),
      });
    }
    // limit > size -> page doesn't fill -> nextCursor null.
    const partial = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?limit=10',
    });
    expect(partial.json().entries).toHaveLength(3);
    expect(partial.json().nextCursor).toBeNull();
    // limit == size -> page fills exactly -> nextCursor is the
    // oldest returned id (next request will get an empty page).
    const exact = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?limit=3',
    });
    expect(exact.json().entries).toHaveLength(3);
    expect(exact.json().nextCursor).toBe('a');
    const followup = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?limit=3&after=a',
    });
    expect(followup.json().entries).toEqual([]);
    expect(followup.json().nextCursor).toBeNull();
  });

  it('composes ?after= with event/repo filters', async () => {
    _resetWebhookStoreForTests();
    // Mix events so the filter has work to do during pagination.
    getWebhookStore().put({
      deliveryId: 'pr1', event: 'pull_request', payload: {}, receivedAt: new Date().toISOString(),
    });
    getWebhookStore().put({
      deliveryId: 'push1', event: 'push', payload: {}, receivedAt: new Date().toISOString(),
    });
    getWebhookStore().put({
      deliveryId: 'pr2', event: 'pull_request', payload: {}, receivedAt: new Date().toISOString(),
    });
    getWebhookStore().put({
      deliveryId: 'push2', event: 'push', payload: {}, receivedAt: new Date().toISOString(),
    });
    // First page: pull_request only, limit 1 -> pr2 (newest), nextCursor pr2.
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?event=pull_request&limit=1',
    });
    let body = page1.json();
    expect(body.entries.map((e: { deliveryId: string }) => e.deliveryId)).toEqual(['pr2']);
    expect(body.nextCursor).toBe('pr2');
    // Second page: keep the event filter, advance past pr2 -> pr1.
    const page2 = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/recent?event=pull_request&limit=1&after=pr2',
    });
    body = page2.json();
    expect(body.entries.map((e: { deliveryId: string }) => e.deliveryId)).toEqual(['pr1']);
    expect(body.nextCursor).toBe('pr1');
  });
});

describe('/api/internal/webhook/stats', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    _resetWebhookStoreForTests();
  });
  afterAll(async () => app.close());

  it('returns a structured summary keyed by event and by event/action with hourly buckets', async () => {
    _resetWebhookStoreForTests();
    const now = Date.now();
    const t0 = new Date(now - 10 * 60_000).toISOString();
    const t1 = new Date(now - 90 * 60_000).toISOString();
    const t2 = new Date(now - 3 * 3600_000).toISOString();
    getWebhookStore().put({
      deliveryId: 's-1',
      event: 'pull_request',
      action: 'opened',
      payload: {},
      receivedAt: t0,
      repoFullName: 'team/api',
    });
    getWebhookStore().put({
      deliveryId: 's-2',
      event: 'pull_request',
      action: 'synchronize',
      payload: {},
      receivedAt: t1,
      repoFullName: 'team/api',
    });
    getWebhookStore().put({
      deliveryId: 's-3',
      event: 'push',
      payload: {},
      receivedAt: t2,
      repoFullName: 'team/web',
    });

    const res = await app.inject({ method: 'GET', url: '/api/internal/webhook/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.byEvent).toEqual({ pull_request: 2, push: 1 });
    expect(body.byEventAction).toEqual({
      'pull_request/opened': 1,
      'pull_request/synchronize': 1,
      'push/(none)': 1,
    });
    expect(body.hourly.bucketSizeMs).toBe(3_600_000);
    expect(body.hourly.granularity).toBe('hour');
    expect(body.hourly.buckets).toHaveLength(24);
    expect(body.appliedFilters.granularity).toBe('hour');
    expect(body.appliedFilters.buckets).toBe(24);
    // s-1 (10 min ago) lands in bucket 0; s-2 (1.5h ago) lands in bucket 1;
    // s-3 (3h ago) lands in bucket 3. Other buckets stay zero.
    expect(body.hourly.buckets[0]).toBe(1);
    expect(body.hourly.buckets[1]).toBe(1);
    expect(body.hourly.buckets[3]).toBe(1);
    expect(body.hourly.buckets[2]).toBe(0);
  });

  it('filters by event, repo, and sinceMs with AND semantics', async () => {
    _resetWebhookStoreForTests();
    const now = Date.now();
    const recent = new Date(now - 60_000).toISOString();
    const old = new Date(now - 24 * 3600_000).toISOString();
    getWebhookStore().put({
      deliveryId: 'f-1', event: 'pull_request', action: 'opened', payload: {}, receivedAt: recent, repoFullName: 'team/api',
    });
    getWebhookStore().put({
      deliveryId: 'f-2', event: 'pull_request', action: 'opened', payload: {}, receivedAt: recent, repoFullName: 'team/web',
    });
    getWebhookStore().put({
      deliveryId: 'f-3', event: 'pull_request', action: 'opened', payload: {}, receivedAt: old, repoFullName: 'team/api',
    });
    getWebhookStore().put({
      deliveryId: 'f-4', event: 'push', payload: {}, receivedAt: recent, repoFullName: 'team/api',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/webhook/stats?event=pull_request&repo=team/api&sinceMs=${now - 3600_000}`,
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.byEvent).toEqual({ pull_request: 1 });
    expect(body.byEventAction).toEqual({ 'pull_request/opened': 1 });
    expect(body.appliedFilters).toMatchObject({
      event: 'pull_request',
      repoFullName: 'team/api',
    });
  });

  it('honors hourBuckets / hours param (and clamps to [1, 168])', async () => {
    _resetWebhookStoreForTests();
    const now = Date.now();
    getWebhookStore().put({
      deliveryId: 'h-1', event: 'push', payload: {}, receivedAt: new Date(now - 60_000).toISOString(),
    });
    // Explicit hourBuckets=6
    const six = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/stats?hourBuckets=6',
    });
    expect(six.json().hourly.buckets).toHaveLength(6);
    expect(six.json().appliedFilters.buckets).toBe(6);

    // hours alias works
    const aliased = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/stats?hours=12',
    });
    expect(aliased.json().hourly.buckets).toHaveLength(12);

    // Out-of-range clamps. Asking for 9999 hours falls back to 168.
    const big = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/stats?hourBuckets=9999',
    });
    expect(big.json().hourly.buckets).toHaveLength(168);
    // Asking for 0 clamps up to 1.
    const zero = await app.inject({
      method: 'GET',
      url: '/api/internal/webhook/stats?hourBuckets=0',
    });
    expect(zero.json().hourly.buckets).toHaveLength(24);
  });

  it('returns an empty stats response when the store is empty', async () => {
    _resetWebhookStoreForTests();
    const res = await app.inject({ method: 'GET', url: '/api/internal/webhook/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(0);
    expect(body.byEvent).toEqual({});
    expect(body.byEventAction).toEqual({});
    expect(body.hourly.buckets.every((n: number) => n === 0)).toBe(true);
  });

  describe('granularity', () => {
    it('returns minute buckets when granularity=minute', async () => {
      _resetWebhookStoreForTests();
      const now = Date.now();
      getWebhookStore().put({
        deliveryId: 'm-1', event: 'push', payload: {}, receivedAt: new Date(now - 90_000).toISOString(),
      });
      getWebhookStore().put({
        deliveryId: 'm-2', event: 'push', payload: {}, receivedAt: new Date(now - 200_000).toISOString(),
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?granularity=minute',
      });
      const body = res.json();
      expect(body.hourly.granularity).toBe('minute');
      expect(body.hourly.bucketSizeMs).toBe(60_000);
      expect(body.hourly.buckets).toHaveLength(60); // default for minute
      expect(body.appliedFilters.granularity).toBe('minute');
      expect(body.appliedFilters.buckets).toBe(60);
      // 90s -> bucket 1; 200s -> bucket 3
      expect(body.hourly.buckets[1]).toBe(1);
      expect(body.hourly.buckets[3]).toBe(1);
    });

    it('returns day buckets when granularity=day', async () => {
      _resetWebhookStoreForTests();
      const now = Date.now();
      getWebhookStore().put({
        deliveryId: 'd-1', event: 'push', payload: {}, receivedAt: new Date(now - 3 * 3600_000).toISOString(),
      });
      getWebhookStore().put({
        deliveryId: 'd-2', event: 'push', payload: {}, receivedAt: new Date(now - 2 * 86_400_000 - 3600_000).toISOString(),
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?granularity=day',
      });
      const body = res.json();
      expect(body.hourly.granularity).toBe('day');
      expect(body.hourly.bucketSizeMs).toBe(86_400_000);
      expect(body.hourly.buckets).toHaveLength(14); // default for day
      expect(body.appliedFilters.granularity).toBe('day');
      // 3h ago -> bucket 0; ~2d 1h ago -> bucket 2
      expect(body.hourly.buckets[0]).toBe(1);
      expect(body.hourly.buckets[2]).toBe(1);
    });

    it('falls back to hour granularity when granularity param is invalid', async () => {
      _resetWebhookStoreForTests();
      const res = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?granularity=fortnight',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.hourly.granularity).toBe('hour');
      expect(body.hourly.bucketSizeMs).toBe(3_600_000);
      expect(body.appliedFilters.granularity).toBe('hour');
    });

    it('clamps per-granularity bucket count', async () => {
      _resetWebhookStoreForTests();
      // minute caps at 240
      const mBig = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?granularity=minute&buckets=999',
      });
      expect(mBig.json().hourly.buckets).toHaveLength(240);
      // day caps at 90
      const dBig = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?granularity=day&buckets=999',
      });
      expect(dBig.json().hourly.buckets).toHaveLength(90);
    });

    it('the modern `buckets` query param wins over legacy hourBuckets/hours', async () => {
      _resetWebhookStoreForTests();
      const res = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?buckets=7&hourBuckets=99&hours=99',
      });
      expect(res.json().hourly.buckets).toHaveLength(7);
      expect(res.json().appliedFilters.buckets).toBe(7);
    });
  });

  describe('byRepo slice', () => {
    it('counts entries per repoFullName so dashboards can spot noisy repos', async () => {
      _resetWebhookStoreForTests();
      const now = Date.now();
      const at = (offsetMs: number) => new Date(now - offsetMs).toISOString();
      // 3 deliveries on team/api, 1 on team/web, 1 with no repo
      // (installation-style event).
      getWebhookStore().put({
        deliveryId: 'r-1',
        event: 'pull_request',
        action: 'opened',
        payload: {},
        receivedAt: at(60_000),
        repoFullName: 'team/api',
      });
      getWebhookStore().put({
        deliveryId: 'r-2',
        event: 'pull_request',
        action: 'opened',
        payload: {},
        receivedAt: at(120_000),
        repoFullName: 'team/api',
      });
      getWebhookStore().put({
        deliveryId: 'r-3',
        event: 'push',
        payload: {},
        receivedAt: at(180_000),
        repoFullName: 'team/api',
      });
      getWebhookStore().put({
        deliveryId: 'r-4',
        event: 'pull_request',
        action: 'opened',
        payload: {},
        receivedAt: at(240_000),
        repoFullName: 'team/web',
      });
      getWebhookStore().put({
        deliveryId: 'r-5',
        event: 'installation',
        payload: {},
        receivedAt: at(300_000),
        // No repoFullName -- installation-level events land under (none).
      });
      const res = await app.inject({ method: 'GET', url: '/api/internal/webhook/stats' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.byRepo['team/api']).toBe(3);
      expect(body.byRepo['team/web']).toBe(1);
      expect(body.byRepo['(none)']).toBe(1);
      // Sum of byRepo must reconcile with the total counted entries.
      const sum = Object.values(body.byRepo as Record<string, number>).reduce(
        (a, b) => a + b,
        0,
      );
      expect(sum).toBe(body.total);
    });

    it('caps byRepo at topRepos and collapses the tail into (other)', async () => {
      _resetWebhookStoreForTests();
      // 6 distinct repos; ask for only top 3 so the tail of 3 should
      // collapse into (other).
      for (let i = 0; i < 6; i++) {
        getWebhookStore().put({
          deliveryId: `cap-${i}`,
          event: 'push',
          payload: {},
          receivedAt: new Date().toISOString(),
          // Make repo-0 most frequent (3 hits), then repo-1 (2 hits),
          // then everyone else once so the top-3 ordering is stable.
          repoFullName: `team/r${i}`,
        });
      }
      // Add extra hits to make the top stable.
      getWebhookStore().put({
        deliveryId: 'cap-r0-extra-a',
        event: 'push',
        payload: {},
        receivedAt: new Date().toISOString(),
        repoFullName: 'team/r0',
      });
      getWebhookStore().put({
        deliveryId: 'cap-r0-extra-b',
        event: 'push',
        payload: {},
        receivedAt: new Date().toISOString(),
        repoFullName: 'team/r0',
      });
      getWebhookStore().put({
        deliveryId: 'cap-r1-extra',
        event: 'push',
        payload: {},
        receivedAt: new Date().toISOString(),
        repoFullName: 'team/r1',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?topRepos=3',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Top 3 by count: r0 (3), r1 (2), one of r2..r5 (1, picked by
      // localeCompare tiebreak -> 'team/r2').
      expect(body.byRepo['team/r0']).toBe(3);
      expect(body.byRepo['team/r1']).toBe(2);
      expect(body.byRepo['team/r2']).toBe(1);
      // The remaining three single-hit repos collapse into (other).
      expect(body.byRepo['(other)']).toBe(3);
      // Trimmed map still reconciles with total.
      const sum = Object.values(body.byRepo as Record<string, number>).reduce(
        (a, b) => a + b,
        0,
      );
      expect(sum).toBe(body.total);
      expect(body.appliedFilters.topRepos).toBe(3);
    });

    it('clamps topRepos into [1, 200] when a malformed value lands on the wire', async () => {
      _resetWebhookStoreForTests();
      const tooHigh = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?topRepos=99999',
      });
      expect(tooHigh.json().appliedFilters.topRepos).toBe(200);
      const tooLow = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?topRepos=0',
      });
      expect(tooLow.json().appliedFilters.topRepos).toBe(50);
    });

    it('byRepo honors the repoFullName filter (only the matched repo present)', async () => {
      _resetWebhookStoreForTests();
      const now = Date.now();
      getWebhookStore().put({
        deliveryId: 'f-1',
        event: 'pull_request',
        action: 'opened',
        payload: {},
        receivedAt: new Date(now - 60_000).toISOString(),
        repoFullName: 'team/alpha',
      });
      getWebhookStore().put({
        deliveryId: 'f-2',
        event: 'pull_request',
        action: 'opened',
        payload: {},
        receivedAt: new Date(now - 60_000).toISOString(),
        repoFullName: 'team/beta',
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?repo=team/alpha',
      });
      const body = res.json();
      expect(body.byRepo).toEqual({ 'team/alpha': 1 });
      expect(body.total).toBe(1);
    });

    it('returns an empty byRepo map when the store is empty', async () => {
      _resetWebhookStoreForTests();
      const res = await app.inject({ method: 'GET', url: '/api/internal/webhook/stats' });
      const body = res.json();
      expect(body.byRepo).toEqual({});
    });
  });

  describe('peak bucket', () => {
    it('reports peakBucketIndex + peakBucketCount over the sparkline', async () => {
      _resetWebhookStoreForTests();
      const now = Date.now();
      // Three deliveries in bucket 0 (last 10 min), one in bucket 2 (~2.5h ago).
      // Peak should be index 0 with count 3.
      for (let i = 0; i < 3; i++) {
        getWebhookStore().put({
          deliveryId: `pk-recent-${i}`,
          event: 'push',
          payload: {},
          receivedAt: new Date(now - 5 * 60_000).toISOString(),
          repoFullName: 'team/api',
        });
      }
      getWebhookStore().put({
        deliveryId: 'pk-old',
        event: 'push',
        payload: {},
        receivedAt: new Date(now - 2 * 3600_000 - 30 * 60_000).toISOString(),
        repoFullName: 'team/api',
      });
      const res = await app.inject({ method: 'GET', url: '/api/internal/webhook/stats' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.hourly.peakBucketIndex).toBe(0);
      expect(body.hourly.peakBucketCount).toBe(3);
    });

    it('returns peakBucketIndex=null + peakBucketCount=0 when every bucket is empty', async () => {
      _resetWebhookStoreForTests();
      const res = await app.inject({ method: 'GET', url: '/api/internal/webhook/stats' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(0);
      // No deliveries means no peak.
      expect(body.hourly.peakBucketIndex).toBeNull();
      expect(body.hourly.peakBucketCount).toBe(0);
    });

    it('breaks ties toward the newer (smaller-index) bucket', async () => {
      _resetWebhookStoreForTests();
      const now = Date.now();
      // Put 2 deliveries in bucket 0 AND 2 in bucket 5; tie-break must
      // pick the newer (smaller index = 0).
      for (let i = 0; i < 2; i++) {
        getWebhookStore().put({
          deliveryId: `tie-new-${i}`,
          event: 'push',
          payload: {},
          receivedAt: new Date(now - 5 * 60_000).toISOString(),
          repoFullName: 'team/api',
        });
      }
      for (let i = 0; i < 2; i++) {
        getWebhookStore().put({
          deliveryId: `tie-old-${i}`,
          event: 'push',
          payload: {},
          receivedAt: new Date(now - 5 * 3600_000 - 30 * 60_000).toISOString(),
          repoFullName: 'team/api',
        });
      }
      const res = await app.inject({ method: 'GET', url: '/api/internal/webhook/stats' });
      const body = res.json();
      expect(body.hourly.peakBucketIndex).toBe(0);
      expect(body.hourly.peakBucketCount).toBe(2);
    });

    it('peak respects the requested granularity (minute buckets render a tighter peak)', async () => {
      _resetWebhookStoreForTests();
      const now = Date.now();
      // Two recent deliveries (last minute), one 30 minutes ago.
      // With granularity=minute (60 buckets, 1-min wide), the peak
      // lands at index 0 with count 2.
      for (let i = 0; i < 2; i++) {
        getWebhookStore().put({
          deliveryId: `gr-now-${i}`,
          event: 'push',
          payload: {},
          receivedAt: new Date(now - 30_000).toISOString(),
          repoFullName: 'team/api',
        });
      }
      getWebhookStore().put({
        deliveryId: 'gr-30m',
        event: 'push',
        payload: {},
        receivedAt: new Date(now - 30 * 60_000).toISOString(),
        repoFullName: 'team/api',
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/stats?granularity=minute',
      });
      const body = res.json();
      expect(body.hourly.granularity).toBe('minute');
      expect(body.hourly.peakBucketIndex).toBe(0);
      expect(body.hourly.peakBucketCount).toBe(2);
    });
  });

  // Tick 10: ingress-side counter wired on the receiver's put() path
  // so Prometheus and the dashboard observe the same numbers. The
  // receiver bumps `clawreview_webhook_deliveries_total{event,repo}`
  // once per accepted delivery (after signature verification), with
  // `repo` sanitised to a lower-cased owner/name slug.
  describe('clawreview_webhook_deliveries_total{event,repo} ingress counter', () => {
    it('increments once per accepted delivery with sanitised repo label', async () => {
      _resetWebhookStoreForTests();
      // Snapshot the bundle and reset the registry so the assertions
      // below see only the counts emitted by THIS test.
      resetMetricsForTests();
      // Two deliveries with different repo case-shifts collapse to one
      // series via the sanitiser.
      await deliver(app, 'tick10-wd-1', {
        ...BASE_PR,
        repository: { ...BASE_PR.repository, full_name: 'Sanjay/Demo' },
      });
      await deliver(app, 'tick10-wd-2', {
        ...BASE_PR,
        repository: { ...BASE_PR.repository, full_name: 'sanjay/demo' },
      });
      const text = await getMetrics({ service: 'clawreview-server' }).registry.metrics();
      expect(text).toContain('# TYPE clawreview_webhook_deliveries_total counter');
      // Both deliveries land on the same series.
      expect(text).toMatch(
        /clawreview_webhook_deliveries_total\{[^}]*event="pull_request"[^}]*repo="sanjay\/demo"[^}]*\} 2/,
      );
    });

    it('still increments for events that carry no repository (lands in the "(none)" bucket)', async () => {
      _resetWebhookStoreForTests();
      resetMetricsForTests();
      // `ping` events carry no repository. The dispatch path tags
      // them with `result=accepted` on the webhookEventsTotal counter,
      // but the INGRESS counter (which we're testing here) fires
      // regardless and lands the entry under repo="(none)".
      const body = JSON.stringify({ zen: 'keep it logically awesome' });
      const sig = computeSignature(body, 'test-secret');
      await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'x-github-event': 'ping',
          'x-github-delivery': 'tick10-wd-ping',
          'x-hub-signature-256': sig,
          'content-type': 'application/json',
        },
        payload: body,
      });
      const text = await getMetrics({ service: 'clawreview-server' }).registry.metrics();
      expect(text).toMatch(
        /clawreview_webhook_deliveries_total\{[^}]*event="ping"[^}]*repo="\(none\)"[^}]*\} 1/,
      );
    });

    it('does NOT count duplicate deliveries (idempotency cache short-circuits before put)', async () => {
      _resetWebhookStoreForTests();
      resetMetricsForTests();
      await deliver(app, 'tick10-wd-dup', BASE_PR);
      await deliver(app, 'tick10-wd-dup', BASE_PR);
      await deliver(app, 'tick10-wd-dup', BASE_PR);
      const text = await getMetrics({ service: 'clawreview-server' }).registry.metrics();
      // The idempotency cache short-circuits before put() fires, so the
      // counter only sees the first delivery -- the two duplicates
      // never reach the put() path.
      expect(text).toMatch(
        /clawreview_webhook_deliveries_total\{[^}]*event="pull_request"[^}]*repo="sanjay\/demo"[^}]*\} 1/,
      );
    });
  });

  // Tick 10: /api/internal/webhook/recent?payloadFields=action,number,
  // sender lets a dashboard request a slim entry shape (selected
  // top-level payload keys) instead of paying for the metadata-only
  // shape AND a separate get() round-trip. Existing callers that omit
  // the param see the unchanged metadata-only shape.
  describe('/api/internal/webhook/recent payloadFields projection', () => {
    it('omits payload by default (back-compat with tick 5/6 shape)', async () => {
      _resetWebhookStoreForTests();
      await deliver(app, 'pf-rec-default', BASE_PR);
      const res = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/recent',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries.length).toBeGreaterThanOrEqual(1);
      // No `payload` field on any entry when projection isn't requested.
      for (const e of body.entries) {
        expect(e.payload).toBeUndefined();
      }
      expect(body.appliedFilters.payloadFields).toBeUndefined();
    });

    it('returns the named top-level payload keys when ?payloadFields=... is set', async () => {
      _resetWebhookStoreForTests();
      await deliver(app, 'pf-rec-action', BASE_PR);
      const res = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/recent?payloadFields=action,number,pull_request',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries.length).toBeGreaterThanOrEqual(1);
      const entry = body.entries[0];
      expect(entry.payload).toBeDefined();
      // Only the requested keys land on the wire.
      expect(Object.keys(entry.payload).sort()).toEqual(
        ['action', 'number', 'pull_request'].sort(),
      );
      expect(entry.payload.action).toBe('opened');
      expect(entry.payload.number).toBe(11);
      // The unrequested `repository` / `installation` keys are absent.
      expect(entry.payload.repository).toBeUndefined();
      expect(entry.payload.installation).toBeUndefined();
      // appliedFilters echoes the parsed allowlist for client-side
      // sanity checks.
      expect(body.appliedFilters.payloadFields).toEqual(['action', 'number', 'pull_request']);
    });

    it('treats ?payloadFields= (empty value) as an explicit opt-out: payload === null on the wire', async () => {
      _resetWebhookStoreForTests();
      await deliver(app, 'pf-rec-empty', BASE_PR);
      const res = await app.inject({
        method: 'GET',
        url: '/api/internal/webhook/recent?payloadFields=',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries.length).toBeGreaterThanOrEqual(1);
      // Empty allowlist -> the store sets payload to undefined; on the
      // wire JSON.stringify drops undefined values, so `payload` is
      // absent from the entry exactly like the default shape.
      for (const e of body.entries) {
        expect(e.payload).toBeUndefined();
      }
      // The route still echoes the parsed empty allowlist so a
      // dashboard can tell it ran in opt-out mode rather than default.
      expect(body.appliedFilters.payloadFields).toEqual([]);
    });

    it('caps allowlist length at 32 names so a runaway query string is bounded', async () => {
      _resetWebhookStoreForTests();
      await deliver(app, 'pf-rec-cap', BASE_PR);
      // Build a long allowlist: 50 distinct names.
      const many = Array.from({ length: 50 }, (_, i) => `f${i}`).join(',');
      const res = await app.inject({
        method: 'GET',
        url: `/api/internal/webhook/recent?payloadFields=${many}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.appliedFilters.payloadFields.length).toBe(32);
    });
  });
});
