import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getReviewStore } from '../services/review-store.js';

const Query = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats/weekly', { preHandler: app.requireRole('readonly') }, async (req, reply) => {
    const store = getReviewStore();
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadQuery' };
    }
    return store.weeklyStats(parsed.data.days);
  });
}
