import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createLogger, newRequestId, captureException } from '@clawreview/telemetry';

import { env } from './env.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerReviewsRoutes } from './routes/reviews.js';
import { registerInstallationsRoutes } from './routes/installations.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerBudgetRoutes } from './routes/budget.js';
import { registerRerunRoutes } from './routes/rerun.js';
import { registerRepoHealthRoutes } from './routes/repo-health.js';
import { registerSlaRoutes } from './routes/sla.js';

export async function buildServer(): Promise<FastifyInstance> {
  const logger = createLogger({
    service: 'clawreview-server',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });

  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => newRequestId(),
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: [env.DASHBOARD_URL], credentials: true });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: '1 minute',
    allowList: (req) => req.url.startsWith('/healthz') || req.url.startsWith('/metrics'),
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await registerMetrics(app);
  await registerHealthRoutes(app);
  await registerWebhookRoutes(app);
  await registerReviewsRoutes(app);
  await registerInstallationsRoutes(app);
  await registerAuditRoutes(app);
  await registerConfigRoutes(app);
  await registerStatsRoutes(app);
  await registerBudgetRoutes(app);
  await registerRerunRoutes(app);
  await registerRepoHealthRoutes(app);
  await registerSlaRoutes(app);

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'unhandled error');
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    // Only forward genuine server-side faults to Sentry. 4xx errors
    // (validation, auth, rate-limit) are caller mistakes and would just
    // create noise. Captures are no-ops when SENTRY_DSN is unset.
    if (status >= 500) {
      captureException(err, {
        requestId: req.id,
        method: req.method,
        url: req.url,
        route:
          (req as { routeOptions?: { url?: string } }).routeOptions?.url ??
          (req as { routerPath?: string }).routerPath ??
          'unmatched',
      });
    }
    reply.code(status).send({
      error: err.name || 'InternalServerError',
      message: status >= 500 ? 'Internal Server Error' : err.message,
      requestId: req.id,
    });
  });

  return app;
}
