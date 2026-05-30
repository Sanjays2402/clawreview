import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getMetrics,
  registerQueueDepthCollector,
  resetMetricsForTests,
} from '@clawreview/telemetry';
import { buildServer } from '../src/server.js';

/**
 * Smoke tests for the worker / queue Prometheus surface. We do not boot
 * the real worker (that would need GitHub credentials and a live LLM);
 * instead we drive the counters/histogram directly the same way the
 * worker pipeline does, then scrape /metrics and assert the series show
 * up with the labels operators rely on.
 */
describe('worker + queue Prometheus surface', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let queuePending = 0;
  let queueInflight = 0;
  let disposeProbe: (() => void) | undefined;

  beforeAll(async () => {
    resetMetricsForTests();
    app = await buildServer();
    await app.ready();
    // Drive the gauges through the same registration path the metrics
    // plugin uses, but with a fake probe we can mutate per-test.
    const metrics = getMetrics({ service: 'clawreview-server' });
    disposeProbe = registerQueueDepthCollector(metrics, 'test-queue', async () => ({
      pending: queuePending,
      inflight: queueInflight,
    }));
  });

  afterAll(async () => {
    disposeProbe?.();
    await app.close();
    resetMetricsForTests();
  });

  it('exposes review counters, duration histogram, cost counter, and queue gauges', async () => {
    const metrics = getMetrics({ service: 'clawreview-server' });
    metrics.reviewsStartedTotal.inc({ source: 'webhook' });
    metrics.reviewsStartedTotal.inc({ source: 'manual' }, 2);
    metrics.reviewsCompletedTotal.inc({ outcome: 'completed' });
    metrics.reviewDurationSeconds.observe({ outcome: 'completed' }, 12.5);
    metrics.reviewFindingsTotal.inc({ severity: 'high' }, 3);
    metrics.llmCostUsdTotal.inc({ outcome: 'completed' }, 0.42);
    metrics.webhookEventsTotal.inc({ event: 'pull_request', action: 'opened', result: 'queued' });

    queuePending = 7;
    queueInflight = 2;

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.body;

    // Counter declarations are present.
    expect(body).toContain('# TYPE clawreview_reviews_started_total counter');
    expect(body).toContain('# TYPE clawreview_reviews_completed_total counter');
    expect(body).toContain('# TYPE clawreview_review_duration_seconds histogram');
    expect(body).toContain('# TYPE clawreview_review_findings_total counter');
    expect(body).toContain('# TYPE clawreview_llm_cost_usd_total counter');
    expect(body).toContain('# TYPE clawreview_queue_depth gauge');
    expect(body).toContain('# TYPE clawreview_queue_inflight gauge');

    // Sample values land with the right labels.
    expect(body).toMatch(/clawreview_reviews_started_total\{[^}]*source="webhook"[^}]*\} 1/);
    expect(body).toMatch(/clawreview_reviews_started_total\{[^}]*source="manual"[^}]*\} 2/);
    expect(body).toMatch(/clawreview_reviews_completed_total\{[^}]*outcome="completed"[^}]*\} 1/);
    expect(body).toMatch(/clawreview_review_findings_total\{[^}]*severity="high"[^}]*\} 3/);
    expect(body).toMatch(/clawreview_llm_cost_usd_total\{[^}]*outcome="completed"[^}]*\} 0\.42/);
    expect(body).toMatch(/clawreview_webhook_events_total\{[^}]*event="pull_request"[^}]*action="opened"[^}]*result="queued"[^}]*\} 1/);

    // Pull-time queue gauges reflect the probe's current snapshot.
    expect(body).toMatch(/clawreview_queue_depth\{[^}]*queue="test-queue"[^}]*\} 7/);
    expect(body).toMatch(/clawreview_queue_inflight\{[^}]*queue="test-queue"[^}]*\} 2/);

    // Histogram emits per-bucket counts plus _sum/_count.
    expect(body).toContain('clawreview_review_duration_seconds_count');
    expect(body).toContain('clawreview_review_duration_seconds_sum');
  });

  it('survives a queue probe that throws by keeping the last sample', async () => {
    queuePending = 4;
    queueInflight = 1;
    // First scrape primes the gauge.
    await app.inject({ method: 'GET', url: '/metrics' });

    // Swap in a failing probe; scrape should still succeed and the
    // previous sample must remain visible.
    disposeProbe?.();
    const metrics = getMetrics({ service: 'clawreview-server' });
    disposeProbe = registerQueueDepthCollector(metrics, 'test-queue', async () => {
      throw new Error('queue backend unavailable');
    });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/clawreview_queue_depth\{[^}]*queue="test-queue"[^}]*\} 4/);
  });
});
