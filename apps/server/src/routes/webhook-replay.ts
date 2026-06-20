import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '@clawreview/db';

import { dispatchWebhook } from './webhooks.js';
import { getWebhookStore } from '../services/webhook-store.js';
import { getDeliveryCache } from '../services/delivery-cache.js';
import { getMetrics } from '@clawreview/telemetry';

/**
 * GET  /api/internal/webhook/recent
 * POST /api/internal/webhook/replay/:deliveryId
 *
 * Operator-facing endpoints for re-feeding a previously seen webhook
 * payload through the same dispatch path the live receiver uses. This is
 * useful when:
 *
 *   - A review job died on a worker bug we just fixed and we want to
 *     re-trigger it without waiting for GitHub's redelivery window.
 *   - Reproducing a flaky webhook locally without curl-stitching a fake
 *     payload from scratch.
 *
 * The replay forwards through `dispatchWebhook` so all the same author
 * filters, repo-pause checks, idempotency cache (cleared first), metrics
 * counters, and audit log lines fire. The replay endpoint records its
 * own audit entry (`webhook.replay`) so the dashboard can distinguish a
 * GitHub redelivery from an operator action.
 *
 * Auth: operator role (we are enqueueing review work, mirroring rerun).
 */

const ReplayParams = z.object({ deliveryId: z.string().min(1) });

// Monotonic counter so two replays issued in the same millisecond still
// get distinct delivery ids (and don't trip the idempotency cache).
let replaySeq = 0;
function nextReplaySeq(): number {
  replaySeq = (replaySeq + 1) & 0xffff;
  return replaySeq;
}

export async function registerWebhookReplayRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/internal/webhook/recent',
    { preHandler: [app.requireRole('readonly')] },
    async (req) => {
      const limitRaw = (req.query as { limit?: unknown } | undefined)?.limit;
      const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
      const entries = getWebhookStore().list(limit).map((e) => ({
        deliveryId: e.deliveryId,
        event: e.event,
        action: e.action,
        receivedAt: e.receivedAt,
        repoFullName: e.repoFullName,
        installationId: e.installationId,
      }));
      return {
        requestId: req.id,
        size: getWebhookStore().size(),
        limit,
        entries,
      };
    },
  );

  app.post(
    '/api/internal/webhook/replay/:deliveryId',
    { preHandler: [app.requireRole('operator')] },
    async (req, reply) => {
      const parsed = ReplayParams.safeParse(req.params);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'BadParams' };
      }
      const { deliveryId } = parsed.data;
      const entry = getWebhookStore().get(deliveryId);
      if (!entry) {
        reply.code(404);
        return {
          error: 'NotFound',
          message: `no stored webhook with delivery '${deliveryId}'`,
        };
      }
      // Allow the replay through the idempotency cache. Without this the
      // dispatch would short-circuit on the duplicate marker and never
      // reach the work.
      const cache = getDeliveryCache() as { clear?: () => void };
      if (typeof cache.clear === 'function') {
        // Soft-clear is too aggressive across all deliveries; instead
        // construct a fresh delivery id for the replay so the cache lets
        // it through but our audit log still references the original.
      }
      const replayDeliveryId = `${entry.deliveryId}::replay-${Date.now()}-${nextReplaySeq()}`;
      getDeliveryCache().reserve(replayDeliveryId);

      const metrics = getMetrics({ service: 'clawreview-server' });
      metrics.webhookEventsTotal.inc({
        event: entry.event,
        action: entry.action ?? 'replay',
        result: 'replayed',
      });

      let result: { statusCode?: number; body: Record<string, unknown> };
      try {
        result = await dispatchWebhook(entry.event, replayDeliveryId, entry.payload, req.log);
      } catch (err) {
        req.log.error({ err, deliveryId }, 'webhook replay dispatch failed');
        reply.code(500);
        return {
          error: 'ReplayFailed',
          message: (err as Error).message,
          originalDelivery: deliveryId,
        };
      }

      await audit(
        {
          installationId: entry.installationId ? String(entry.installationId) : 'unknown',
          actorLogin: (req.headers['x-actor-login'] as string | undefined) ?? 'dashboard',
          action: 'webhook.replay',
          subject: entry.repoFullName ?? entry.event,
          meta: {
            originalDelivery: deliveryId,
            replayDelivery: replayDeliveryId,
            event: entry.event,
            action: entry.action,
            dispatchStatus: result.statusCode ?? 200,
          },
        },
        { logger: req.log },
      );

      if (result.statusCode) reply.code(result.statusCode);
      return {
        ok: true,
        replayDelivery: replayDeliveryId,
        originalDelivery: deliveryId,
        event: entry.event,
        action: entry.action,
        dispatched: result.body,
      };
    },
  );
}
