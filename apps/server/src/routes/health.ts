import type { FastifyInstance } from 'fastify';
import { ProviderRegistry, probeEndpoint } from '@clawreview/llm';

import { env } from '../env.js';
import { getQueue } from '../queue.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/readyz', async (req, reply) => {
    const checks: Record<string, unknown> = {};
    let ok = true;

    // Queue check (in-memory always, BullMQ pings Redis).
    try {
      const queue = getQueue();
      if (typeof queue.health === 'function') {
        const h = await queue.health();
        checks.queue = h;
        if (!h.ok) ok = false;
      } else {
        checks.queue = { ok: true, backend: 'unknown' };
      }
    } catch (err) {
      ok = false;
      checks.queue = { ok: false, error: (err as Error).message };
    }

    // Optional LLM endpoint check. Skipped when ?skipLlm=1 (used by k8s
    // probes that don't want to depend on third parties).
    const skipLlm = String((req.query as { skipLlm?: string }).skipLlm ?? '') === '1';
    if (!skipLlm) {
      const registry = new ProviderRegistry({
        hermesBaseUrl: env.LLM_HERMES_BASE_URL,
        copilotBaseUrl: env.LLM_COPILOT_BASE_URL,
        copilotApiKey: env.LLM_COPILOT_API_KEY || undefined,
        openaiBaseUrl: env.LLM_OPENAI_BASE_URL,
        openaiApiKey: env.LLM_OPENAI_API_KEY || undefined,
      });
      const probes = await Promise.all(
        registry.endpoints().map(async (e) => {
          const r = await probeEndpoint(e.baseUrl, undefined, 1200);
          return { name: e.name, baseUrl: e.baseUrl, ...r };
        }),
      );
      checks.llm = probes;
      // Readiness only requires one provider to be reachable so a local-only
      // deployment without OpenAI keys still reports ready.
      if (!probes.some((p) => p.ok)) ok = false;
    }

    reply.code(ok ? 200 : 503);
    return { ok, checks, ts: new Date().toISOString() };
  });

  app.get('/version', async () => ({
    name: 'clawreview-server',
    version: process.env.npm_package_version ?? '0.1.0',
    node: process.version,
  }));
}
