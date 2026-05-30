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
