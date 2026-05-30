import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getReviewStore } from '../services/review-store.js';
import {
  DEFAULT_SLA_POLICY,
  computeSlaBreaches,
  type SlaPolicy,
} from '../services/sla.js';

const SlaQuerySchema = z.object({
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  installation: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  // Per-severity SLA overrides in hours.
  critical_hours: z.coerce.number().positive().optional(),
  high_hours: z.coerce.number().positive().optional(),
  medium_hours: z.coerce.number().positive().optional(),
  low_hours: z.coerce.number().positive().optional(),
  nit_hours: z.coerce.number().positive().optional(),
});

export async function registerSlaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/reviews/sla/breaches', async (req, reply) => {
    const parsed = SlaQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadQuery', issues: parsed.error.flatten() };
    }
    const q = parsed.data;
    const store = getReviewStore();

    // Walk the cursor-paginated list a few pages deep so big repos don't
    // make this O(everything). 500 reviews is plenty for an SLA snapshot.
    const collected: Awaited<ReturnType<typeof store.list>>['items'] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (collected.length < q.limit && pages < 10) {
      const page = await store.list({
        installationId: q.installation,
        owner: q.owner,
        repo: q.repo,
        status: 'completed',
        limit: Math.min(100, q.limit - collected.length),
        cursor,
      });
      collected.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      pages += 1;
    }

    const policy: Partial<SlaPolicy> = {};
    if (q.critical_hours !== undefined) policy.critical = q.critical_hours;
    if (q.high_hours !== undefined) policy.high = q.high_hours;
    if (q.medium_hours !== undefined) policy.medium = q.medium_hours;
    if (q.low_hours !== undefined) policy.low = q.low_hours;
    if (q.nit_hours !== undefined) policy.nit = q.nit_hours;

    const summary = computeSlaBreaches(collected, { policy });
    return {
      reviewsScanned: collected.length,
      defaultPolicy: DEFAULT_SLA_POLICY,
      ...summary,
    };
  });
}
