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
});
