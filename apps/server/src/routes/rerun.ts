import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '@clawreview/db';

import { REVIEW_JOB, getQueue } from '../queue.js';
import { getReviewStore } from '../services/review-store.js';

const Body = z.object({
  installationId: z.number().int().positive(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  headSha: z.string().min(7),
  baseSha: z.string().min(7),
});

/**
 * POST /api/reviews/rerun creates a fresh review row, enqueues a manual
 * review job for the worker, and returns the new reviewId so the dashboard
 * can poll it. Idempotency is intentionally weak: re-posting the same body
 * will produce a new review with a new id, which is the right behaviour for
 * a "Re-run" button.
 */
export async function registerRerunRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/reviews/rerun', { preHandler: app.requireRole('operator') }, async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadInput', issues: parsed.error.flatten() };
    }
    const input = parsed.data;
    const store = getReviewStore();
    const started = await store.start(input);
    const queue = getQueue();
    const jobId = `manual-${input.owner}/${input.repo}-${input.prNumber}-${input.headSha}-${Date.now()}`;
    await queue.enqueue(
      REVIEW_JOB,
      {
        reviewId: started.id,
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        headSha: input.headSha,
        baseSha: input.baseSha,
        reason: 'manual' as const,
      },
      { jobId },
    );
    await audit(
      {
        installationId: String(input.installationId),
        actorLogin: (req.headers['x-actor-login'] as string | undefined) ?? 'dashboard',
        action: 'review.rerun',
        subject: `${input.owner}/${input.repo}#${input.prNumber}`,
        meta: {
          reviewId: started.id,
          jobId,
          headSha: input.headSha,
          baseSha: input.baseSha,
          source: 'manual',
        },
      },
      { logger: req.log },
    );
    reply.code(202);
    return { ok: true, reviewId: started.id, jobId };
  });
}
