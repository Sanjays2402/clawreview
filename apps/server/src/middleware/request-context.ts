import type { FastifyInstance } from 'fastify';

export async function registerRequestContext(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ status: reply.statusCode, url: req.url, ms: reply.elapsedTime }, 'request completed');
  });
}
