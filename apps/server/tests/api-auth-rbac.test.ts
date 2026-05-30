import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.API_AUTH_TOKENS = [
  'reader:readonly:read-token-aaaaaaaa',
  'ops:operator:ops-token-bbbbbbbb',
  'root:admin:admin-token-cccccccc',
  // Legacy "name:token" entry should still parse as admin so upgrades do
  // not silently downgrade existing deployments.
  'legacy:legacy-token-dddddddd',
].join(',');

const { buildServer } = await import('../src/server.js');
const { _internals } = await import('../src/plugins/api-auth.js');

describe('api auth RBAC', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());

  describe('token loader', () => {
    it('parses name:role:token entries', () => {
      const out = _internals.loadTokens('a:readonly:r,b:operator:o,c:admin:x');
      expect(out.map((t) => [t.name, t.role, t.buf.toString()])).toEqual([
        ['a', 'readonly', 'r'],
        ['b', 'operator', 'o'],
        ['c', 'admin', 'x'],
      ]);
    });

    it('keeps legacy name:token entries (role defaults to admin)', () => {
      const out = _internals.loadTokens('dashboard:supersecret');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ name: 'dashboard', role: 'admin' });
    });

    it('treats unknown role tokens as legacy (no silent downgrade)', () => {
      const out = _internals.loadTokens('weird:notarole:value');
      // First segment is not a role, so this becomes name=weird role=admin
      // token=notarole:value. The important property is that the role is
      // not weakened to readonly.
      expect(out[0].role).toBe('admin');
    });

    it('roleSatisfies respects hierarchy', () => {
      expect(_internals.roleSatisfies('admin', 'readonly')).toBe(true);
      expect(_internals.roleSatisfies('admin', 'operator')).toBe(true);
      expect(_internals.roleSatisfies('admin', 'admin')).toBe(true);
      expect(_internals.roleSatisfies('operator', 'readonly')).toBe(true);
      expect(_internals.roleSatisfies('operator', 'admin')).toBe(false);
      expect(_internals.roleSatisfies('readonly', 'operator')).toBe(false);
      expect(_internals.roleSatisfies('readonly', 'admin')).toBe(false);
    });
  });

  describe('route enforcement', () => {
    it('readonly token can GET /api/reviews', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/reviews',
        headers: { authorization: 'Bearer read-token-aaaaaaaa' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('readonly token is forbidden from POST /api/reviews/rerun', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/reviews/rerun',
        headers: { authorization: 'Bearer read-token-aaaaaaaa', 'content-type': 'application/json' },
        payload: JSON.stringify({
          installationId: 1,
          owner: 'o',
          repo: 'r',
          prNumber: 1,
          headSha: 'aaaaaaa',
          baseSha: 'bbbbbbb',
        }),
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toBe('Forbidden');
      expect(body.message).toMatch(/readonly/);
      expect(body.message).toMatch(/operator/);
    });

    it('readonly token is forbidden from DELETE /api/users/:login', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/users/octocat',
        headers: { authorization: 'Bearer read-token-aaaaaaaa' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('operator token is forbidden from DELETE /api/users/:login (admin-only)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/users/octocat',
        headers: { authorization: 'Bearer ops-token-bbbbbbbb' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/admin/);
    });

    it('operator token is forbidden from GET /api/audit (admin-only)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { authorization: 'Bearer ops-token-bbbbbbbb' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('admin token passes admin-only routes (even if backend fails)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { authorization: 'Bearer admin-token-cccccccc' },
      });
      // RBAC must let it through. The handler itself may return 200 or
      // 503 depending on DB availability; both prove RBAC did not block.
      expect([200, 503]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(403);
    });

    it('legacy name:token still grants admin (backward compatible)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { authorization: 'Bearer legacy-token-dddddddd' },
      });
      expect(res.statusCode).not.toBe(403);
      expect(res.statusCode).not.toBe(401);
    });

    it('still 401s when no credential is presented', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/reviews' });
      expect(res.statusCode).toBe(401);
    });
  });
});
