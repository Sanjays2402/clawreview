import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getReviewStore } from '../services/review-store.js';

const ListQuerySchema = z.object({
  installation: z.coerce.number().int().positive().optional(),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export async function registerReviewsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/reviews', async (req, reply) => {
    const store = getReviewStore();
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadQuery', issues: parsed.error.flatten() };
    }
    const { installation, ...rest } = parsed.data;
    const result = await store.list({ installationId: installation, ...rest });
    return {
      items: result.items.map(toReviewListDto),
      nextCursor: result.nextCursor,
    };
  });

  app.get('/api/reviews/:id', async (req, reply) => {
    const store = getReviewStore();
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const rec = await store.get(params.data.id);
    if (!rec) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    return toReviewDetailDto(rec);
  });

  const FindingActionSchema = z.object({
    action: z.enum(['dismiss', 'reopen']),
    reason: z.string().max(280).optional(),
  });

  app.post('/api/findings/:id', async (req, reply) => {
    const store = getReviewStore();
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const body = FindingActionSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const updated = await store.findingAction(params.data.id, body.data.action, body.data.reason);
    if (!updated) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    return { ok: true, finding: { id: updated.id, state: updated.state } };
  });
}

function toReviewListDto(r: Awaited<ReturnType<ReturnType<typeof getReviewStore>['get']>> & object) {
  return {
    id: r.id,
    installationId: r.installationId,
    owner: r.owner,
    repo: r.repo,
    prNumber: r.prNumber,
    headSha: r.headSha,
    status: r.status,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    durationMs: r.durationMs,
    totalFindings: r.totalFindings,
    openFindings: r.findings.filter((f) => f.state === 'open').length,
    totalCostUsd: r.totalCostUsd,
  };
}

function toReviewDetailDto(r: Awaited<ReturnType<ReturnType<typeof getReviewStore>['get']>> & object) {
  return {
    ...toReviewListDto(r),
    baseSha: r.baseSha,
    error: r.error,
    commentId: r.commentId,
    checkRunId: r.checkRunId,
    agentExecutions: r.agentExecutions.map((ex) => ({
      agent: ex.agent,
      status: ex.status,
      durationMs: ex.durationMs,
      findings: ex.findings.length,
      error: ex.error,
    })),
    findings: r.findings,
  };
}
