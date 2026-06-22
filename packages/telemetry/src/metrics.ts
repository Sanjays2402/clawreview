import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type LabelValues,
} from 'prom-client';

export interface MetricsBundle {
  registry: Registry;
  httpRequestsTotal: Counter<string>;
  httpRequestDurationSeconds: Histogram<string>;
  webhookEventsTotal: Counter<string>;
  reviewsStartedTotal: Counter<string>;
  reviewsCompletedTotal: Counter<string>;
  reviewDurationSeconds: Histogram<string>;
  reviewFindingsTotal: Counter<string>;
  llmCostUsdTotal: Counter<string>;
  /**
   * Per-agent execution latency in seconds, labeled by agent name and
   * by outcome ('ok', 'error', or 'skipped'). Use rate() on this to
   * spot a single slow agent in a sea of healthy pipeline runs without
   * having to scrape per-review timing out of the worker logs.
   *
   * The buckets are tuned for typical single-agent runs: most agents
   * complete in 1-15s against a Claude/Hermes endpoint, with the long
   * tail dominated by retries against rate-limited providers.
   */
  agentDurationSeconds: Histogram<string>;
  /**
   * Total agent invocations completed, labeled by agent and outcome.
   * Combined with agentDurationSeconds_sum this gives per-agent average
   * latency, and on its own it captures the per-agent error rate via
   * the `outcome="error"` series.
   */
  agentInvocationsTotal: Counter<string>;
  /** Total findings emitted by an agent before dedup/threshold pruning. */
  agentFindingsTotal: Counter<string>;
  /**
   * Total cross-agent similarity merges performed by the aggregator's
   * similarity pass, labeled by `winner_agent` and `loser_agent`. Use
   * this to track which agent pairs duplicate most often -- the most
   * common pair is usually the next prompt-merge candidate.
   *
   * The label set is bounded by the number of agents in AGENT_REGISTRY
   * (currently <20) so cardinality stays well under Prometheus's
   * recommended ceiling.
   */
  similarityMergesTotal: Counter<string>;
  /**
   * Findings attributed to a given author by the aggregator's blame
   * pass, labeled by `author` (sanitized: lower-cased, hostile chars
   * stripped, capped at 80 chars). Pairs with the Top Contributors PR
   * block so dashboards can graph which authors get flagged most often
   * without re-running blame in a separate pipeline.
   *
   * Cardinality is bounded in practice by the contributor list of any
   * given installation; very large monorepos still tend to have well
   * under 1k distinct blame authors per month. The sanitizer prevents
   * a malformed `git config user.name` from blowing up cardinality with
   * whitespace or newline noise.
   */
  authorsAttributedTotal: Counter<string>;
  /**
   * Inbound webhook deliveries counted at receive time, labeled by
   * `event` (e.g. `pull_request`, `push`, `installation`) and `repo`
   * (`owner/name`, lower-cased; `(none)` when the payload carried no
   * `repository.full_name`). Bumped once per accepted delivery on the
   * receiver's `put()` path -- pairs with the `/api/internal/webhook/
   * stats` endpoint's `byEvent` / `byRepo` shape so Prometheus and the
   * dashboard observe the same numbers from the same source of truth.
   *
   * Cardinality: bounded by the (event * repo) cross-product. The
   * receiver sanitises `repo` to a lower-cased `owner/name` slug capped
   * at 100 chars, with hostile characters stripped, so a misconfigured
   * GitHub payload can't blow up the cardinality budget. Operators
   * with thousands of repos can drop `repo` at scrape time via a
   * Prometheus relabel rule (see the runbook) without losing the
   * per-event series.
   *
   * Distinct from `webhookEventsTotal{event,action,result}`: this
   * counter is INGRESS-side (one increment per accepted delivery; no
   * action / result labels) so Prom can graph raw inbound volume even
   * when the dispatch path short-circuits before tagging a result.
   */
  webhookDeliveriesTotal: Counter<string>;
  /**
   * Operator-poll rate-limit class traffic, labeled by `probe` (the
   * sanitised `?probe=name` annotation, `(none)` when unset) and
   * `result` (`ok`, `bypass`, `throttled`).
   *
   * Pairs with the tick-10 `?probe=name` operator-poll annotation
   * and the tick-9 `?force=1` bypass: a dashboard widget tags its
   * polling traffic with a probe name and the limiter emits one
   * increment per request. Prom queries like
   * `rate(clawreview_operator_poll_total{result="throttled"}[5m]) by (probe)`
   * point straight at the noisiest widget; `rate(...{result="bypass"})`
   * graphs how many in-band health probes are bypassing the bucket.
   *
   * Cardinality: bounded by the number of named dashboard widgets x
   * three result values. The probe sanitiser caps each label value at
   * 64 chars with a strict `[a-z0-9._-]` allowlist, so a hostile or
   * typo'd value lands under `unknown` rather than fragmenting the
   * series. A request without `?probe=` lands under `(none)` so the
   * bucket is visible.
   *
   * Distinct from the default `http_requests_total{route,status_code}`
   * series because the operator-poll class wants to slice by probe,
   * not by route -- a single widget can poll both /recent and /stats
   * but the operator wants to attribute the load to the WIDGET.
   */
  operatorPollTotal: Counter<string>;
  /**
   * Operator-poll bypass attribution, labeled by `probe` (the same
   * sanitised `?probe=name` value as `operatorPollTotal`) and `reason`
   * (the closed set `OPERATOR_POLL_BYPASS_REASONS`).
   *
   * This is the WHY view of `operatorPollTotal{result="bypass"}`:
   * the volume counter answers "how many bypasses happened?" and
   * supports a `rate(...) by (probe)` query for noisy widgets; this
   * counter answers "what authorised each bypass?" so a security
   * audit can distinguish dashboard health-probe (`reason="force"`,
   * via `?force=1`) from future authorised paths (internal-network
   * shortcut, signed hash-tag bypass, etc.) without re-tagging the
   * volume metric. Operators can graph
   * `rate(clawreview_operator_poll_bypass_total[1h]) by (reason)` to
   * spot drift in the bypass surface.
   *
   * Cardinality: bounded by `(probe x reason)`. The probe label
   * inherits the route layer's strict `[a-z0-9._-]` allowlist + 64-
   * char cap, and `reason` is a closed `OPERATOR_POLL_BYPASS_REASONS`
   * union so a typo'd reason can never silently fragment the series.
   *
   * Bypass also bumps `operatorPollTotal{result="bypass"}` so an
   * operator can reconcile the two on the volume axis.
   */
  operatorPollBypassTotal: Counter<string>;
  /**
   * Webhook-stats sparkline anchor traffic, labeled by `mode`:
   *
   *   - `live`     -- the dashboard polled `/api/internal/webhook/stats`
   *                   without `?bucketWindow=` / `?bucketWindowAt=`;
   *                   the sparkline walked back from the live clock.
   *   - `snapshot` -- the dashboard pinned the sparkline to a specific
   *                   end-time (postmortem mode); the response is
   *                   reproducible regardless of when the dashboard
   *                   was opened.
   *
   * Pairs with the tick-12 `?bucketWindow=<ms>` / `?bucketWindowAt=<ISO>`
   * anchor override on `/api/internal/webhook/stats`. The volume of
   * snapshot reads vs live reads tells an on-call WHICH dashboard
   * views are pinned to incident snapshots and WHEN -- e.g. a Grafana
   * alert can fire "30% of dashboard reads are snapshot-pinned in the
   * last hour, expect stale numbers" when a major incident kicks in.
   *
   * Cardinality: exactly two label values (`live` | `snapshot`). The
   * closed `WEBHOOK_STATS_WINDOW_MODES` constant guards against a typo
   * silently fragmenting the series. Anonymous bucket is unnecessary
   * because the mode is always derivable from the request shape.
   *
   * Distinct from `clawreview_webhook_deliveries_total` (ingress
   * volume) and `clawreview_operator_poll_total{probe=stats-*}`
   * (rate-limit class traffic): this counter records `/stats` reads
   * only, sliced by the snapshot-vs-live distinction the new anchor
   * override introduced, so a security-sensitive snapshot read can
   * be tracked separately from the live polling background load.
   */
  webhookStatsWindowAnchorTotal: Counter<string>;
  /**
   * Findings removed from the post-aggregation output before the PR
   * comment is rendered, labeled by `reason`:
   *
   *   - `severity_rule`     -- a `severity_rules` entry with `drop: true`
   *                            removed it.
   *   - `min_confidence`    -- the global `min_confidence` floor (tick 6)
   *                            dropped it during aggregation.
   *   - `inline_suppression` -- a `clawreview-ignore` / `-ignore-next-line`
   *                            marker in the diff hid it.
   *
   * The label set is closed today (three reasons) so cardinality stays
   * fixed regardless of repo or installation count. Operators can graph
   * `rate(clawreview_findings_dropped_total[5m]) by (reason)` by reason to spot a
   * misconfigured rule that started dropping everything.
   */
  findingsDroppedTotal: Counter<string>;
  /**
   * Review digest drift outcomes, labeled by `kind`:
   *
   *   - `fresh` -- the persisted digest still agreed with a fresh
   *                recompute (no bulk-dismiss / -reopen since the
   *                worker wrote the comment).
   *   - `stale` -- at least one bucket disagreed; the dashboard's
   *                "review header counts are stale, refresh comment?"
   *                banner should trigger.
   *
   * Fires once per `/api/reviews/:id/digest` recompute on the server.
   * The closed `['fresh', 'stale']` set guards against a typo silently
   * fragmenting the series. Pairs with tick 13's `computeDigestDrift`
   * helper + tick 12's persisted-digest hand-off so an operator can
   * answer:
   *
   *   - "what fraction of dashboard digest reads are stale right now?"
   *     -> rate(clawreview_review_digest_drift_total{kind="stale"}[5m])
   *        / rate(clawreview_review_digest_drift_total[5m])
   *   - "are stale rates climbing after a bulk-dismiss spree?"
   *     -> increase(...{kind="stale"}[1h])
   *
   * Cardinality: exactly two label values (`fresh` | `stale`). The
   * fixed shape means a runaway dashboard widget hammering the
   * `/digest` endpoint cannot blow up the series budget.
   *
   * Distinct from `findingsDroppedTotal{reason}`: this counter is a
   * READ-side observability signal (was the persisted snapshot still
   * accurate?), not a write-side one (how many findings were dropped
   * during the run?).
   */
  reviewDigestDriftTotal: Counter<string>;
  queueDepth: Gauge<string>;
  queueInflight: Gauge<string>;
}

