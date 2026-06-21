import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '@clawreview/db';

import { dispatchWebhook } from './webhooks.js';
import { getWebhookStore } from '../services/webhook-store.js';
import { getDeliveryCache } from '../services/delivery-cache.js';
import { getMetrics, observeWebhookStatsWindowAnchor } from '@clawreview/telemetry';

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

/**
 * Parse the `?payloadFields=` query parameter into an allowlist of
 * keys for `WebhookStore.list({ payloadFields })`. Each entry may be
 * a plain top-level key (`action`) OR a dotted path
 * (`pull_request.title`); see the store's `payloadFields` doc for
 * the path semantics, depth cap, and merge behaviour.
 *
 * Accepts:
 *   - Comma-separated string ("action,pull_request.title,sender.login")
 *     -- the common form when a dashboard hand-builds the URL.
 *   - Repeated query keys (Fastify hands those as `string[]`).
 *   - undefined / non-string / non-array -> `undefined` (no projection,
 *     route falls back to the metadata-only shape).
 *
 * Empty / pure-whitespace names are dropped. An explicit empty string
 * (`?payloadFields=`) returns an empty array, which the store treats
 * as "explicit opt-out: ship without payload" (distinct from
 * undefined). Capped at 32 names so a runaway query string can't
 * blow up the per-entry copy cost.
 *
 * Dot characters are NOT a query delimiter -- the splitter only
 * recognises `,` -- so a path like `pull_request.title` survives the
 * parser intact and reaches the store, which interprets it.
 */
function parsePayloadFieldsQuery(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  let parts: string[];
  if (typeof raw === 'string') {
    // Comma-separated form: a literal empty value -> empty array
    // (explicit opt-out), not undefined.
    parts = raw.length === 0 ? [] : raw.split(',');
  } else if (Array.isArray(raw)) {
    // Fastify hands repeated query keys as arrays. Flatten + split
    // each in case the caller mixes the two forms.
    parts = (raw as unknown[]).flatMap((v) =>
      typeof v === 'string' ? v.split(',') : [],
    );
  } else {
    return undefined;
  }
  const out: string[] = [];
  for (const p of parts) {
    const name = p.trim();
    if (name.length === 0) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= 32) break;
  }
  return out;
}

