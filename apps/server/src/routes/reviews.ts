import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ListQuerySchema = z.object({
  installation: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export async function registerReviewsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/reviews', async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadQuery', issues: parsed.error.flatten() };
    }
    // Real implementation will read from Prisma. We stub structure so the
    // dashboard contract is firm.
    return { items: [], nextCursor: null };
  });

  const FindingActionSchema = z.object({
    action: z.enum(['dismiss', 'reopen']),
    reason: z.string().max(280).optional(),
  });

  app.post('/api/findings/:id', async (req, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const body = FindingActionSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    return { ok: true, id: params.data.id, action: body.data.action };
  });
}
