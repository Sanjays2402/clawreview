import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const Query = z.object({
  installation: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/audit', async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadQuery' };
    }
    return { items: [] };
  });
}
