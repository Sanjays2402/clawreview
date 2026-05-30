import type { FastifyInstance } from 'fastify';

export async function registerInstallationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/installations', { preHandler: app.requireRole('readonly') }, async () => ({ items: [] }));
  app.get('/api/installations/:id/repos', { preHandler: app.requireRole('readonly') }, async () => ({ items: [] }));
}