let bundle: MetricsBundle | undefined;

export interface MetricsInit {
  service: string;
  defaultMetrics?: boolean;
}

/**
 * Build (once) and return the process-wide Prometheus metrics bundle.
 * Re-invocation returns the cached bundle and ignores `init` so multiple
 * Fastify instances in the same process share one registry.
 */
export function getMetrics(init: MetricsInit = { service: 'clawreview' }): MetricsBundle {
  if (bundle) return bundle;

  const registry = new Registry();
  registry.setDefaultLabels({ service: init.service });

  if (init.defaultMetrics !== false) {
    collectDefaultMetrics({ register: registry });
  }

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests handled, labeled by method, normalized route and status code.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  const httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const webhookEventsTotal = new Counter({
    name: 'clawreview_webhook_events_total',
    help: 'Inbound GitHub webhook events received, labeled by event and action.',
    labelNames: ['event', 'action', 'result'],
    registers: [registry],
  });

  const reviewsStartedTotal = new Counter({
    name: 'clawreview_reviews_started_total',
    help: 'Reviews enqueued for processing.',
    labelNames: ['source'],
    registers: [registry],
  });

  const reviewsCompletedTotal = new Counter({
    name: 'clawreview_reviews_completed_total',
    help: 'Reviews finished, labeled by outcome.',
    labelNames: ['outcome'],
    registers: [registry],
  });

  const reviewDurationSeconds = new Histogram({
    name: 'clawreview_review_duration_seconds',
    help: 'End-to-end duration of a review job from worker pickup to completion.',
    labelNames: ['outcome'],
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800],
    registers: [registry],
  });

  const reviewFindingsTotal = new Counter({
    name: 'clawreview_review_findings_total',
    help: 'Findings emitted by completed reviews, labeled by severity.',
    labelNames: ['severity'],
    registers: [registry],
  });

  const llmCostUsdTotal = new Counter({
    name: 'clawreview_llm_cost_usd_total',
    help: 'Cumulative LLM spend in USD attributed to completed reviews.',
    labelNames: ['outcome'],
    registers: [registry],
  });

  const agentDurationSeconds = new Histogram({
    name: 'clawreview_agent_duration_seconds',
    help: 'Per-agent execution latency in seconds, labeled by agent name and outcome.',
    labelNames: ['agent', 'outcome'],
    // Tuned for OpenAI-compatible LLM calls; the slowest bucket captures
    // worst-case retries against rate-limited providers.
    buckets: [0.25, 0.5, 1, 2.5, 5, 10, 20, 45, 90, 180],
    registers: [registry],
  });

  const agentInvocationsTotal = new Counter({
    name: 'clawreview_agent_invocations_total',
    help: 'Total agent invocations across all reviews, labeled by agent and outcome.',
    labelNames: ['agent', 'outcome'],
    registers: [registry],
  });

  const agentFindingsTotal = new Counter({
    name: 'clawreview_agent_findings_total',
    help: 'Total findings emitted by an agent before dedup/threshold pruning.',
    labelNames: ['agent'],
    registers: [registry],
  });

  const similarityMergesTotal = new Counter({
    name: 'clawreview_similarity_merges_total',
    help: 'Cross-agent similarity merges, labeled by winning and losing agent.',
    labelNames: ['winner_agent', 'loser_agent'],
    registers: [registry],
  });

  const authorsAttributedTotal = new Counter({
    name: 'clawreview_authors_attributed_total',
    help: 'Findings attributed to an author by the aggregator blame pass, labeled by sanitized author key.',
    labelNames: ['author'],
    registers: [registry],
  });

  const webhookDeliveriesTotal = new Counter({
    name: 'clawreview_webhook_deliveries_total',
    help: 'Inbound GitHub webhook deliveries counted at receive time, labeled by event and sanitized repo full name.',
    labelNames: ['event', 'repo'],
    registers: [registry],
  });

  const operatorPollTotal = new Counter({
    name: 'clawreview_operator_poll_total',
    help:
      'Operator-poll rate-limit class traffic, labeled by probe ' +
      '(?probe=name annotation; (none) when unset) and result (ok | bypass | throttled).',
    labelNames: ['probe', 'result'],
    registers: [registry],
  });

  const operatorPollBypassTotal = new Counter({
    name: 'clawreview_operator_poll_bypass_total',
    help:
      'Operator-poll bypass attribution, labeled by probe ' +
      '(?probe=name annotation; (none) when unset) and reason ' +
      '(closed set: force). Reconciles against ' +
      'operator_poll_total{result="bypass"} on the volume axis.',
    labelNames: ['probe', 'reason'],
    registers: [registry],
  });

  const webhookStatsWindowAnchorTotal = new Counter({
    name: 'clawreview_webhook_stats_window_anchor_total',
    help:
      'Webhook-stats sparkline anchor traffic, labeled by mode ' +
      '(live | snapshot). live = no anchor override (default); ' +
      'snapshot = ?bucketWindow= / ?bucketWindowAt= override applied. ' +
      'Pairs with the tick-12 anchor override so on-calls can see ' +
      'how many dashboard reads are pinned to incident snapshots.',
    labelNames: ['mode'],
    registers: [registry],
  });

  const findingsDroppedTotal = new Counter({
    name: 'clawreview_findings_dropped_total',
    help: 'Findings dropped after aggregation, labeled by reason (severity_rule | min_confidence | inline_suppression).',
    labelNames: ['reason'],
    registers: [registry],
  });

  const reviewDigestDriftTotal = new Counter({
    name: 'clawreview_review_digest_drift_total',
    help:
      'Review digest drift outcomes on the server /api/reviews/:id/digest ' +
      'recompute path, labeled by kind (closed set: fresh | stale). ' +
      'fresh = persisted digest agreed with a fresh recompute; ' +
      'stale = at least one bucket disagreed (dashboard should flag).',
    labelNames: ['kind'],
    registers: [registry],
  });

  const queueProbes = new Map<string, () => Promise<{ pending?: number; inflight?: number } | undefined>>();

  const queueDepth = new Gauge({
    name: 'clawreview_queue_depth',
    help: 'Pending review jobs waiting in the queue (sampled at scrape time when a collector is registered).',
    labelNames: ['queue'],
    registers: [registry],
    async collect() {
      for (const [queue, probe] of queueProbes) {
        try {
          const snap = await probe();
          if (snap && typeof snap.pending === 'number') {
            this.set({ queue }, snap.pending);
          }
        } catch {
          // Probe failed; leave previous sample in place.
        }
      }
    },
  });

  const queueInflight = new Gauge({
    name: 'clawreview_queue_inflight',
    help: 'Review jobs currently being processed (sampled at scrape time when a collector is registered).',
    labelNames: ['queue'],
    registers: [registry],
    async collect() {
      for (const [queue, probe] of queueProbes) {
        try {
          const snap = await probe();
          if (snap && typeof snap.inflight === 'number') {
            this.set({ queue }, snap.inflight);
          }
        } catch {
          // Probe failed; leave previous sample in place.
        }
      }
    },
  });

  bundle = {
    registry,
    httpRequestsTotal,
    httpRequestDurationSeconds,
    webhookEventsTotal,
    reviewsStartedTotal,
    reviewsCompletedTotal,
    reviewDurationSeconds,
    reviewFindingsTotal,
    llmCostUsdTotal,
    agentDurationSeconds,
    agentInvocationsTotal,
    agentFindingsTotal,
    similarityMergesTotal,
    authorsAttributedTotal,
    webhookDeliveriesTotal,
    operatorPollTotal,
    operatorPollBypassTotal,
    webhookStatsWindowAnchorTotal,
    findingsDroppedTotal,
    reviewDigestDriftTotal,
    queueDepth,
    queueInflight,
  };
  queueProbesByBundle.set(bundle, queueProbes);
  return bundle;
}

