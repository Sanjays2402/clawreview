import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';
import { resetMetricsForTests } from '@clawreview/telemetry';

describe('prometheus /metrics endpoint', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    resetMetricsForTests();
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    resetMetricsForTests();
  });

  it('exposes Prometheus text format with default + custom metrics', async () => {
    // Generate one observed request first.
    const probe = await app.inject({ method: 'GET', url: '/healthz' });
    expect(probe.statusCode).toBe(200);
    const versionRes = await app.inject({ method: 'GET', url: '/version' });
    expect(versionRes.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const body = res.body;
    // Default process metrics from prom-client.
    expect(body).toContain('process_cpu_seconds_total');
    expect(body).toContain('nodejs_eventloop_lag_seconds');
    // Custom HTTP histogram + counter declarations.
    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toContain('# TYPE http_request_duration_seconds histogram');
    // Service label is applied.
    expect(body).toContain('service="clawreview-server"');
    // The /version request was observed; /healthz and /metrics are skipped.
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/version"[^}]*\} \d+/);
    expect(body).not.toMatch(/http_requests_total\{[^}]*route="\/healthz"/);
    expect(body).not.toMatch(/http_requests_total\{[^}]*route="\/metrics"/);
  });

  it('uses route templates not raw paths to keep cardinality bounded', async () => {
    // /reviews/:id is a templated route; hit it with a non-existent id.
    const res = await app.inject({ method: 'GET', url: '/reviews/does-not-exist-12345' });
    // Status not asserted (handler may 404); we only care about labeling.
    expect([200, 400, 401, 404, 500]).toContain(res.statusCode);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    const body = metrics.body;
    // Raw id should never appear as a route label.
    expect(body).not.toContain('route="/reviews/does-not-exist-12345"');
  });
});
