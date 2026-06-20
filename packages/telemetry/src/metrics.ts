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