// Per-bundle map of queueName -> probe so multiple queues can be sampled
// at scrape time without clobbering each other's gauge collect hook.
const queueProbesByBundle = new WeakMap<
  MetricsBundle,
  Map<string, () => Promise<{ pending?: number; inflight?: number } | undefined>>
>();

/**
 * Register a pull-time collector that refreshes queueDepth + queueInflight
 * on every Prometheus scrape by calling the supplied probe. The probe
 * should be cheap (it runs on each /metrics request). Failures inside the
 * probe are swallowed so /metrics never 500s because of a transient queue
 * backend hiccup. Returns a disposer that detaches the collector.
 */
export function registerQueueDepthCollector(
  metrics: MetricsBundle,
  queueName: string,
  probe: () => Promise<{ pending?: number; inflight?: number } | undefined>,
): () => void {
  const probes = queueProbesByBundle.get(metrics);
  if (!probes) {
    throw new Error('metrics bundle is not registered for queue probes');
  }
  probes.set(queueName, probe);
  return () => {
    probes.delete(queueName);
  };
}

/** Reset the cached bundle. Tests only. */
export function resetMetricsForTests(): void {
  if (bundle) {
    bundle.registry.clear();
  }
  bundle = undefined;
}

export function observeHttp(
  metrics: MetricsBundle,
  labels: LabelValues<string>,
  durationSeconds: number,
): void {
  metrics.httpRequestsTotal.inc(labels);
  metrics.httpRequestDurationSeconds.observe(labels, durationSeconds);
}

