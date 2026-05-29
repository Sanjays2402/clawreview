import type { FastifyInstance } from 'fastify';
export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats/weekly', async () => ({
    totalReviews: 0,
    totalFindings: 0,
    totalCostUsd: 0,
    p50LatencyMs: 0,
    dailyFindings: new Array(14).fill(0),
  }));
}
