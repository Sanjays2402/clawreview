import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  aggregate,
  computeDigestDrift,
  findingDigest,
  toSarif,
  toJUnitXml,
  toCsv,
  renderReviewReport,
} from '@clawreview/aggregator';
import { getMetrics, observeReviewDigestDrift } from '@clawreview/telemetry';

import { getReviewStore } from '../services/review-store.js';

const ListQuerySchema = z.object({
  installation: z.coerce.number().int().positive().optional(),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export async function registerReviewsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/reviews', { preHandler: app.requireRole('readonly') }, async (req, reply) => {
    const store = getReviewStore();
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadQuery', issues: parsed.error.flatten() };
    }
    const { installation, ...rest } = parsed.data;
    const result = await store.list({ installationId: installation, ...rest });
    return {
      items: result.items.map(toReviewListDto),
      nextCursor: result.nextCursor,
    };
  });

  app.get('/api/reviews/:id', { preHandler: app.requireRole('readonly') }, async (req, reply) => {
    const store = getReviewStore();
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const rec = await store.get(params.data.id);
    if (!rec) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    return toReviewDetailDto(rec);
  });

  /**
   * GET /api/reviews/:id/digest
   *
   * Lightweight drift DTO returning `{ persisted, fresh, drift }` so the
   * dashboard's "review header counts are stale, refresh comment?"
   * banner can answer the question with a single round-trip instead of
   * pulling every finding through /api/reviews/:id and recomputing in
   * the browser.
   *
   * `persisted` echoes the worker-written digest verbatim (null on a
   * legacy review that pre-dates tick 12). `fresh` is a recompute over
   * the current `findings` array using the same top-N caps the worker
   * used (8/8), so a dashboard that already cached the persisted
   * top-files / top-agents slices can compare identical shapes
   * directly. `drift` is the tick-13 `computeDigestDrift(persisted,
   * fresh)` report; when `persisted` is null we synthesise an empty
   * persisted digest so drift surfaces as "every fresh bucket is a
   * positive delta" (matches the existing empty-persisted contract
   * pinned in packages/aggregator/tests/digest.test.ts).
   *
   * Fires `clawreview_review_digest_drift_total{kind}` once per accepted
   * call so Prom can graph the stale-rate across all reviews. The
   * closed `['fresh', 'stale']` label set guards against typo drift.
   *
   * Auth: readonly (same as /api/reviews/:id; this is a derived view).
   */
  app.get('/api/reviews/:id/digest', { preHandler: app.requireRole('readonly') }, async (req, reply) => {
    const store = getReviewStore();
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    // Tick 15: `?recompute=fresh|cached` toggle. The default behaviour
    // recomputes the digest on every request (matches tick 14's
    // contract). `cached` skips the recompute and returns ONLY the
    // persisted digest -- useful when a dashboard already pulled the
    // full /api/reviews/:id body and just wants the persisted shape
    // without a second tree walk over `findings`.
    //
    // Shape per mode:
    //   - fresh   (default): { persisted, fresh, drift }  -- existing tick-14 shape
    //   - cached            : { persisted, fresh: null, drift: null, recompute: 'cached' }
    //
    // The `recompute` echo lets a consumer detect at runtime which path
    // the server took (the route may treat unknown values as the
    // default; the echo confirms it). When `cached` is requested AND
    // the review has no persisted digest (legacy), the response carries
    // `persisted: null` (matches the default path) so the dashboard's
    // "legacy review" branch doesn't need a separate code path for
    // cached mode.
    //
    // Telemetry: the read-side drift counter only fires on the `fresh`
    // path. A cached read is intentionally an observability no-op (it
    // did not actually check for drift), so counting it would corrupt
    // the read-side stale rate. The `recompute` label could be added
    // later if a "how often does a dashboard request the cached path?"
    // signal becomes useful.
    //
    // Tick 16: `?slim=true` projection knob STRIPS the full sparse
    // bucket maps (byTag, byCategory, byAgent, byFile) from the
    // persisted + fresh digests on the wire. The top-N slices
    // (topTags, topCategories, topAgents, topFiles) plus totals
    // (total, totalsBySeverity) survive so a dashboard rendering ONLY
    // the ranked breakdowns can drop a large chunk of payload on
    // tag-heavy reviews (a corpus with 200 distinct tags previously
    // serialised 200 entries in `byTag` -- slim mode ships just the
    // top-10 slice).
    //
    // The drift report's per-bucket deltas (byTagDelta etc.) are NOT
    // stripped on slim mode -- they're already sparse (only changed
    // keys appear) and a dashboard rendering drift wants to know
    // which keys changed even if it doesn't render the full bucket
    // counts. The drift summary (totalDelta + bySeverityDelta +
    // hasDrift) is always preserved.
    //
    // Composes with cached: `?recompute=cached&slim=true` returns the
    // slimmed persisted with fresh + drift null (the cached mode's
    // existing shape, minus the full sparse maps).
    const queryParse = z
      .object({
        recompute: z.enum(['fresh', 'cached']).optional(),
        slim: z
          .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
          .optional(),
      })
      .safeParse(req.query ?? {});
    if (!queryParse.success) {
      reply.code(400);
      return { error: 'BadQuery', issues: queryParse.error.flatten() };
    }
    const recomputeMode = queryParse.data.recompute ?? 'fresh';
    const slim =
      queryParse.data.slim === 'true' || queryParse.data.slim === '1';
    const rec = await store.get(params.data.id);
    if (!rec) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    if (recomputeMode === 'cached') {
      // Pure read of the persisted shape. No fresh recompute, no drift
      // calculation, no counter fire. The response shape mirrors the
      // fresh path with `fresh` + `drift` nulled so consumers can use
      // one schema regardless of mode.
      return {
        reviewId: rec.id,
        persisted: rec.digest ? (slim ? slimDigest(rec.digest) : rec.digest) : null,
        fresh: null,
        drift: null,
        recompute: 'cached' as const,
        // Echo the slim mode so a consumer can verify the projection
        // was applied. `false` when slim was not passed -- consumers
        // that don't care can ignore the field.
        slim,
      };
    }
    // Match the worker's tick-12 / tick-13 cap choices so a dashboard
    // can compare persisted.topAgents / topCategories slices directly
    // against fresh.topAgents / topCategories without re-slicing. The
    // dashboard hotspot panel reads the persisted hotspots verbatim;
    // refreshing them here would mask a tag-rule change between the
    // worker and the recompute, so the fresh hotspots are intentionally
    // included for parity.
    const fresh = findingDigest(rec.findings, {
      topCategories: 8,
      topAgents: 8,
      hotspots: true,
    });
    // Tolerate a legacy review (pre-tick-12) that never persisted a
    // digest. `computeDigestDrift` requires both sides; we synthesise
    // an empty persisted-shape so the drift surfaces as "every fresh
    // bucket is a positive delta", matching the empty-persisted
    // contract the aggregator test suite already pins.
    const persisted = rec.digest ?? findingDigest([], { hotspots: false });
    const drift = computeDigestDrift(persisted, fresh);
    // Fire the drift counter on the way out so an on-call sees the
    // stale-rate ratio across all /digest reads. The closed kind set
    // means cardinality is bounded at two regardless of traffic.
    observeReviewDigestDrift(
      getMetrics({ service: 'clawreview-server' }),
      drift,
    );
    return {
      reviewId: rec.id,
      // Echo `null` (not the synthesised empty) when the review had no
      // persisted digest, so the dashboard can render a "legacy
      // review, no persisted snapshot" hint instead of a misleading
      // "every bucket dropped to zero" banner.
      persisted: rec.digest ? (slim ? slimDigest(rec.digest) : rec.digest) : null,
      fresh: slim ? slimDigest(fresh) : fresh,
      drift,
      // Echo the resolved mode so a consumer can verify which path the
      // server took. Always 'fresh' on this branch.
      recompute: 'fresh' as const,
      // Tick 16: echo the slim mode too so a consumer can confirm the
      // projection. `false` when slim was not passed (back-compat).
      slim,
    };
  });

  app.get('/api/reviews/:id/report.md', { preHandler: app.requireRole('readonly') }, async (req, reply) => {
    const store = getReviewStore();
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const query = z
      .object({
        includeDismissed: z
          .union([z.literal('true'), z.literal('false')])
          .optional(),
        includeSuggestedPatches: z
          .union([z.literal('true'), z.literal('false')])
          .optional(),
      })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const rec = await store.get(params.data.id);
    if (!rec) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    const md = renderReviewReport(
      {
        reviewId: rec.id,
        owner: rec.owner,
        repo: rec.repo,
        prNumber: rec.prNumber,
        headSha: rec.headSha,
        baseSha: rec.baseSha,
        status: rec.status,
        createdAt: rec.createdAt,
        completedAt: rec.completedAt,
        durationMs: rec.durationMs,
        totalCostUsd: rec.totalCostUsd,
        agentExecutions: rec.agentExecutions.map((ex) => ({
          agent: ex.agent,
          status: ex.status,
          durationMs: ex.durationMs,
          findings: ex.findings.length,
          error: ex.error,
        })),
      },
      rec.findings,
      {
        includeDismissed: query.data.includeDismissed === 'true',
        includeSuggestedPatches: query.data.includeSuggestedPatches !== 'false',
      },
    );
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header(
      'content-disposition',
      `attachment; filename="clawreview-${rec.owner}-${rec.repo}-${rec.prNumber}.md"`,
    );
    return md;
  });

  app.get('/api/reviews/:id/sarif', { preHandler: app.requireRole('readonly') }, async (req, reply) => {
    const store = getReviewStore();
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const rec = await store.get(params.data.id);
    if (!rec) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    // Use only open findings in the SARIF export so dismissed findings
    // don't keep failing downstream code-scanning gates after a human
    // explicitly accepted them.
    const open = rec.findings.filter((f) => f.state === 'open');
    const aggregated = aggregate(open, { threshold: 'nit' });
    const log = toSarif(aggregated, {
      commitSha: rec.headSha,
      repositoryUri: `https://github.com/${rec.owner}/${rec.repo}`,
    });
    reply.header('content-type', 'application/sarif+json');
    reply.header(
      'content-disposition',
      `attachment; filename="clawreview-${rec.owner}-${rec.repo}-${rec.prNumber}.sarif.json"`,
    );
    return log;
  });

  app.get('/api/reviews/:id/junit.xml', { preHandler: app.requireRole('readonly') }, async (req, reply) => {
    const store = getReviewStore();
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const rec = await store.get(params.data.id);
    if (!rec) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    const open = rec.findings.filter((f) => f.state === 'open');
    const xml = toJUnitXml(open, {
      suiteName: `clawreview/${rec.owner}/${rec.repo}#${rec.prNumber}`,
      timestamp: rec.completedAt ?? rec.createdAt,
    });
    reply.header('content-type', 'application/xml; charset=utf-8');
    reply.header(
      'content-disposition',
      `attachment; filename="clawreview-${rec.owner}-${rec.repo}-${rec.prNumber}.junit.xml"`,
    );
    return xml;
  });

  app.get('/api/reviews/:id/findings.csv', { preHandler: app.requireRole('readonly') }, async (req, reply) => {
    const store = getReviewStore();
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const query = z
      .object({
        includeDismissed: z
          .union([z.literal('true'), z.literal('false')])
          .optional(),
      })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const rec = await store.get(params.data.id);
    if (!rec) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    const includeDismissed = query.data.includeDismissed === 'true';
    const rows = includeDismissed
      ? rec.findings
      : rec.findings.filter((f) => f.state === 'open');
    const csv = toCsv(rows);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header(
      'content-disposition',
      `attachment; filename="clawreview-${rec.owner}-${rec.repo}-${rec.prNumber}.csv"`,
    );
    return csv;
  });

  const FindingActionSchema = z.object({
    action: z.enum(['dismiss', 'reopen']),
    reason: z.string().max(280).optional(),
  });

  const BulkFindingSchema = z.object({
    action: z.enum(['dismiss', 'reopen']),
    reason: z.string().max(280).optional(),
    filter: z
      .object({
        severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'nit'])).optional(),
        categories: z.array(z.string().min(1).max(64)).optional(),
        agents: z.array(z.string().min(1).max(64)).optional(),
        files: z.array(z.string().min(1).max(512)).optional(),
      })
      .default({}),
  });

  app.post('/api/reviews/:id/findings/bulk', { preHandler: app.requireRole('operator') }, async (req, reply) => {
    const store = getReviewStore();
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const body = BulkFindingSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      reply.code(400);
      return { error: 'BadInput', issues: body.success ? undefined : body.error.flatten() };
    }
    const result = await store.bulkFindingAction(
      params.data.id,
      body.data.action,
      body.data.filter,
      body.data.reason,
    );
    if (!result) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    return { ok: true, ...result };
  });

  app.post('/api/findings/:id', { preHandler: app.requireRole('operator') }, async (req, reply) => {
    const store = getReviewStore();
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const body = FindingActionSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      reply.code(400);
      return { error: 'BadInput' };
    }
    const updated = await store.findingAction(params.data.id, body.data.action, body.data.reason);
    if (!updated) {
      reply.code(404);
      return { error: 'NotFound' };
    }
    return { ok: true, finding: { id: updated.id, state: updated.state } };
  });
}