/**
 * Shape compatible with `ReviewSummary.agentExecutions` so the worker
 * can hand the same array used for logging directly to the metrics
 * recorder without converting it first. Kept structural (not a typed
 * import) so the telemetry package stays free of a dependency on
 * `@clawreview/types`.
 */
export interface AgentExecutionLike {
  agent: string;
  status: 'ok' | 'error' | 'skipped';
  durationMs: number;
  findings: { length: number } | number;
  error?: string;
}

/**
 * Record per-agent metrics for an entire review's worth of executions.
 * Writes to three series so dashboards can answer:
 *   - which agent is slow?           agent_duration_seconds (histogram)
 *   - which agent is erroring?       agent_invocations_total{outcome}
 *   - which agent is most prolific?  agent_findings_total
 *
 * Safe to call with an empty array (no-op). The duration histogram is
 * skipped for skipped invocations because they did no real work.
 */
export function observeAgentExecutions(
  metrics: MetricsBundle,
  executions: readonly AgentExecutionLike[],
): void {
  for (const e of executions) {
    const labels = { agent: e.agent, outcome: e.status };
    metrics.agentInvocationsTotal.inc(labels);
    if (e.status !== 'skipped') {
      metrics.agentDurationSeconds.observe(labels, e.durationMs / 1000);
    }
    const findingsCount =
      typeof e.findings === 'number' ? e.findings : e.findings.length;
    if (findingsCount > 0) {
      metrics.agentFindingsTotal.inc({ agent: e.agent }, findingsCount);
    }
  }
}

