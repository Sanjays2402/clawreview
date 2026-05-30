import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { env } from '../env.js';
import { getBudgetGuard } from '../budget.js';

const Params = z.object({ installationId: z.coerce.number().int().positive() });
const PutBody = z.object({ limitUsd: z.number().positive() });

export async function registerBudgetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/budget/:installationId', async (req, reply) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const guard = getBudgetGuard(env.DEFAULT_MONTHLY_BUDGET_USD);
    const snap = guard.snapshot(parsed.data.installationId);
    return {
      installationId: parsed.data.installationId,
      periodKey: snap.periodKey,
      spentUsd: snap.spentUsd,
      limitUsd: snap.limitUsd,
      remainingUsd: Math.max(0, snap.limitUsd - snap.spentUsd),
      overLimit: snap.spentUsd >= snap.limitUsd,
    };
  });

  app.post('/api/budget/:installationId/reset', async (req, reply) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const guard = getBudgetGuard(env.DEFAULT_MONTHLY_BUDGET_USD);
    guard.reset(parsed.data.installationId);
    return { ok: true };
  });

  app.put('/api/budget/:installationId', async (req, reply) => {
    const p = Params.safeParse(req.params);
    const b = PutBody.safeParse(req.body);
    if (!p.success || !b.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const guard = getBudgetGuard(env.DEFAULT_MONTHLY_BUDGET_USD);
    // Touch the ledger with $0 so the next snapshot reflects the new limit.
    guard.spent(p.data.installationId, 0, b.data.limitUsd);
    const snap = guard.snapshot(p.data.installationId, b.data.limitUsd);
    return { installationId: p.data.installationId, limitUsd: snap.limitUsd, spentUsd: snap.spentUsd };
  });
}
