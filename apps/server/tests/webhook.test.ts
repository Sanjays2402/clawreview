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
    expect(res.json().queued).toMatch(/^pr-/);
  });
});
