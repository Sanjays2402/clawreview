import { buildServer } from './server.js';
import { env } from './env.js';
import { startWorker } from './worker.js';

async function main() {
  const app = await buildServer();
  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info({ port: env.PORT, host: env.HOST }, 'clawreview server listening');

  // Start the background worker in the same process unless explicitly told not to.
  if (process.env.CLAWREVIEW_DISABLE_WORKER !== '1') {
    await startWorker(app.log);
  }

  const shutdown = async (signal: string) => {
    app.log.warn({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Server failed to start', err);
  process.exit(1);
});
