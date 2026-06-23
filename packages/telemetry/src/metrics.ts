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
  /**
   * `clawreview_review_digest_persisted_drift_total{kind}` -- WRITE-side
   * counterpart to `reviewDigestDriftTotal`. Fires once per worker
   * completion (re-run, rerun-from-dashboard, scheduled re-process)
   * when the worker compares the digest it just built against the
   * previously-persisted digest for the same review.
   *
   * Where the read-side counter answers "was the snapshot the
   * dashboard cached still accurate?", this counter answers "did the
   * re-run produce different bucket counts than the prior run?".
   * Together they form a complete observability picture:
   *
   *   - drift on READ but not on WRITE
   *       -> dashboards are caching stale data; reads outpace writes
   *   - drift on WRITE but not on READ
   *       -> worker re-runs flip counts, but operators rerun rarely
   *          enough that dashboards don't notice
   *   - drift on BOTH                                 (the common case)
   *   - drift on NEITHER                              (steady state)
   *
   * Closed `kind` set:
   *   - `fresh`         -- no prior persisted digest existed (first
   *                        run; legacy review pre-tick-12); no
   *                        comparison was possible. Counted so the
   *                        rate vs `stale` is meaningful for the
   *                        denominator.
   *   - `unchanged`     -- prior persisted digest existed AND the
   *                        re-run produced byte-identical bucket
   *                        counts. Steady-state path.
   *   - `stale`         -- prior persisted digest existed AND the
   *                        re-run produced at least one bucket delta.
   *                        The dashboard's "review header changed
   *                        since last run" surface would fire here.
   *
   * Three buckets (vs the read-side's two) because the worker has the
   * "no prior digest" case which the route layer can't see (it's
   * tolerated as legacy and synthesised to an empty digest there).
   *
   * Cardinality: exactly three label values (`fresh` | `unchanged` |
   * `stale`). Bounded for the same reason as `reviewDigestDriftTotal`.
   */
  reviewDigestPersistedDriftTotal: Counter<string>;
  /**
   * `clawreview_review_drift_watch_polls_total{result}` -- per-poll
   * outcome counter for the CLI `review drift --watch` loop.
   *
   * Fires once per HTTP fetch attempt against /api/reviews/:id/digest
   * inside the watch loop, so an operator instrumenting their watch
   * pipeline (e.g. piping it into Prometheus / a sidecar metric
   * scraper) can answer:
   *
   *   - "how many polls have I made?"  (sum across all results)
   *   - "how often is the digest stale?"  (`result="drift"` rate)
   *   - "how often is my server flaking?"  (`result="error"` rate)
   *
   * Pairs with the READ-side `reviewDigestDriftTotal` (which observes
   * the server's view of each /digest read) -- if the two diverge,
   * the CLI is seeing different drift than the server is firing,
   * which usually indicates one of them is mis-configured.
   *
   * Closed `result` set:
   *   - `ok`     -- HTTP fetch succeeded, drift.hasDrift was false.
   *                 The persisted digest still agreed with the fresh
   *                 recompute.
   *   - `drift`  -- HTTP fetch succeeded, drift.hasDrift was true.
   *                 The watch banner reported drift; an --on-drift
   *                 hook (if configured) fired.
   *   - `error`  -- HTTP fetch failed OR the body could not be
   *                 parsed. The watch loop aborts the iteration and
   *                 exits 2; this counter captures the cause.
   *
   * The counter is exposed via a CLI registry seam: the watch loop
   * accepts an injected metrics bundle (defaulting to no-op when
   * absent) so unit tests can assert the fire pattern without
   * spinning up a real Prometheus registry, and production users
   * who want the data can wire a real bundle through.
   *
   * Cardinality: exactly three label values. Bounded.
   */
  reviewDriftWatchPollsTotal: Counter<string>;
  /**
   * Tick 21: `clawreview_review_digest_filter_applied_total{min_confidence,severity_threshold}`
   * -- how often does each /api/reviews/:id/digest fresh recompute
   * actually apply a pre-bucket filter?
   *
   * Fired once per accepted /digest fresh call (the cached arm does
   * not fire -- the persisted digest carries no filter metadata, so
   * counting cached reads would distort the "what fraction of
   * dashboards filter?" ratio).
   *
   * Two labels:
   *   - `min_confidence`     -- 'yes' | 'no'. 'yes' when the
   *                             normalised threshold > 0, i.e. the
   *                             filter is not the back-compat no-op.
   *   - `severity_threshold` -- 'yes' | 'no'. 'yes' when the
   *                             normalised threshold is a valid
   *                             Severity literal, not null.
   *
   * Cross-product cardinality is exactly 4 (yes/yes, yes/no, no/yes,
   * no/no) so this counter cannot blow up the cardinality budget.
   *
   * Pairs with tick 20's `?minConfidence` / `?severityThreshold`
   * query knobs and tick 21's `findingDigestWithFilterReport` helper:
   * the helper computes the `applied` bit, the counter records it.
   * Dashboards can graph e.g.
   *   rate(clawreview_review_digest_filter_applied_total{min_confidence="yes"}[5m])
   * / rate(clawreview_review_digest_filter_applied_total[5m])
   * to see what fraction of /digest reads filter by confidence over
   * any time window.
   */
  reviewDigestFilterAppliedTotal: Counter<string>;
  /**
   * Tick 22: `clawreview_findings_filter_pre_applied_total{phase,applied}`
   * -- worker-side counter that fires when the worker BUILDS the
   * persisted digest. Captures whether the pre-bucket filter was
   * active at each of two phases of the worker pipeline:
   *
   *   - `aggregate`    -- the filter that runs INSIDE aggregate()
   *                       (cfg.min_confidence + cfg.severity_threshold
   *                       fed to aggregate's `minConfidence` /
   *                       `threshold` opts; pre-dedupe / pre-rank).
   *   - `worker_post`  -- the filter that runs in the worker's
   *                       findingDigestWithFilterReport pass AFTER
   *                       aggregate(). Defence-in-depth on the
   *                       happy path; reflects the contract of the
   *                       persisted digest.
   *
   * The `applied` axis is a closed `yes`/`no` set just like the
   * tick-21 read-side counter. Cross-product cardinality is bounded
   * at 4 (two phases x two yes/no values).
   *
   * Pairs with tick 21's read-side
   * `clawreview_review_digest_filter_applied_total`: read-side is
   * "how often did a dashboard fresh-recompute apply a filter?";
   * this write-side is "how often did the worker build a filtered
   * snapshot?". A dashboard that subtracts the two rates gets a
   * "filter coverage drift" signal (writes per minute that filter
   * vs reads per minute that filter, by axis).
   */
  findingsFilterPreAppliedTotal: Counter<string>;
  /**
   * Tick 23: `clawreview_review_filter_report_reads_total{shape}`
   * -- how often does each /api/reviews/:id/filter-report read
   * land on the full vs slim response shape?
   *
   * Fired once per accepted read (200 status; 404 reads do NOT fire
   * because they didn't actually consume the persisted filter report).
   *
   * Single label, closed two-value set:
   *   - `full` -- the response carried the verbose appliedFilters
   *                object (default `?slim=false` / absent).
   *   - `slim` -- the response stripped appliedFilters and carried
   *                only the single `applied: boolean` (`?slim=true|1|yes`).
   *
   * Cardinality is bounded at 2. Pairs with the tick-23 standalone
   * endpoint: a dashboard can graph
   *   rate(clawreview_review_filter_report_reads_total{shape="slim"}[5m])
   * / rate(clawreview_review_filter_report_reads_total[5m])
   * to see "what fraction of filter-report consumers opt into the
   * slim projection?" -- useful for sizing future projection knobs.
   *
   * Use case: when most consumers use slim, the dashboard team has
   * data to consider making slim the default (or vice versa). The
   * NotFound / NoFilterReport 404 arms are deliberately excluded
   * from the counter: counting them would inflate the read rate
   * with traffic that didn't actually touch the persisted shape.
   */
  reviewFilterReportReadsTotal: Counter<string>;
  /**
   * Tick 24: `clawreview_review_filter_report_read_duration_seconds{shape}`
   * -- per-shape latency histogram for /api/reviews/:id/filter-report.
   *
   * Pairs with the tick-23 `reviewFilterReportReadsTotal` counter: the
   * counter answers "how often did each shape fire?", the histogram
   * answers "and how long did each shape take?". Together they let a
   * dashboard quantify the slim-vs-full tradeoff: if slim reads are
   * consistently 3x faster than full, the projection knob is worth
   * surfacing more aggressively in the UI; if they're indistinguishable,
   * the projection isn't earning its keep and can be deprecated.
   *
   * Single label (`shape`), closed two-value set ('full' | 'slim') --
   * identical to the counter so the two series can be joined in PromQL
   * without re-labelling. Cardinality bounded at 2.
   *
   * Buckets are tuned for in-process file-store reads (sub-millisecond
   * happy path; tail dominated by GC pauses on very large reviews).
   * The slowest bucket (1s) catches pathological cases where the
   * review store has spilled to disk or a sibling lock contention is
   * starving the read. Same fire-discipline as the counter: 200 reads
   * only; 404 arms (NotFound, NoFilterReport) deliberately excluded
   * because they didn't actually consume the persisted shape.
   */
  reviewFilterReportReadDurationSeconds: Histogram<string>;
  /**
   * Tick 25: `clawreview_review_filter_report_diff_total{result}` --
   * per-invocation outcome for the CLI `review filter-report --diff`
   * two-review compare. Closed result set:
   *
   *   - `'identical'` -- both bodies fetched, computeFilterReportDelta
   *                      returned hasDelta=false. CLI exit 0.
   *   - `'delta'`     -- both bodies fetched, hasDelta=true. CLI exit 3.
   *   - `'error'`     -- config error / fetch failure / shape rejection.
   *                      CLI exit 2.
   *
   * Use case: a fleet of CI runners each invoking `review filter-report
   * --diff` to gate on filter-shape drift between two builds wants a
   * single observability surface (rather than parsing N exit codes).
   * The closed-set discriminator lets a dashboard slice the rate of
   * each outcome over time without sampling stdout.
   *
   * Cardinality bounded at 3 (the entire closed set).
   *
   * Distinct from `reviewDriftWatchPollsTotal` because the diff
   * command's outcome semantics are different from the watch loop's:
   * the watch fires once PER POLL, diff fires once PER INVOCATION.
   * Pairing them in PromQL gives a fuller picture of CI filter-shape
   * health: watch covers the live signal, diff covers the gated signal.
   */
  reviewFilterReportDiffTotal: Counter<string>;
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

  const reviewDigestPersistedDriftTotal = new Counter({
    name: 'clawreview_review_digest_persisted_drift_total',
    help:
      'Write-side review digest drift outcomes on the worker completion ' +
      'path, labeled by kind (closed set: fresh | unchanged | stale). ' +
      'fresh = no prior persisted digest (first run / legacy review); ' +
      'unchanged = the re-run produced byte-identical bucket counts; ' +
      'stale = at least one bucket changed between the prior and the ' +
      're-run. Pairs with clawreview_review_digest_drift_total (the ' +
      'read-side equivalent) to give a complete observability picture: ' +
      'reads = "did the dashboard see stale data?", writes = "did the ' +
      're-run change anything?".',
    labelNames: ['kind'],
    registers: [registry],
  });

  const reviewDriftWatchPollsTotal = new Counter({
    name: 'clawreview_review_drift_watch_polls_total',
    help:
      'Per-poll outcome for the CLI review drift --watch loop, labeled ' +
      'by result (closed set: ok | drift | error). ok = HTTP fetch ' +
      "succeeded and drift.hasDrift was false; drift = HTTP fetch " +
      'succeeded and drift.hasDrift was true (banner reported drift, ' +
      '--on-drift hook fired if configured); error = HTTP fetch failed ' +
      'or body could not be parsed. Fires once per fetch attempt. Pair ' +
      'with the server-side clawreview_review_digest_drift_total to ' +
      'detect divergence between the CLI and server views of drift.',
    labelNames: ['result'],
    registers: [registry],
  });

  const reviewDigestFilterAppliedTotal = new Counter({
    name: 'clawreview_review_digest_filter_applied_total',
    help:
      'Tick 21: did each /api/reviews/:id/digest fresh recompute apply ' +
      'a pre-bucket filter? Labels min_confidence and severity_threshold ' +
      'are both closed yes|no sets, so the cross-product is exactly 4. ' +
      'Cached arm does NOT fire (persisted digest carries no filter ' +
      'metadata). Pairs with tick 20 ?minConfidence / ?severityThreshold ' +
      'query knobs and tick 21 findingDigestWithFilterReport helper.',
    labelNames: ['min_confidence', 'severity_threshold'],
    registers: [registry],
  });

  const findingsFilterPreAppliedTotal = new Counter({
    name: 'clawreview_findings_filter_pre_applied_total',
    help:
      'Tick 22: worker-side filter coverage. Fires twice per completed ' +
      'review (once per phase: aggregate, worker_post). The applied axis ' +
      'is a closed yes|no set; cross-product cardinality is 4. Pairs ' +
      'with the read-side clawreview_review_digest_filter_applied_total ' +
      'to surface "writes that filter" vs "reads that filter" drift.',
    labelNames: ['phase', 'applied'],
    registers: [registry],
  });

  const reviewFilterReportReadsTotal = new Counter({
    name: 'clawreview_review_filter_report_reads_total',
    help:
      'Tick 23: /api/reviews/:id/filter-report reads, labelled by the ' +
      'projection shape returned (full | slim). Fires once per 200; ' +
      '404 arms (NotFound, NoFilterReport) do NOT fire because they ' +
      'did not actually consume the persisted shape. Cardinality 2.',
    labelNames: ['shape'],
    registers: [registry],
  });

  const reviewFilterReportReadDurationSeconds = new Histogram({
    name: 'clawreview_review_filter_report_read_duration_seconds',
    help:
      'Tick 24: /api/reviews/:id/filter-report read latency in seconds, ' +
      'labelled by the same projection shape (full | slim) as the ' +
      'reads counter. Pairs with reviewFilterReportReadsTotal so a ' +
      'dashboard can compute average latency per shape (sum/count) ' +
      'and quantify the slim-vs-full tradeoff. Fires once per 200; ' +
      '404 arms are deliberately excluded so the histogram reflects ' +
      'actual persisted-shape reads only.',
    labelNames: ['shape'],
    // Sub-ms happy path; tail captures GC pauses on very large reviews
    // and rare lock contention. Slowest bucket 1s catches pathological
    // file-store spillover so an on-call sees the outlier on /metrics
    // before it shows up as a user complaint.
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });

  const reviewFilterReportDiffTotal = new Counter({
    name: 'clawreview_review_filter_report_diff_total',
    help:
      'Tick 25: per-invocation outcome for the CLI review filter-report ' +
      '--diff two-review compare, labeled by result (closed set: identical ' +
      '| delta | error). identical = both bodies fetched, hasDelta=false ' +
      '(CLI exit 0); delta = both bodies fetched, hasDelta=true (CLI exit ' +
      '3); error = config / fetch / parse failure (CLI exit 2). Fires once ' +
      'per CLI invocation. Pair with clawreview_review_drift_watch_polls_' +
      'total to compare the live (watch) vs gated (diff) views of filter-' +
      'shape health across a CI fleet.',
    labelNames: ['result'],
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
    reviewDigestPersistedDriftTotal,
    reviewDriftWatchPollsTotal,
    reviewDigestFilterAppliedTotal,
    findingsFilterPreAppliedTotal,
    reviewFilterReportReadsTotal,
    reviewFilterReportReadDurationSeconds,
    reviewFilterReportDiffTotal,
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

/**
 * Closed set of `kind` values the WRITE-side review-digest-drift
 * counter (`reviewDigestPersistedDriftTotal`) can record:
 *
 *   - `fresh`     -- the worker had no prior persisted digest to compare
 *                    against (first run for this review, or a legacy
 *                    review created before tick 12 persisted digests).
 *                    Counted so the rate vs `stale` is meaningful for
 *                    the denominator.
 *   - `unchanged` -- the worker's new digest agreed with the prior
 *                    persisted digest byte-for-byte (no drift).
 *   - `stale`     -- the worker's new digest disagreed with the prior
 *                    persisted digest on at least one bucket; the
 *                    review's bucket counts changed between runs.
 *
 * Three buckets (vs the read-side's two) because the write-side has
 * the "no prior digest existed" case that the read-side can't see
 * (the route handler synthesises an empty persisted digest on the
 * legacy path).
 *
 * Exported as a `const` literal so callers cannot drift via a typo.
 */
export const REVIEW_DIGEST_PERSISTED_DRIFT_KINDS = [
  'fresh',
  'unchanged',
  'stale',
] as const;
export type ReviewDigestPersistedDriftKind =
  (typeof REVIEW_DIGEST_PERSISTED_DRIFT_KINDS)[number];

/**
 * Derive the closed-set kind for the WRITE-side persisted-drift counter.
 *
 * The contract is intentionally different from the read-side
 * `deriveReviewDigestDriftKind`:
 *
 *   - If `priorDigest` is `null` / `undefined`, the worker had nothing
 *     to compare against -- the kind is `fresh`. We do NOT fall back
 *     to the drift's hasDrift bit in this case (the caller would have
 *     synthesised an empty persisted to produce a drift report, but
 *     for telemetry attribution we still want to count it as `fresh`,
 *     not `stale`, because the dashboard's "stale rate" should not
 *     spike on first-run reviews).
 *   - Otherwise, `drift.hasDrift` flips `stale` vs `unchanged`.
 *
 * Pure / exported so unit tests can pin the contract without spinning
 * up a metrics bundle.
 */
export function deriveReviewDigestPersistedDriftKind(
  priorDigest: unknown | null | undefined,
  drift: { hasDrift: boolean },
): ReviewDigestPersistedDriftKind {
  if (priorDigest === null || priorDigest === undefined) return 'fresh';
  return drift.hasDrift ? 'stale' : 'unchanged';
}

/**
 * Pure predicate: which structured log level should the worker emit
 * for a write-side persisted-drift outcome?
 *
 * Pairs with `observeReviewDigestPersistedDrift` (the Prometheus
 * counter): the counter answers "how often does each kind fire?",
 * this predicate answers "should the worker also surface it in
 * structured logs, and at what level?".
 *
 * Today the worker hot path picks the level inline (`log.info` on
 * every drift). Extracting the choice here gives:
 *   - one test surface for the level contract (this file);
 *   - the ability to elevate `stale` to `warn` without re-deriving
 *     the kind inside the worker;
 *   - a path for future audits (e.g. a CI hook that scrapes the
 *     worker logs and counts warn-level drift events without
 *     re-walking the metrics endpoint).
 *
 * Level semantics:
 *   - `stale`     -> `warn`  -- the re-run produced different bucket
 *                               counts than a real prior digest. An
 *                               on-call's existing log-level alerts
 *                               should fire here. Per the roadmap:
 *                               "fires today via log.info; elevate
 *                               to warn so existing alerting picks
 *                               it up without the Prometheus pipe."
 *   - `unchanged` -> `info`  -- steady-state; useful for completion
 *                               audits but not alert-worthy.
 *   - `fresh`     -> `none`  -- first run / legacy review (no prior
 *                               digest existed). Logging on every
 *                               first-run would flood logs without
 *                               adding signal; the counter already
 *                               captures the volume.
 *
 * Pure / exported so the test suite pins the contract; the worker
 * imports and dispatches off the returned literal.
 */
export type ReviewDigestPersistedDriftLogLevel = 'warn' | 'info' | 'none';

export function deriveReviewDigestPersistedDriftLogLevel(
  kind: ReviewDigestPersistedDriftKind,
): ReviewDigestPersistedDriftLogLevel {
  if (kind === 'stale') return 'warn';
  if (kind === 'unchanged') return 'info';
  return 'none';
}

/**
 * Record one worker completion on the
 * `clawreview_review_digest_persisted_drift_total{kind}` counter.
 *
 * Fired once per accepted worker completion that produces a digest --
 * including first runs (which fire with kind=`fresh` since there was
 * nothing to compare against).
 *
 * The kind is derived from (priorDigest, drift) via
 * `deriveReviewDigestPersistedDriftKind` so the counter cannot drift
 * from the worker's own decision about what to do with the comparison:
 * same predicate, two consumers (telemetry + worker log line).
 *
 * Distinct from `observeReviewDigestDrift` (the read-side helper)
 * because the write-side has the extra `fresh` bucket for "no prior
 * digest existed".
 *
 * Cheap to call from the worker's hot completion path: a single
 * counter increment with one short label value. Bounded cardinality
 * (three label values, ever).
 */
export function observeReviewDigestPersistedDrift(
  metrics: MetricsBundle,
  priorDigest: unknown | null | undefined,
  drift: { hasDrift: boolean },
): void {
  const kind = deriveReviewDigestPersistedDriftKind(priorDigest, drift);
  metrics.reviewDigestPersistedDriftTotal.inc({ kind });
}

/**
 * Closed set of `result` values the CLI watch-loop poll counter
 * (`reviewDriftWatchPollsTotal`) can record:
 *
 *   - `ok`     -- HTTP fetch succeeded, drift.hasDrift was false.
 *   - `drift`  -- HTTP fetch succeeded, drift.hasDrift was true.
 *   - `error`  -- HTTP fetch failed OR body could not be parsed; the
 *                 watch loop exits 2 after firing this one bump.
 *
 * Exported as a `const` literal so callers cannot drift via a typo;
 * a typo'd literal would silently fragment the counter series across
 * label values that both look correct in code review.
 */
export const REVIEW_DRIFT_WATCH_RESULTS = ['ok', 'drift', 'error'] as const;
export type ReviewDriftWatchResult = (typeof REVIEW_DRIFT_WATCH_RESULTS)[number];

/**
 * Derive the closed-set `result` label from a poll outcome.
 *
 * Two inputs:
 *   - `fetchOk`  -- did the HTTP fetch + JSON parse succeed?
 *   - `drift`    -- the parsed drift report, or `null` when the fetch
 *                   failed (in which case the predicate ignores it
 *                   and returns 'error').
 *
 * Truth table:
 *   - fetchOk=false, drift=any                 -> 'error'
 *   - fetchOk=true,  drift=null                -> 'error'  (parse failure)
 *   - fetchOk=true,  drift.hasDrift=false      -> 'ok'
 *   - fetchOk=true,  drift.hasDrift=true       -> 'drift'
 *
 * Pure / exported so the test surface can pin every arm without
 * driving the watch loop.
 */
export function deriveReviewDriftWatchResult(
  fetchOk: boolean,
  drift: { hasDrift: boolean } | null,
): ReviewDriftWatchResult {
  if (!fetchOk || drift === null) return 'error';
  return drift.hasDrift ? 'drift' : 'ok';
}

/**
 * Record one watch-loop poll on the `clawreview_review_drift_watch_polls_total`
 * counter.
 *
 * Called from the CLI `review drift --watch` loop on every fetch
 * attempt (success or failure). The metrics bundle is injected so a
 * CLI consumer that doesn't want to depend on Prometheus can skip the
 * counter entirely (the watch loop simply doesn't fire it); a
 * production deploy wires a real bundle and the counter shows up on
 * /metrics scrapes for whichever sidecar is exporting the CLI's
 * counters.
 *
 * Cheap to call: a single counter increment with one short label
 * value. Bounded cardinality (three label values, ever).
 */
export function observeReviewDriftWatchPoll(
  metrics: MetricsBundle,
  fetchOk: boolean,
  drift: { hasDrift: boolean } | null,
): void {
  const result = deriveReviewDriftWatchResult(fetchOk, drift);
  metrics.reviewDriftWatchPollsTotal.inc({ result });
}

/**
 * Tick 25: closed set of `result` label values the
 * `clawreview_review_filter_report_diff_total` counter can record:
 *
 *   - `'identical'` -- both bodies fetched, hasDelta=false. CLI exit 0.
 *   - `'delta'`     -- both bodies fetched, hasDelta=true. CLI exit 3.
 *   - `'error'`     -- config / fetch / parse failure. CLI exit 2.
 *
 * Exported as a `const` literal so callers cannot drift via a typo;
 * a typo'd literal would silently fragment the counter series.
 */
export const REVIEW_FILTER_REPORT_DIFF_RESULTS = ['identical', 'delta', 'error'] as const;
export type ReviewFilterReportDiffResult =
  (typeof REVIEW_FILTER_REPORT_DIFF_RESULTS)[number];

/**
 * Derive the closed-set `result` label from a diff invocation
 * outcome. Two inputs:
 *
 *   - `fetchOk` -- did both HTTP fetches + JSON parses succeed?
 *   - `delta`   -- the computed FilterReportDelta (carries hasDelta),
 *                  or null when the fetch path errored (in which case
 *                  the predicate ignores it and returns 'error').
 *
 * Truth table:
 *   - fetchOk=false, delta=any        -> 'error'
 *   - fetchOk=true,  delta=null       -> 'error'  (parse failure)
 *   - fetchOk=true,  delta.hasDelta=false -> 'identical'
 *   - fetchOk=true,  delta.hasDelta=true  -> 'delta'
 *
 * Pure / exported so the test surface can pin every arm without
 * driving the diff command.
 */
export function deriveReviewFilterReportDiffResult(
  fetchOk: boolean,
  delta: { hasDelta: boolean } | null,
): ReviewFilterReportDiffResult {
  if (!fetchOk || delta === null) return 'error';
  return delta.hasDelta ? 'delta' : 'identical';
}

/**
 * Record one `review filter-report --diff` invocation on the
 * `clawreview_review_filter_report_diff_total{result}` counter.
 *
 * Called once per CLI invocation. Bounded cardinality (three label
 * values, ever). Cheap to call; the metrics bundle is injected so a
 * CLI consumer that doesn't want a Prometheus dep can omit it (the
 * diff command simply skips the fire); a production deploy wires
 * a real bundle and the counter shows up on /metrics scrapes for
 * whichever sidecar is exporting the CLI's counters.
 */
export function observeReviewFilterReportDiff(
  metrics: MetricsBundle,
  fetchOk: boolean,
  delta: { hasDelta: boolean } | null,
): void {
  const result = deriveReviewFilterReportDiffResult(fetchOk, delta);
  metrics.reviewFilterReportDiffTotal.inc({ result });
}

/**
 * Tick 21: closed set of boolean labels the digest-filter-applied
 * counter (`reviewDigestFilterAppliedTotal`) can record on each
 * axis:
 *
 *   - `yes` -- the filter normalised to a not-no-op threshold
 *              (minConfidence > 0 OR severityThreshold !== null)
 *              AND the route consumed the filter (the cached arm
 *              skips the filter entirely; only the fresh arm fires
 *              the counter).
 *   - `no`  -- the operator did not supply the filter, OR the value
 *              normalised to the no-op (clamped 0 / unknown
 *              severity literal).
 *
 * Exported as a `const` literal so callers cannot drift via a typo;
 * a typo'd literal would silently fragment the counter series across
 * label values that both look correct in code review.
 */
export const REVIEW_DIGEST_FILTER_APPLIED_LABELS = ['yes', 'no'] as const;
export type ReviewDigestFilterAppliedLabel =
  (typeof REVIEW_DIGEST_FILTER_APPLIED_LABELS)[number];

/**
 * Tick 21: derive a `yes`/`no` label from a boolean (the `applied`
 * bit on `findingDigestWithFilterReport`'s appliedFilters arms).
 *
 * Pure: a 3-line helper that exists only so the worker / route layer
 * can't accidentally pass a string like 'yes'/'No'/'true' that would
 * fragment the counter series.
 */
export function deriveReviewDigestFilterAppliedLabel(
  applied: boolean,
): ReviewDigestFilterAppliedLabel {
  return applied ? 'yes' : 'no';
}

/**
 * Record one `/api/reviews/:id/digest` fresh recompute on the
 * `clawreview_review_digest_filter_applied_total{min_confidence,severity_threshold}`
 * counter.
 *
 * Fires once per accepted /digest fresh call (the cached arm is
 * inert because the persisted digest carries no filter metadata --
 * counting the cached arm would corrupt the "what fraction of
 * dashboards request filtered fresh recomputes?" rate).
 *
 * Two labels, both `yes`/`no`:
 *   - `min_confidence`     -- did the request apply a real
 *                             minConfidence floor? (>0 after
 *                             normalisation.)
 *   - `severity_threshold` -- did the request apply a real
 *                             severityThreshold floor? (a valid
 *                             Severity literal after normalisation.)
 *
 * The cross-product cardinality is exactly 4 (yes/yes, yes/no, no/yes,
 * no/no) so this counter cannot blow up the cardinality budget. The
 * `no/no` bucket dominates traffic on the default no-filter call.
 *
 * Pairs with tick 20's `?minConfidence` / `?severityThreshold` query
 * knobs and tick 21's `findingDigestWithFilterReport` helper: the
 * helper computes the `applied` bit, the counter records it. Dashboards
 * can graph e.g.
 *   rate(clawreview_review_digest_filter_applied_total{min_confidence="yes"}[5m])
 * to see "what fraction of /digest reads filter by confidence?".
 *
 * Cheap to call from a hot Fastify hook: a single counter increment
 * with two short label values per request.
 */
export function observeReviewDigestFilterApplied(
  metrics: MetricsBundle,
  minConfidenceApplied: boolean,
  severityThresholdApplied: boolean,
): void {
  metrics.reviewDigestFilterAppliedTotal.inc({
    min_confidence: deriveReviewDigestFilterAppliedLabel(minConfidenceApplied),
    severity_threshold: deriveReviewDigestFilterAppliedLabel(severityThresholdApplied),
  });
}

/**
 * Tick 22: closed set of pipeline phases the worker-side filter-
 * coverage counter (`findingsFilterPreAppliedTotal`) attributes
 * each fire to:
 *
 *   - `aggregate`   -- the filter applied INSIDE aggregate() via
 *                      cfg.min_confidence + cfg.severity_threshold
 *                      mapping to aggregate's `minConfidence` /
 *                      `threshold` opts. Runs before dedupe / rank.
 *   - `worker_post` -- the filter applied in the worker's
 *                      findingDigestWithFilterReport pass AFTER
 *                      aggregate(). Defence-in-depth on the happy
 *                      path; reflects the contract of the
 *                      persisted digest.
 *
 * Exported as a `const` literal so callers cannot drift via a typo;
 * a typo'd literal (e.g. 'aggregator' or 'worker' alone) would
 * silently fragment the counter series across label values that
 * look correct in code review. A grep for FINDINGS_FILTER_PHASES
 * is the one source of truth.
 */
export const FINDINGS_FILTER_PHASES = ['aggregate', 'worker_post'] as const;
export type FindingsFilterPhase = (typeof FINDINGS_FILTER_PHASES)[number];

/**
 * Tick 22: record one filter-coverage observation on the
 * `clawreview_findings_filter_pre_applied_total{phase,applied}`
 * counter.
 *
 * Fires from two call sites in the worker -- once per phase per
 * completed review. The worker passes the SAME `applied` bit to
 * both phases (cfg.min_confidence / cfg.severity_threshold are
 * the source of truth for both); the per-phase fire lets a
 * dashboard separate "aggregate filter active" from "post-aggregate
 * filter active" if a future refactor decouples the two.
 *
 * `applied` is intentionally a single boolean here rather than
 * the two-axis (min_confidence, severity_threshold) shape the
 * read-side counter uses. Rationale: the worker call sites
 * already know whether the filter "did anything" via the
 * FindingDigestFilterReport.appliedFilters.any bit (which
 * collapses both axes to a single OR). For drill-down on which
 * axis fired, the persisted ReviewRecord.filterReport carries
 * the per-axis bits; consumers needing per-axis attribution read
 * that field. Keeping the counter to a single axis caps cardinality
 * at 4 (2 phases x 2 applied values).
 *
 * Cheap: a single counter increment per fire.
 */
export function observeFindingsFilterPreApplied(
  metrics: MetricsBundle,
  phase: FindingsFilterPhase,
  applied: boolean,
): void {
  metrics.findingsFilterPreAppliedTotal.inc({
    phase,
    applied: deriveReviewDigestFilterAppliedLabel(applied),
  });
}

/**
 * Tick 23: closed set of response shapes for the
 * `/api/reviews/:id/filter-report` endpoint -- the `shape` label on
 * the `reviewFilterReportReadsTotal` counter.
 *
 *   - `full` -- the response carried the verbose appliedFilters
 *                object (default `?slim=false` / absent).
 *   - `slim` -- the response stripped appliedFilters and carried
 *                only the single `applied: boolean` (`?slim=true|1|yes`).
 *
 * Exported as a `const` literal so callers cannot drift via a typo;
 * a typo'd literal would silently fragment the counter series across
 * label values that both look correct in code review. A grep for
 * REVIEW_FILTER_REPORT_SHAPES is the one source of truth.
 */
export const REVIEW_FILTER_REPORT_SHAPES = ['full', 'slim'] as const;
export type ReviewFilterReportShape = (typeof REVIEW_FILTER_REPORT_SHAPES)[number];

/**
 * Tick 23: derive a `full`/`slim` shape label from the slim-projection
 * boolean (the `slim` query knob's resolved value).
 *
 * Pure: a 3-line helper that exists only so the route layer cannot
 * accidentally pass a string like 'true'/'false'/'compact' that
 * would fragment the counter series.
 */
export function deriveReviewFilterReportShape(slim: boolean): ReviewFilterReportShape {
  return slim ? 'slim' : 'full';
}

/**
 * Tick 23: record one accepted `/api/reviews/:id/filter-report` read
 * on the `clawreview_review_filter_report_reads_total{shape}` counter.
 *
 * Fires once per 200 response (404 NotFound / NoFilterReport are
 * deliberately excluded -- they didn't actually consume the
 * persisted shape, so counting them would inflate the read rate
 * with traffic that didn't touch the data). The route layer fires
 * this AFTER deciding the response body but BEFORE returning, so a
 * mid-render exception doesn't leak a phantom count.
 *
 * Cheap: a single counter increment with one short label.
 */
export function observeReviewFilterReportRead(
  metrics: MetricsBundle,
  slim: boolean,
): void {
  metrics.reviewFilterReportReadsTotal.inc({
    shape: deriveReviewFilterReportShape(slim),
  });
}

/**
 * Tick 24: record one accepted `/api/reviews/:id/filter-report` read
 * LATENCY on the `clawreview_review_filter_report_read_duration_seconds`
 * histogram, labelled by the same projection shape (`full`/`slim`) as
 * the tick-23 counter.
 *
 * Pairs with `observeReviewFilterReportRead`: the counter fire and the
 * histogram observation use the SAME shape derivation so a dashboard
 * joining the two series doesn't risk mis-labelled samples. Same fire
 * discipline: 200 reads only; 404 arms (NotFound, NoFilterReport) are
 * deliberately excluded because they didn't actually consume the
 * persisted shape -- their latency would represent a 404 lookup, not
 * a filter-report read, and would bias the per-shape average.
 *
 * `durationSeconds` must be a finite non-negative number. Callers
 * typically measure with `performance.now()` and divide by 1000:
 *
 *     const start = performance.now();
 *     // ... do the work, build the response body ...
 *     observeReviewFilterReportReadDuration(metrics, slim, (performance.now() - start) / 1000);
 *
 * Non-finite / negative values are silently clamped to 0 so an
 * upstream clock-skew or measurement bug doesn't poison the
 * histogram with bogus values that would skew quantile estimates.
 *
 * Cheap: a single histogram observation with one short label.
 */
export function observeReviewFilterReportReadDuration(
  metrics: MetricsBundle,
  slim: boolean,
  durationSeconds: number,
): void {
  // Clamp non-finite / negative samples to 0 so a bogus measurement
  // (clock skew, programming error) doesn't poison the histogram's
  // quantile estimates with values that would skew the dashboard.
  const safe =
    Number.isFinite(durationSeconds) && durationSeconds >= 0
      ? durationSeconds
      : 0;
  metrics.reviewFilterReportReadDurationSeconds.observe(
    { shape: deriveReviewFilterReportShape(slim) },
    safe,
  );
}

