import type { FastifyInstance } from 'fastify';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/readyz', async (_req, reply) => {
    // In a richer build this would check DB, Redis, and the LLM endpoints.
    reply.code(200);
    return { ok: true };
  });

  app.get('/version', async () => ({
    name: 'clawreview-server',
    version: process.env.npm_package_version ?? '0.1.0',
    node: process.version,
  }));
}
