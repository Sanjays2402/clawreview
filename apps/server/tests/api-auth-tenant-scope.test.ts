import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
// Three tokens:
//   acme   operator, scoped to installations 42 and 99
//   beta   operator, scoped to installation 7 only
//   root   admin, unscoped (legacy *) so it can reach everything
process.env.API_AUTH_TOKENS = [
  'acme:operator:42|99:acme-token-aaaaaaaa',
  'beta:operator:7:beta-token-bbbbbbbb',
  'root:admin:*:root-token-cccccccc',
].join(',');

const { buildServer } = await import('../src/server.js');
const { _internals } = await import('../src/plugins/api-auth.js');

describe('api auth tenant scoping', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => app.close());

  describe('scope parser', () => {
    it('treats * as unscoped (null)', () => {
      expect(_internals.parseScopes('*')).toBeNull();
    });

    it('parses a single installation id', () => {
      const s = _internals.parseScopes('42');
      expect(s).toBeInstanceOf(Set);
      expect(Array.from(s as Set<number>)).toEqual([42]);
    });

    it('parses pipe-separated ids', () => {
      const s = _internals.parseScopes('42|99|123');
      expect(Array.from(s as Set<number>).sort((a, b) => a - b)).toEqual([42, 99, 123]);
    });

    it('rejects non-numeric scopes', () => {
      expect(_internals.parseScopes('abc')).toBeUndefined();
      expect(_internals.parseScopes('42|abc')).toBeUndefined();
    });

    it('rejects zero, negative, and empty scopes', () => {
      expect(_internals.parseScopes('0')).toBeUndefined();
      expect(_internals.parseScopes('-1')).toBeUndefined();
      expect(_internals.parseScopes('')).toBeUndefined();
    });
  });

  describe('token loader', () => {
    it('parses name:role:scopes:token four-part form', () => {
      const out = _internals.loadTokens('acme:operator:42|99:secret');
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe('acme');
      expect(out[0].role).toBe('operator');
      expect(Array.from(out[0].installationScopes as Set<number>).sort((a, b) => a - b)).toEqual([42, 99]);
      expect(out[0].buf.toString()).toBe('secret');
    });

    it('* scope produces an unscoped token', () => {
      const out = _internals.loadTokens('root:admin:*:secret');
      expect(out[0].installationScopes).toBeNull();
      expect(out[0].buf.toString()).toBe('secret');
    });

    it('three-part name:role:token stays unscoped (backward compatible)', () => {
      const out = _internals.loadTokens('legacy:admin:still-works');
      expect(out[0].installationScopes).toBeNull();
      expect(out[0].buf.toString()).toBe('still-works');
    });

    it('preserves colons in the token body for the four-part form', () => {
      const out = _internals.loadTokens('svc:operator:1:abc:def:ghi');
      expect(out[0].buf.toString()).toBe('abc:def:ghi');
      expect(Array.from(out[0].installationScopes as Set<number>)).toEqual([1]);
    });
  });

  describe('route enforcement', () => {
    it('scoped token can read budget for an allowed installation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/budget/42',
        headers: { authorization: 'Bearer acme-token-aaaaaaaa' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().installationId).toBe(42);
    });

    it('scoped token is forbidden from a different installation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/budget/7',
        headers: { authorization: 'Bearer acme-token-aaaaaaaa' },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toBe('Forbidden');
      expect(body.message).toMatch(/acme/);
      expect(body.message).toMatch(/installation 7/);
    });

    it('scoped token is forbidden from POST /api/reviews/rerun for another tenant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/reviews/rerun',
        headers: { authorization: 'Bearer beta-token-bbbbbbbb', 'content-type': 'application/json' },
        payload: JSON.stringify({
          installationId: 42,
          owner: 'o',
          repo: 'r',
          prNumber: 1,
          headSha: 'aaaaaaa',
          baseSha: 'bbbbbbb',
        }),
      });
      expect(res.statusCode).toBe(403);
    });

    it('unscoped admin token reaches any installation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/budget/12345',
        headers: { authorization: 'Bearer root-token-cccccccc' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('scoped token with a bad installation id gets 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/budget/0',
        headers: { authorization: 'Bearer acme-token-aaaaaaaa' },
      });
      // Zod rejects 0 in the handler (positive int), but the scope guard
      // runs first. Either a 400 (scope guard rejecting non-positive)
      // or 403 (scope guard rejecting unknown id) is acceptable; what
      // matters is that the request never reaches the handler with a
      // forbidden id.
      expect([400, 403]).toContain(res.statusCode);
    });
  });
});
