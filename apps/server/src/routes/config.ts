import type { FastifyInstance } from 'fastify';
import YAML from 'yaml';
import { ClawReviewConfigSchema, DEFAULT_CONFIG } from '@clawreview/types';
import { z } from 'zod';

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config/default', { preHandler: app.requireRole('readonly') }, async () => DEFAULT_CONFIG);

  app.post('/api/config/validate', { preHandler: app.requireRole('readonly') }, async (req, reply) => {
    const body = z.object({ yaml: z.string().max(64 * 1024) }).safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    try {
      const parsed = YAML.parse(body.data.yaml);
      const result = ClawReviewConfigSchema.safeParse(parsed);
      if (!result.success) {
        reply.code(422);
        return { ok: false, issues: result.error.flatten() };
      }
      return { ok: true, config: result.data };
    } catch (err) {
      reply.code(422);
      return { ok: false, error: (err as Error).message };
    }
  });
}
