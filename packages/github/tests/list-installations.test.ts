import { describe, expect, it } from 'vitest';

import { AppAuth } from '../src/app-auth.js';

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetch: impl, calls };
}

// Minimal RSA-ish private key. We never actually use it because the JWT
// build step only runs for paths that need installation tokens, and the
// list-installations endpoint uses the App JWT but we let it sign with a
// fake key by stubbing the network call ahead of the verification.
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBOQ==\n-----END PRIVATE KEY-----\n';

describe('AppAuth.listInstallations', () => {
  it('paginates until a short page is returned', async () => {
    let pageHits = 0;
    const { fetch, calls } = mockFetch(async (url) => {
      if (!url.startsWith('https://api.github.com/app/installations')) {
        return new Response('not stubbed', { status: 599 });
      }
      pageHits += 1;
      // Page 1 full (perPage=2), page 2 short (1 item) so loop exits.
      if (pageHits === 1) {
        return new Response(
          JSON.stringify([
            mkInstall(1, 'octo'),
            mkInstall(2, 'hubot'),
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([mkInstall(3, 'tail')]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    // Override JWT signing by monkey-patching the prototype path: easier
    // here to just stub appJwt directly.
    const auth = new AppAuth({ appId: 1, privateKey: PEM }, fetch);
    (auth as unknown as { appJwt: () => string }).appJwt = () => 'fake.jwt.token';

    const items = await auth.listInstallations({ perPage: 2, maxPages: 5 });
    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(items[0]!.account?.login).toBe('octo');
    expect(items[0]!.targetType).toBe('Organization');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('per_page=2&page=1');
    expect(calls[1]!.url).toContain('page=2');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer fake.jwt.token');
  });

  it('surfaces HTTP errors with status attached', async () => {
    const { fetch } = mockFetch(
      async () => new Response('boom', { status: 502 }),
    );
    const auth = new AppAuth({ appId: 1, privateKey: PEM }, fetch);
    (auth as unknown as { appJwt: () => string }).appJwt = () => 'fake';
    await expect(auth.listInstallations({ perPage: 1, maxPages: 1 })).rejects.toMatchObject({
      message: expect.stringContaining('502'),
      status: 502,
    });
  });
});

function mkInstall(id: number, login: string) {
  return {
    id,
    account: { login, type: 'Organization', id: id + 1000 },
    target_type: 'Organization',
    repository_selection: 'all',
    app_slug: 'clawreview',
    suspended_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
  };
}