function toReviewListDto(r: Awaited<ReturnType<ReturnType<typeof getReviewStore>['get']>> & object) {
  return {
    id: r.id,
    installationId: r.installationId,
    owner: r.owner,
    repo: r.repo,
    prNumber: r.prNumber,
    headSha: r.headSha,
    status: r.status,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    durationMs: r.durationMs,
    totalFindings: r.totalFindings,
    openFindings: r.findings.filter((f) => f.state === 'open').length,
    totalCostUsd: r.totalCostUsd,
  };
}

function toReviewDetailDto(r: Awaited<ReturnType<ReturnType<typeof getReviewStore>['get']>> & object) {
  return {
    ...toReviewListDto(r),
    baseSha: r.baseSha,
    error: r.error,
    commentId: r.commentId,
    checkRunId: r.checkRunId,
    agentExecutions: r.agentExecutions.map((ex) => ({
      agent: ex.agent,
      status: ex.status,
      durationMs: ex.durationMs,
      findings: ex.findings.length,
      error: ex.error,
    })),
    findings: r.findings,
    // Worker-persisted findingDigest. Surfaced verbatim so the dashboard
    // detail page can render the same totalsBySeverity / byCategory /
    // byAgent / topFiles / topAgents / topCategories the PR comment
    // header showed, without re-walking `findings`. `null` (rather
    // than omitted) when a legacy review has no persisted digest so a
    // dashboard's "has counts?" check is just `digest !== null`
    // instead of `digest !== undefined && digest !== null`.
    digest: r.digest ?? null,
  };
}

