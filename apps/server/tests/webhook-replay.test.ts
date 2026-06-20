import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const { computeSignature } = await import('@clawreview/github');
const { buildServer } = await import('../src/server.js');
const { getWebhookStore, _resetWebhookStoreForTests } = await import(
  '../src/services/webhook-store.js'
);

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
    expect(body.hourly.buckets).toHaveLength(24);
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
    expect(six.json().appliedFilters.hourBuckets).toBe(6);

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
});
