import type { FastifyInstance } from 'fastify';

export async function registerInstallationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/installations', async () => ({ items: [] }));
  app.get('/api/installations/:id/repos', async () => ({ items: [] }));
}