/**
 * Strip the full sparse bucket maps from a `FindingDigest` for the
 * tick-16 `?slim=true` projection on `/api/reviews/:id/digest`.
 *
 * Removed (heavy):
 *   - byCategory      -- can be hundreds of entries on tag-heavy reviews
 *   - byAgent         -- one entry per agent; small but redundant with topAgents
 *   - byFile          -- one entry per file touched; the heaviest field
 *   - byTag           -- one entry per distinct tag; second-heaviest
 *
 * Preserved (light + dashboard-useful):
 *   - total                                                       (single number)
 *   - totalsBySeverity                                            (5 keys, fixed)
 *   - topFiles / topAgents / topCategories / topTags              (capped slices)
 *   - hotspots                                                    (already capped)
 *
 * The rationale: a dashboard rendering "top breakdowns + drift" only
 * needs the ranked slices, never the full bucket maps. The full maps
 * are still available via `?slim=false` (default) for any consumer
 * that actually walks them (e.g. an export tool dumping every tag
 * bucket to CSV).
 *
 * The function returns a NEW object so the persisted digest is never
 * mutated -- consumers that hold a reference to `rec.digest` still
 * see the full shape.
 *
 * Pure; exported via the route file's barrel so the test suite can
 * pin the contract without injecting a fake digest through Fastify.
 */
export function slimDigest<T extends { total: number; totalsBySeverity: unknown }>(digest: T): {
  total: T['total'];
  totalsBySeverity: T['totalsBySeverity'];
  topFiles?: unknown;
  topAgents?: unknown;
  topCategories?: unknown;
  topTags?: unknown;
  hotspots?: unknown;
} {
  // Cast through unknown so the helper accepts any FindingDigest-like
  // shape (it only reads the documented fields; legacy digests
  // missing topTags / hotspots are tolerated).
  const d = digest as unknown as Record<string, unknown>;
  const slim: Record<string, unknown> = {
    total: d.total,
    totalsBySeverity: d.totalsBySeverity,
  };
  // Top-N slices: include when present so a legacy digest (missing
  // topTags) doesn't get a synthetic empty array.
  if (d.topFiles !== undefined) slim.topFiles = d.topFiles;
  if (d.topAgents !== undefined) slim.topAgents = d.topAgents;
  if (d.topCategories !== undefined) slim.topCategories = d.topCategories;
  if (d.topTags !== undefined) slim.topTags = d.topTags;
  if (d.hotspots !== undefined) slim.hotspots = d.hotspots;
  return slim as ReturnType<typeof slimDigest<T>>;
}
