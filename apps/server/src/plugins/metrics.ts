import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getMetrics, observeHttp, registerQueueDepthCollector } from '@clawreview/telemetry';

import { getQueue } from '../queue.js';

/**
 * Records http_requests_total + http_request_duration_seconds for every
 * handled request. The route label is the matched Fastify route pattern
 * (e.g. /reviews/:id) so cardinality stays bounded; unmatched paths
 * collapse to "unmatched".
 *
 * The /metrics endpoint itself and /healthz are excluded to avoid
 * polluting time series with scrape traffic.
 */
const SKIP = new Set<string>(['/metrics', '/healthz']);

const startTimes = new WeakMap<FastifyRequest, bigint>();

export async function registerMetrics(app: FastifyInstance): Promise<void> {
  const metrics = getMetrics({ service: 'clawreview-server' });

  // Pull-time queue depth/inflight gauges. The collector calls into the
  // shared queue adapter on each scrape and silently no-ops if the backend
  // is unavailable, so /metrics never blocks longer than the queue health
  // probe (bounded by the BullMQ client / in-memory snapshot).
  try {
    const queue = getQueue();
    registerQueueDepthCollector(metrics, 'clawreview-reviews', async () => {
      if (!queue.health) return undefined;
      const h = await queue.health();
      return { pending: h.pending, inflight: h.inflight };
    });
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'queue depth collector not installed');
  }

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const path = (req.url.split('?')[0] ?? req.url);
    if (SKIP.has(path)) return;
    startTimes.set(req, process.hrtime.bigint());
  });

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const start = startTimes.get(req);
    if (start === undefined) return;
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route =
      (req as { routeOptions?: { url?: string } }).routeOptions?.url ??
      (req as { routerPath?: string }).routerPath ??
      'unmatched';
    observeHttp(
      metrics,
      {
        method: req.method,
        route,
        status_code: String(reply.statusCode),
      },
      durationSeconds,
    );
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
