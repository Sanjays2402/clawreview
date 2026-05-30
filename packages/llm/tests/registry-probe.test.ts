import { describe, expect, it } from 'vitest';

import { ProviderRegistry, probeEndpoint } from '../src/registry.js';

describe('ProviderRegistry.endpoints', () => {
  it('exposes all three providers with their configured base URLs', () => {
    const r = new ProviderRegistry({
      hermesBaseUrl: 'http://h:1/v1',
      copilotBaseUrl: 'http://c:2/v1',
      openaiBaseUrl: 'http://o:3/v1',
      openaiApiKey: 'k',
    });
    const eps = r.endpoints();
    const byName = Object.fromEntries(eps.map((e) => [e.name, e]));
    expect(byName.hermes!.baseUrl).toBe('http://h:1/v1');
    expect(byName.copilot!.baseUrl).toBe('http://c:2/v1');
    expect(byName.openai!.baseUrl).toBe('http://o:3/v1');
    expect(byName.openai!.requiresKey).toBe(true);
    expect(byName.hermes!.requiresKey).toBe(false);
  });
});

describe('probeEndpoint', () => {
  it('reports ok=true on 2xx', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const r = await probeEndpoint('http://x/v1', undefined, 500, fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it('still ok=true on 401 (endpoint reachable but unauthorized)', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const r = await probeEndpoint('http://x/v1', undefined, 500, fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(401);
  });

  it('ok=false on 500', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const r = await probeEndpoint('http://x/v1', undefined, 500, fetchImpl);
    expect(r.ok).toBe(false);
  });

  it('ok=false on network error and surfaces the message', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    const r = await probeEndpoint('http://x/v1', undefined, 500, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it('sends bearer auth when an api key is provided', async () => {
    const captured: { auth?: string } = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      captured.auth = h.authorization;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await probeEndpoint('http://x/v1', 'sk-test', 500, fetchImpl);
    expect(captured.auth).toBe('Bearer sk-test');
  });
});
