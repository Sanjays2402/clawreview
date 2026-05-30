import {
  Counter,
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

  bundle = {
    registry,
    httpRequestsTotal,
    httpRequestDurationSeconds,
    webhookEventsTotal,
    reviewsStartedTotal,
    reviewsCompletedTotal,
  };
  return bundle;
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