export async function registerWebhookReplayRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/internal/webhook/recent',
    { preHandler: [app.requireRole('readonly')] },
    async (req) => {
      const q = (req.query ?? {}) as {
        limit?: unknown;
        event?: unknown;
        sinceMs?: unknown;
        since?: unknown;
        repo?: unknown;
        repoFullName?: unknown;
        after?: unknown;
        payloadFields?: unknown;
      };
      const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
      const event = typeof q.event === 'string' && q.event.length > 0 ? q.event : undefined;
      const repoFullName =
        typeof q.repoFullName === 'string'
          ? q.repoFullName
          : typeof q.repo === 'string'
            ? q.repo
            : undefined;
      // Accept either `?sinceMs=<unix-ms>` or `?since=<ISO-8601>`. The ISO
      // form is friendlier when an operator is poking at it from a
      // browser; the ms form is friendlier from code.
      let sinceMs: number | undefined;
      const sinceMsRaw = q.sinceMs;
      const sinceRaw = q.since;
      if (typeof sinceMsRaw === 'string' || typeof sinceMsRaw === 'number') {
        const n = Number(sinceMsRaw);
        if (Number.isFinite(n) && n >= 0) sinceMs = n;
      } else if (typeof sinceRaw === 'string' && sinceRaw.length > 0) {
        const n = Date.parse(sinceRaw);
        if (Number.isFinite(n)) sinceMs = n;
      }
      // `after=<deliveryId>` lets a polling client walk the store one
      // page at a time without re-reading deliveries it has already
      // processed. See WebhookListOptions.after for the semantics.
      const after = typeof q.after === 'string' && q.after.length > 0 ? q.after : undefined;
      // `payloadFields` is a comma-separated allowlist of keys to
      // keep from each entry's payload. Each entry may be a plain
      // top-level key (`action`) OR a dotted path
      // (`pull_request.title`). Without `payloadFields` the route
      // returns the existing slim metadata-only shape (back-compat).
      // With `payloadFields` set, the requested fields are surfaced
      // as `payload` on each entry so a dashboard widget can render
      // both top-level metadata AND a nested PR title without paying
      // for the full 50KB payload tree per row.
      const payloadFields = parsePayloadFieldsQuery(q.payloadFields);
      const entries = getWebhookStore()
        .list({
          limit,
          event,
          sinceMs,
          repoFullName,
          after,
          ...(payloadFields ? { payloadFields } : {}),
        })
        .map((e) => {
          // When the caller asked for a payload projection we surface
          // the slim `payload` alongside the metadata; otherwise we
          // keep the existing metadata-only shape exactly as tick 5/6
          // shipped it.
          const base = {
            deliveryId: e.deliveryId,
            event: e.event,
            action: e.action,
            receivedAt: e.receivedAt,
            repoFullName: e.repoFullName,
            installationId: e.installationId,
          };
          if (payloadFields) {
            return { ...base, payload: e.payload };
          }
          return base;
        });
      // Return a nextCursor when the page filled completely, so the
      // caller can paginate without inspecting `limit`. A null cursor
      // means "no more pages": either fewer entries than `limit`, or
      // the store is exhausted past the last returned id.
      const nextCursor =
        entries.length === limit && entries.length > 0
          ? entries[entries.length - 1]!.deliveryId
          : null;
      return {
        requestId: req.id,
        size: getWebhookStore().size(),
        limit,
        appliedFilters: { event, sinceMs, repoFullName, after, payloadFields },
        nextCursor,
        entries,
      };
    },
  );

  app.get(
    '/api/internal/webhook/stats',
    { preHandler: [app.requireRole('readonly')] },
    async (req) => {
      const q = (req.query ?? {}) as {
        event?: unknown;
        repo?: unknown;
        repoFullName?: unknown;
        sinceMs?: unknown;
        since?: unknown;
        granularity?: unknown;
        buckets?: unknown;
        hourBuckets?: unknown;
        hours?: unknown;
        topRepos?: unknown;
        bucketWindow?: unknown;
        bucketWindowAt?: unknown;
      };
      const event = typeof q.event === 'string' && q.event.length > 0 ? q.event : undefined;
      const repoFullName =
        typeof q.repoFullName === 'string'
          ? q.repoFullName
          : typeof q.repo === 'string'
            ? q.repo
            : undefined;
      let sinceMs: number | undefined;
      const sinceMsRaw = q.sinceMs;
      const sinceRaw = q.since;
      if (typeof sinceMsRaw === 'string' || typeof sinceMsRaw === 'number') {
        const n = Number(sinceMsRaw);
        if (Number.isFinite(n) && n >= 0) sinceMs = n;
      } else if (typeof sinceRaw === 'string' && sinceRaw.length > 0) {
        const n = Date.parse(sinceRaw);
        if (Number.isFinite(n)) sinceMs = n;
      }
      // Granularity: only the three documented values are accepted.
      // Anything else (typo, omitted) falls back to `hour` so the
      // endpoint stays backwards-compatible with tick 6.
      const granRaw = typeof q.granularity === 'string' ? q.granularity : undefined;
      const granularity: 'minute' | 'hour' | 'day' | undefined =
        granRaw === 'minute' || granRaw === 'hour' || granRaw === 'day' ? granRaw : undefined;
      // `buckets` is the modern knob; `hourBuckets` / `hours` are the
      // legacy hour-only aliases. Per-granularity caps apply inside the
      // store; we just clamp into a sane absolute range here so a wildly
      // out-of-range value never reaches the cap logic.
      const bucketsRaw = q.buckets ?? q.hourBuckets ?? q.hours;
      const buckets =
        bucketsRaw === undefined ? undefined : Math.max(1, Math.min(240, Number(bucketsRaw) || 24));
      // `topRepos` clamps to the same range the store enforces; the
      // store re-clamps so a malformed value never escapes the
      // dashboard-render budget.
      const topReposRaw = q.topRepos;
      const topRepos =
        topReposRaw === undefined
          ? undefined
          : Math.max(1, Math.min(200, Number(topReposRaw) || 50));
      // `bucketWindow` (unix ms) / `bucketWindowAt` (ISO-8601) overrides
      // the "from now, walking back" sparkline anchor with a specific
      // end-time. Useful for reproducible postmortem snapshots:
      // `?bucketWindow=1718987400000&granularity=minute&buckets=120`
      // renders the two hours leading up to that incident even if the
      // dashboard is opened days later. Both forms accept the same
      // value range; the ISO form is friendlier from a browser, the
      // numeric form is friendlier from code.
      let bucketWindowMs: number | undefined;
      const bucketWindowRaw = q.bucketWindow;
      const bucketWindowAtRaw = q.bucketWindowAt;
      if (typeof bucketWindowRaw === 'string' || typeof bucketWindowRaw === 'number') {
        const n = Number(bucketWindowRaw);
        // Reject negative / non-finite values; a stale snapshot at
        // "epoch-but-mistyped-as-negative" would render an empty
        // sparkline (no buckets within range of the data) and surprise
        // the operator. Better to fall back to "now" silently.
        if (Number.isFinite(n) && n >= 0) bucketWindowMs = n;
      } else if (typeof bucketWindowAtRaw === 'string' && bucketWindowAtRaw.length > 0) {
        const n = Date.parse(bucketWindowAtRaw);
        if (Number.isFinite(n)) bucketWindowMs = n;
      }
      const stats = getWebhookStore().stats({
        event,
        repoFullName,
        sinceMs,
        granularity,
        buckets,
        topRepos,
        ...(bucketWindowMs !== undefined ? { nowMs: bucketWindowMs } : {}),
      });
      // Tick 13: record the sparkline anchor mode on a dedicated counter
      // (`clawreview_webhook_stats_window_anchor_total{mode}`) so an
      // on-call can graph live vs snapshot reads in Prometheus. Same
      // predicate the appliedFilters.bucketWindow echo uses, so the
      // counter and the response shape can never drift.
      observeWebhookStatsWindowAnchor(
        getMetrics({ service: 'clawreview-server' }),
        bucketWindowMs ?? null,
      );
      return {
        requestId: req.id,
        size: getWebhookStore().size(),
        appliedFilters: {
          event,
          sinceMs,
          repoFullName,
          granularity: granularity ?? 'hour',
          buckets: buckets ?? (granularity === 'minute' ? 60 : granularity === 'day' ? 14 : 24),
          topRepos: topRepos ?? 50,
          // Echo the override so the operator can verify the snapshot
          // was anchored to the requested time. `null` when the
          // sparkline walked back from the live clock (default).
          bucketWindow: bucketWindowMs ?? null,
        },
        ...stats,
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
