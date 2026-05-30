import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listAudits } from '@clawreview/db';

const Query = z.object({
  installationId: z.string().min(1).optional(),
  actorLogin: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

/**
 * GET /api/audit returns recent audit entries, most recent first. Filters
 * compose with AND semantics. Pagination uses an opaque `cursor` (the id
 * of the last row from the previous page) so callers do not have to deal
 * with offsets.
 */
export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/audit', async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadQuery', issues: parsed.error.flatten() };
    }
    try {
      const items = await listAudits(parsed.data);
      const nextCursor = items.length === parsed.data.limit ? items[items.length - 1]?.id ?? null : null;
      return { items, nextCursor };
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'audit list failed');
      reply.code(503);
      return { error: 'AuditUnavailable', message: 'audit log backend unavailable' };
    }
  });
}
