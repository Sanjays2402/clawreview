import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
export async function registerReposRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/installations/:id/repos', { preHandler: app.requireRole('readonly') }, async (req, reply) => {
    const params = z.object({ id: z.string() }).safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: 'BadInput' }; }
    return { items: [] };
  });
}