/**
 * Shape compatible with `SimilarityMergeResult.merged[number]` so the
 * worker can hand the same array used for logging directly to the
 * metrics recorder. Kept structural so telemetry stays free of an
 * `@clawreview/aggregator` dependency.
 */
export interface SimilarityMergeLike {
  /** Winning agent — the one whose finding survived the merge. */
  winner: string;
  /**
   * Losing agents — the ones whose findings were collapsed. Almost
   * always a single-element array today, but modeled as a list because
   * the aggregator's contract allows N-way merges.
   */
  losers: readonly string[];
}

/**
 * Record per-pair similarity-merge counters. One increment fires per
 * (winner, loser) pair so an N-way merge fans out into N-1 counter
 * increments. Safe to call with an empty array (no-op).
 */
export function observeSimilarityMerges(
  metrics: MetricsBundle,
  merges: readonly SimilarityMergeLike[],
): void {
  for (const m of merges) {
    for (const loser of m.losers) {
      metrics.similarityMergesTotal.inc({
        winner_agent: m.winner,
        loser_agent: loser,
      });
    }
  }
}

/**
 * Shape compatible with the aggregator's `AuthorAttribution` so the
 * worker can hand the same breakdown used for the PR comment to this
 * recorder. Kept structural so telemetry stays free of an
 * `@clawreview/aggregator` dependency.
 */
export interface AuthorAttributionLike {
  authorName: string;
  authorEmail: string;
  /** Pre-computed total; an undefined value falls back to the array length. */
  total?: number;
  findings?: { length: number };
}

/**
 * Sanitize a blame author into a Prometheus-safe label value:
 *
 *   - Prefer the email (deterministic, ASCII, low cardinality) if present.
 *   - Fall back to the name, lower-cased.
 *   - Strip whitespace, control characters, and surrounding angle brackets.
 *   - Cap at 80 chars so a long `mailto:` header can't run the cardinality
 *     budget into the ground.
 *
 * Exported so the worker can sanitize once and reuse the key for logging
 * + counter increments.
 */
export function sanitizeAuthorLabel(name: string, email: string): string {
  const base = email && email.trim().length > 0 ? email : name;
  const cleaned = base
    .toLowerCase()
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, '-')
    .trim();
  if (cleaned.length === 0) return 'unknown';
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

/**
 * Record per-author attribution counters. One increment per attributed
 * finding so the counter rolls up to "findings flagged on lines this
 * author last touched". Safe to call with an empty array (no-op).
 *
 * Authors whose name+email both sanitize to `'unknown'` are still
 * recorded under the `unknown` label so dashboards can show the size of
 * the no-blame bucket explicitly rather than silently dropping it.
 */
