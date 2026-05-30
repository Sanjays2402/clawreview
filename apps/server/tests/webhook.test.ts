import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const { computeSignature } = await import('@clawreview/github');
const { buildServer } = await import('../src/server.js');

const PR_PAYLOAD = JSON.stringify({
  action: 'opened',
  number: 7,
  pull_request: {
    id: 1,
    number: 7,
    title: 'Test PR',
    state: 'open',
    draft: false,
    head: { sha: 'abc123', ref: 'feat/x' },
    base: { sha: 'def456', ref: 'main' },
    user: { login: 'sanjay' },
  },
  repository: {
    id: 42,
    name: 'demo',
    full_name: 'sanjay/demo',
    owner: { login: 'sanjay', id: 1 },
  },
  installation: { id: 99 },
});

describe('POST /webhooks/github', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());

  it('rejects when signature is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd1',
        'content-type': 'application/json',
      },
      payload: PR_PAYLOAD,
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts when signature is correct', async () => {
    const sig = computeSignature(PR_PAYLOAD, 'test-secret');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd2',
        'x-hub-signature-256': sig,
        'content-type': 'application/json',
      },
      payload: PR_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.queued).toMatch(/pr-sanjay\/demo-7-abc123/);
    expect(json.reviewId).toMatch(/^rv_/);
  });

  it('responds to ping', async () => {
    const body = JSON.stringify({ zen: 'hello' });
    const sig = computeSignature(body, 'test-secret');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'ping',
        'x-github-delivery': 'd3',
        'x-hub-signature-256': sig,
        'content-type': 'application/json',
      },
      payload: body,
    });
    expect(res.json()).toEqual({ ok: true, pong: true });
  });

  it('treats a redelivered webhook as a duplicate', async () => {
    const sig = computeSignature(PR_PAYLOAD, 'test-secret');
    const headers = {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'dup-1',
      'x-hub-signature-256': sig,
      'content-type': 'application/json',
    };
    const first = await app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: PR_PAYLOAD });
    expect(first.statusCode).toBe(200);
    expect(first.json().duplicate).toBeUndefined();
    const firstReviewId = first.json().reviewId;

    const second = await app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: PR_PAYLOAD });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ ok: true, duplicate: true, delivery: 'dup-1' });

    // sanity: third delivery with a NEW id is processed again
    const third = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { ...headers, 'x-github-delivery': 'dup-2' },
      payload: PR_PAYLOAD,
    });
    expect(third.statusCode).toBe(200);
    expect(third.json().reviewId).not.toBe(firstReviewId);
  });
});
