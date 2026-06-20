import type { FastifyInstance } from 'fastify';

import { getQueue } from '../queue.js';

/**
 * GET /api/internal/queue
 *
 * Returns a live snapshot of the worker's queue: backend, pending/
 * inflight totals, per-job-name breakdown, and the most recent
 * failures (newest first). Intended for on-call dashboards and
 * `curl | jq` triage when a review job is stuck or failing.
 *
 * Auth:
 *   - readonly+ role required (matches the rest of /api/*)
 *
 * Failure behaviour:
 *   - If the underlying adapter exposes `details()`, that snapshot is
 *     returned verbatim with the route's request id and a stable
 *     200 status code. The adapter is responsible for ok=false +
 *     error message when the backend (e.g. Redis) is unreachable.
 *   - If the adapter only exposes `health()`, we synthesise a
 *     minimal details payload with `byName: []` and `recentFailures: []`
 *     so the response shape stays stable for consumers.
 *   - If neither hook exists, the route 503s rather than fabricate
 *     numbers.
 */
export async function registerInternalQueueRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/internal/queue',
    { preHandler: [app.requireRole('readonly')] },
    async (req, reply) => {
      const queue = getQueue();
      try {
        if (typeof queue.details === 'function') {
          const snap = await queue.details();
          return { requestId: req.id, ...snap };
        }
        if (typeof queue.health === 'function') {
          const h = await queue.health();
          return {
            requestId: req.id,
            ...h,
            byName: [],
            recentFailures: [],
            sampledAt: new Date().toISOString(),
          };
        }
        reply.code(503);
        return {
          requestId: req.id,
          ok: false,
          error: 'queue adapter exposes neither details() nor health()',
          sampledAt: new Date().toISOString(),
        };
      } catch (err) {
        req.log.warn({ err }, 'queue details() threw');
        reply.code(503);
        return {
          requestId: req.id,
          ok: false,
          error: (err as Error).message,
          sampledAt: new Date().toISOString(),
        };
      }
    },
  );
}