export function observeAuthorAttribution(
  metrics: MetricsBundle,
  authors: readonly AuthorAttributionLike[],
): void {
  for (const a of authors) {
    const total = typeof a.total === 'number' ? a.total : a.findings?.length ?? 0;
    if (total <= 0) continue;
    const label = sanitizeAuthorLabel(a.authorName, a.authorEmail);
    metrics.authorsAttributedTotal.inc({ author: label }, total);
  }
}

/**
 * Closed set of reasons a finding can be dropped post-aggregation.
 * Exported so the worker / CLI cannot accidentally introduce a typo
 * that would silently fork the counter into two label values.
 */
export const FINDING_DROP_REASONS = [
  'severity_rule',
  'min_confidence',
  'inline_suppression',
] as const;
export type FindingDropReason = (typeof FINDING_DROP_REASONS)[number];

/**
 * Bump the `clawreview_findings_dropped_total{reason}` counter by `count`
 * (defaults to 1) for the given reason. Safe with `count <= 0` (no-op)
 * so callers don't have to guard on the empty case.
 *
 * The reason set is closed by the FindingDropReason type so a misnamed
 * label literally cannot reach Prometheus -- if a new drop source
 * appears, add it to FINDING_DROP_REASONS first.
 */
export function observeFindingsDropped(
  metrics: MetricsBundle,
  reason: FindingDropReason,
  count = 1,
): void {
  if (!Number.isFinite(count) || count <= 0) return;
  metrics.findingsDroppedTotal.inc({ reason }, count);
}

/**
 * Sanitize a GitHub repo full name into a Prometheus-safe label value:
 *
 *   - Lower-cased so `Org/Repo` and `org/repo` collapse to one series
 *     (label values are case-sensitive and Prometheus would otherwise
 *     double-count the same logical repo).
 *   - Stripped of control characters, whitespace, and quote characters
 *     so a malformed payload from a misconfigured installation cannot
 *     inject label-syntax noise.
 *   - Capped at 100 chars so a long fork chain (`a/b/c/d/...`) can't
 *     run the cardinality budget into the ground via the label value
 *     length.
 *   - `(none)` for the empty / missing case so the bucket is still
 *     surfaced explicitly rather than silently dropped at scrape time.
 *
 * Exported so callers (the webhook receiver today, anything that wants
 * to graph by-repo in the future) sanitise once and reuse the same key.
 */
