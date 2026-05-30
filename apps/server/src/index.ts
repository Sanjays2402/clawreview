import { initSentry, flushSentry, captureException } from '@clawreview/telemetry';

import { buildServer } from './server.js';
import { env } from './env.js';
import { startWorker } from './worker.js';

async function main() {
  // Initialise Sentry before anything else so early crashes are captured.
  // No-op when SENTRY_DSN is empty.
  await initSentry({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    release: env.SENTRY_RELEASE || process.env.npm_package_version,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    serverName: 'clawreview-server',
  });

  const app = await buildServer();
  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info({ port: env.PORT, host: env.HOST }, 'clawreview server listening');

  // Start the background worker in the same process unless explicitly told not to.
  if (process.env.CLAWREVIEW_DISABLE_WORKER !== '1') {
    await startWorker(app.log);
  }

  // Unhandled async errors in the worker (or any other detached code path)
  // would otherwise be invisible. Route them through Sentry before logging.
  process.on('unhandledRejection', (reason) => {
    captureException(reason, { source: 'unhandledRejection' });
    app.log.error({ err: reason }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    captureException(err, { source: 'uncaughtException' });
    app.log.fatal({ err }, 'uncaught exception');
  });

  const shutdown = async (signal: string) => {
    app.log.warn({ signal }, 'shutting down');
    await app.close();
    await flushSentry(2000);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  captureException(err, { source: 'bootstrap' });
  console.error('Server failed to start', err);
  void flushSentry(2000).finally(() => process.exit(1));
});
