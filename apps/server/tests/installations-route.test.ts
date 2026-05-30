import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Disable API auth in this suite so we exercise the route logic directly.
// The api-auth-rbac suite already covers role enforcement on this path.
process.env.NODE_ENV = 'test';
delete process.env.API_AUTH_TOKENS;

const { default: Fastify } = await import('fastify');
const { registerApiAuth } = await import('../src/plugins/api-auth.js');
const { registerInstallationsRoutes } = await import('../src/routes/installations.js');

interface FetchCall {
  url: string;
  init: RequestInit;
}

function buildFetch(
  responses: Array<{ match: RegExp; status?: number; body: unknown }>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const hit = responses.find((r) => r.match.test(url));
    if (!hit) {
      return new Response(JSON.stringify({ message: `unstubbed url: ${url}` }), {
        status: 599,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

async function buildApp(appAuth: unknown) {
  const app = Fastify({ logger: false });
  await registerApiAuth(app);
  await registerInstallationsRoutes(app, { appAuth: appAuth as never });
  await app.ready();
  return app;
}

describe('installations routes', () => {
  it('returns 503 when GitHub App is not configured', async () => {
    const app = await buildApp(null);
    try {
      const list = await app.inject({ method: 'GET', url: '/api/installations' });
      expect(list.statusCode).toBe(503);
      expect(list.json()).toMatchObject({ error: 'GitHubAppNotConfigured' });

      const repos = await app.inject({ method: 'GET', url: '/api/installations/42/repos' });
      expect(repos.statusCode).toBe(503);
      expect(repos.json()).toMatchObject({ error: 'GitHubAppNotConfigured' });
    } finally {
      await app.close();
    }
  });

  it('lists installations and exposes count', async () => {
    const { AppAuth } = await import('@clawreview/github');
    const { fetch, calls } = buildFetch([
      {
        match: /\/app\/installations\?per_page=100&page=1/,
        body: [
          {
            id: 1,
            account: { login: 'octo', type: 'Organization', id: 9 },
            target_type: 'Organization',
            repository_selection: 'all',
            app_slug: 'clawreview',
            suspended_at: null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z',
          },
        ],
      },
    ]);
    // A minimal private key is fine; the JWT signer is never reached
    // because we never hit /access_tokens in this test.
    const auth = new AppAuth({ appId: 1, privateKey: 'unused' }, fetch);
    (auth as unknown as { appJwt: () => string }).appJwt = () => 'fake.jwt.token';
    const app = await buildApp(auth);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/installations' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(1);
      expect(body.items[0]).toMatchObject({
        id: 1,
        targetType: 'Organization',
        repositorySelection: 'all',
        account: { login: 'octo', type: 'Organization', id: 9 },
        appSlug: 'clawreview',
      });
      expect(calls.some((c) => c.url.includes('/app/installations'))).toBe(true);
      const authHeader = (calls[0]!.init.headers as Record<string, string>).authorization;
      expect(authHeader).toMatch(/^Bearer /);
    } finally {
      await app.close();
    }
  });

  it('rejects non-numeric installation ids with 400', async () => {
    const app = await buildApp({
      listInstallations: vi.fn(),
      listInstallationRepositories: vi.fn(),
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/installations/abc/repos' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'BadParam' });
    } finally {
      await app.close();
    }
  });

  it('propagates 404 from GitHub for unknown installations', async () => {
    const stub = {
      listInstallations: vi.fn(),
      listInstallationRepositories: vi.fn(async () => {
        const err = new Error('list installation repos failed: 404 Not Found') as Error & {
          status?: number;
        };
        err.status = 404;
        throw err;
      }),
    };
    const app = await buildApp(stub);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/installations/999/repos' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'NotFound' });
    } finally {
      await app.close();
    }
  });

  it('returns repos for a known installation with pagination metadata', async () => {
    const stub = {
      listInstallations: vi.fn(),
      listInstallationRepositories: vi.fn(async () => ({
        totalCount: 2,
        repositories: [
          {
            id: 10,
            nodeId: 'R_10',
            name: 'one',
            fullName: 'octo/one',
            private: false,
            defaultBranch: 'main',
            archived: false,
            disabled: false,
            htmlUrl: 'https://github.com/octo/one',
          },
          {
            id: 11,
            nodeId: 'R_11',
            name: 'two',
            fullName: 'octo/two',
            private: true,
            defaultBranch: 'main',
            archived: false,
            disabled: false,
            htmlUrl: 'https://github.com/octo/two',
          },
        ],
      })),
    };
    const app = await buildApp(stub);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/installations/42/repos?per_page=50&page=2',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.installationId).toBe(42);
      expect(body.totalCount).toBe(2);
      expect(body.items).toHaveLength(2);
      expect(body.perPage).toBe(50);
      expect(body.page).toBe(2);
      expect(stub.listInstallationRepositories).toHaveBeenCalledWith(42, {
        perPage: 50,
        page: 2,
      });
    } finally {
      await app.close();
    }
  });
});