export function sanitizeRepoLabel(repoFullName: string | undefined | null): string {
  if (typeof repoFullName !== 'string') return '(none)';
  const cleaned = repoFullName
    .toLowerCase()
    .replace(/[\u0000-\u001f"'`\s]/g, '')
    .trim();
  if (cleaned.length === 0) return '(none)';
  return cleaned.length > 100 ? cleaned.slice(0, 100) : cleaned;
}

/**
 * Record an inbound webhook delivery on the receiver's `put()` path.
 * Bumps `clawreview_webhook_deliveries_total{event,repo}` once per
 * accepted delivery so Prometheus and the dashboard's
 * `/api/internal/webhook/stats` byEvent/byRepo agree on the same
 * numbers from the same source of truth.
 *
 * Signature is intentionally narrow (event + repoFullName) rather than
 * accepting the full WebhookEntry shape so this helper has zero
 * dependency on `apps/server` types. Callers that want to wire the
 * counter from elsewhere (e.g. a future Redis-backed receiver) just
 * pass the two strings.
 *
 * Safe to call with an unset `repoFullName`: the helper sanitises into
 * `(none)` so the metric series still fires and the bucket is visible
 * in dashboards (e.g. `installation` events that carry no repo).
 */
export function observeWebhookDelivery(
  metrics: MetricsBundle,
  event: string,
  repoFullName: string | undefined | null,
): void {
  if (typeof event !== 'string' || event.length === 0) return;
  const repo = sanitizeRepoLabel(repoFullName);
  metrics.webhookDeliveriesTotal.inc({ event, repo });
}

/**
 * Closed set of outcomes the operator-poll rate-limit class can record
 * against a request:
 *
 *   - `ok`        -- request landed in the bucket and was accepted.
 *   - `bypass`    -- `?force=1` bypass; request did not draw down the
 *                    bucket (still observed by the default per-token
 *                    limiter further down the chain).
 *   - `throttled` -- bucket exhausted; the limiter returned 429.
 *
 * Exported so callers cannot drift via a typo; a typo'd literal would
 * silently fork the counter into a new label value and inflate
 * cardinality.
 */
export const OPERATOR_POLL_RESULTS = ['ok', 'bypass', 'throttled'] as const;
export type OperatorPollResult = (typeof OPERATOR_POLL_RESULTS)[number];

/**
 * Sanitise a caller-supplied probe name (already extracted from the
 * `?probe=` query parameter by the route layer) into a Prometheus-safe
 * label value.
 *
 *   - `null` / `undefined` / `''` collapse to `(none)` so the bucket
 *     is still surfaced explicitly rather than dropped at scrape time.
 *   - The route layer (operatorPollProbeParam) already applies the
 *     strict `[a-z0-9._-]` allowlist and the 64-char cap; this helper
 *     just normalises the absent case so the metric layer stays
 *     ignorant of the route's parsing quirks.
 *   - As a defensive belt-and-braces, anything ELSE that isn't a
 *     string collapses to `(none)` too. The metric helper is the only
 *     write site, so a single guard here means a misuse (e.g. a number
 *     accidentally typed as the probe label) can never reach the
 *     registry.
 */
export function sanitizeOperatorPollProbe(probe: string | null | undefined): string {
  if (typeof probe !== 'string') return '(none)';
  const trimmed = probe.trim();
  if (trimmed.length === 0) return '(none)';
  return trimmed;
}

/**
 * Record one operator-poll class request on the
 * `clawreview_operator_poll_total{probe,result}` counter.
 *
 * Safe to call from a hot Fastify hook: a single counter increment
 * with two short label values per request is negligible vs. the
 * sliding-window bucket walk the limiter already runs. The route
 * layer hands us the already-sanitised probe (or null) so we never
 * re-walk the URL.
 *
 * Pairs with:
 *   - The tick-10 `?probe=name` annotation: probes get attributed
 *     to their named widget.
 *   - The tick-9 `?force=1` bypass: bypass requests are counted as
 *     `result=bypass` so a dashboard can tell genuine throttled
 *     polling from in-band health probes.
 *   - The tick-8 operator-poll class: throttled requests are counted
 *     as `result=throttled` so Prom can graph rate(...{result="throttled"})
 *     to see when a dashboard widget overran its budget.
 */
export function observeOperatorPoll(
  metrics: MetricsBundle,
  probe: string | null | undefined,
  result: OperatorPollResult,
): void {
  const probeLabel = sanitizeOperatorPollProbe(probe);
  metrics.operatorPollTotal.inc({ probe: probeLabel, result });
}

/**
 * Closed set of authorised reasons the operator-poll rate-limit class
 * can record against a `?force=1`-style bypass:
 *
 *   - `force` -- the request carried `?force=1` (or `?force=true` /
 *                `?force=yes`); the dashboard's in-band health probe
 *                explicitly asked the limiter to skip the bucket.
 *
 * Future tickets can extend this list with additional authorised paths
 * (internal-network shortcut, signed hash-tag bypass, etc.) but a
 * change to the list is intentionally a code change so a security
 * review can spot a new bypass surface in a PR diff. Today the only
 * authorised bypass is the dashboard probe.
 *
 * Exported so callers cannot drift via a typo'd literal; a typo'd
 * reason would silently fragment the counter series across two label
 * values that both look correct in code review (`force` vs `frce`).
 */
export const OPERATOR_POLL_BYPASS_REASONS = ['force'] as const;
export type OperatorPollBypassReason = (typeof OPERATOR_POLL_BYPASS_REASONS)[number];

/**
 * Record one operator-poll bypass on the
 * `clawreview_operator_poll_bypass_total{probe,reason}` counter.
 *
 * This is the WHY view of `operatorPollTotal{result="bypass"}`:
 * the volume counter answers "how many bypasses happened?" and
 * supports `rate(...) by (probe)` for noisy widgets; this counter
 * answers "what authorised each bypass?" so a security review can
 * graph `rate(clawreview_operator_poll_bypass_total[1h]) by (reason)`
 * to spot drift in the bypass surface.
 *
 * The rate-limit hook calls BOTH `observeOperatorPoll(..., 'bypass')`
 * (volume) AND `observeOperatorPollBypass(..., 'force')` (attribution)
 * on the same request so an operator can reconcile the two on the
 * volume axis (the two counters must always agree per-probe on the
 * total-by-bypass count).
 *
 * Cheap to call from a hot Fastify hook: a single counter increment
 * with two short label values per bypass. Bypasses are RARE compared
 * to the volume path (dashboards bypass for health probes only) so
 * this counter sees far less traffic than `operatorPollTotal`.
 */
export function observeOperatorPollBypass(
  metrics: MetricsBundle,
  probe: string | null | undefined,
  reason: OperatorPollBypassReason,
): void {
  const probeLabel = sanitizeOperatorPollProbe(probe);
  metrics.operatorPollBypassTotal.inc({ probe: probeLabel, reason });
}

/**
 * Closed set of modes the webhook-stats sparkline anchor can record:
 *
 *   - `live`     -- no `?bucketWindow=` / `?bucketWindowAt=` was
 *                   supplied; the sparkline walked back from the live
 *                   clock (the default behaviour).
 *   - `snapshot` -- the request pinned the sparkline to a specific
 *                   end-time (postmortem mode); the response is
 *                   reproducible regardless of when the dashboard
 *                   was opened.
 *
 * Exported as a `const` literal so callers cannot drift via a typo;
 * a typo'd literal would silently fragment the counter series across
 * two label values that both look correct in code review
 * (`snapshot` vs `snapsht`).
 */
export const WEBHOOK_STATS_WINDOW_MODES = ['live', 'snapshot'] as const;
export type WebhookStatsWindowMode = (typeof WEBHOOK_STATS_WINDOW_MODES)[number];

/**
 * Derive the closed-set mode from a caller-supplied bucketWindowMs.
 * Exported pure so the rate-limit layer / route layer can consume
 * the same predicate the counter helper would, avoiding the
 * accidental drift between "what counter fired" and "what the
 * appliedFilters echo claimed".
 *
 *   - `undefined` / `null` -> `live`     (no anchor override)
 *   - any finite number     -> `snapshot` (anchor applied)
 *
 * Non-finite numbers (`NaN`, `Infinity`) collapse to `live` because
 * the route layer rejects them up-front and silently falls back to
 * the live clock, so the counter must mirror that contract.
 */
export function deriveWebhookStatsWindowMode(
  bucketWindowMs: number | null | undefined,
): WebhookStatsWindowMode {
  if (typeof bucketWindowMs !== 'number') return 'live';
  if (!Number.isFinite(bucketWindowMs)) return 'live';
  return 'snapshot';
}

/**
 * Record one `/api/internal/webhook/stats` read on the
 * `clawreview_webhook_stats_window_anchor_total{mode}` counter.
 *
 * Fired once per accepted /stats request from the route handler.
 * The mode is derived from the caller-supplied bucketWindowMs via
 * `deriveWebhookStatsWindowMode` so the counter cannot drift from
 * the route's appliedFilters echo: same predicate, two consumers.
 *
 * Why a dedicated counter (not just label `operatorPollTotal` with
 * an extra dimension):
 *   - `operatorPollTotal{probe,result}` already exists and is
 *     keyed by probe + result; adding a `mode` label would multiply
 *     the cardinality of the entire operator-poll metric.
 *   - The snapshot/live distinction is `/stats`-specific (the
 *     `/recent` endpoint has no anchor override) so a separate
 *     counter keeps the labelset honest and the per-endpoint
 *     attribution clear.
 *
 * Cheap to call from a hot Fastify hook: a single counter increment
 * with one short label value per request. Bounded cardinality (two
 * label values, ever).
 */
export function observeWebhookStatsWindowAnchor(
  metrics: MetricsBundle,
  bucketWindowMs: number | null | undefined,
): void {
  const mode = deriveWebhookStatsWindowMode(bucketWindowMs);
  metrics.webhookStatsWindowAnchorTotal.inc({ mode });
}

/**
 * Closed set of `kind` values the review-digest-drift counter can record:
 *
 *   - `fresh` -- the persisted digest still agreed with a fresh recompute.
 *   - `stale` -- at least one bucket disagreed (drift detected); the
 *                dashboard should flag the review header as stale.
 *
 * Exported as a `const` literal so callers cannot drift via a typo;
 * a typo'd literal would silently fragment the counter series across
 * two label values that both look correct in code review.
 */
export const REVIEW_DIGEST_DRIFT_KINDS = ['fresh', 'stale'] as const;
export type ReviewDigestDriftKind = (typeof REVIEW_DIGEST_DRIFT_KINDS)[number];

/**
 * Derive the closed-set kind from a `FindingDigestDrift`-shaped report.
 *
 * Accepts a structural shape so this helper can stay free of an
 * `@clawreview/aggregator` dependency in telemetry. Only one bit
 * matters: `hasDrift` flips `stale` vs `fresh`.
 *
 * Pure / exported so a unit test (and the route layer's appliedFilters
 * echo) can call it without instantiating a metrics bundle.
 */
export function deriveReviewDigestDriftKind(
  drift: { hasDrift: boolean },
): ReviewDigestDriftKind {
  return drift.hasDrift ? 'stale' : 'fresh';
}

/**
 * Record one `/api/reviews/:id/digest` recompute on the
 * `clawreview_review_digest_drift_total{kind}` counter.
 *
 * Fired once per accepted `/digest` request from the route handler
 * (or once per CLI `clawreview review drift` invocation that hits a
 * server, if that surface gains a counter). The kind is derived from
 * the supplied drift report via `deriveReviewDigestDriftKind` so the
 * counter cannot drift from the response shape: same predicate, two
 * consumers.
 *
 * Cheap to call: a single counter increment with one short label per
 * request. Bounded cardinality (two label values, ever).
 *
 * The closed `REVIEW_DIGEST_DRIFT_KINDS` set guards against the
 * route layer accidentally bumping a typo'd label.
 */
export function observeReviewDigestDrift(
  metrics: MetricsBundle,
  drift: { hasDrift: boolean },
): void {
  const kind = deriveReviewDigestDriftKind(drift);
  metrics.reviewDigestDriftTotal.inc({ kind });
}
