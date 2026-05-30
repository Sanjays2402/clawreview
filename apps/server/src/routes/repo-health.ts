import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getRepoHealth } from '../services/repo-health.js';

export async function registerRepoHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/repos/health', async () => {
    const items = getRepoHealth().list();
    return { items };
  });

  app.get('/api/repos/:owner/:repo/health', async (req, reply) => {
    const params = z
      .object({ owner: z.string().min(1), repo: z.string().min(1) })
      .safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const state = getRepoHealth().get(params.data.owner, params.data.repo);
    if (!state) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    return state;
  });

  app.post('/api/repos/:owner/:repo/pause', async (req, reply) => {
    const params = z
      .object({ owner: z.string().min(1), repo: z.string().min(1) })
      .safeParse(req.params);
    const body = z
      .object({
        reason: z.string().max(280).optional(),
        durationMs: z.number().int().positive().max(30 * 86400_000).optional(),
      })
      .safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const state = getRepoHealth().pause(
      params.data.owner,
      params.data.repo,
      body.data.reason,
      body.data.durationMs,
    );
    return { ok: true, state };
  });

  app.post('/api/repos/:owner/:repo/resume', async (req, reply) => {
    const params = z
      .object({ owner: z.string().min(1), repo: z.string().min(1) })
      .safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const state = getRepoHealth().resume(params.data.owner, params.data.repo);
    if (!state) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    return { ok: true, state };
  });
}
