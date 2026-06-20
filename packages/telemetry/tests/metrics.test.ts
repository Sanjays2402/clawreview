import { afterEach, describe, expect, it } from 'vitest';

import {
  getMetrics,
  observeAgentExecutions,
  observeSimilarityMerges,
  resetMetricsForTests,
} from '../src/metrics.js';

afterEach(() => {
  resetMetricsForTests();
});

describe('observeAgentExecutions', () => {
  it('emits agent_duration_seconds, agent_invocations_total, and agent_findings_total', async () => {
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeAgentExecutions(metrics, [
      { agent: 'security', status: 'ok', durationMs: 1200, findings: [{}, {}, {}] as { length: number } as never },
      { agent: 'style', status: 'error', durationMs: 800, findings: [], error: 'boom' },
      { agent: 'secrets', status: 'skipped', durationMs: 0, findings: [] },
    ]);

    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_agent_duration_seconds histogram');
    expect(text).toContain('# TYPE clawreview_agent_invocations_total counter');
    expect(text).toContain('# TYPE clawreview_agent_findings_total counter');

    // Invocation counters land with both labels.
    expect(text).toMatch(/clawreview_agent_invocations_total\{[^}]*agent="security"[^}]*outcome="ok"[^}]*\} 1/);
    expect(text).toMatch(/clawreview_agent_invocations_total\{[^}]*agent="style"[^}]*outcome="error"[^}]*\} 1/);
    expect(text).toMatch(/clawreview_agent_invocations_total\{[^}]*agent="secrets"[^}]*outcome="skipped"[^}]*\} 1/);

    // Duration histogram emits per-bucket counts plus _sum and _count
    // for the non-skipped runs (security ok + style error = 2 obs).
    expect(text).toMatch(/clawreview_agent_duration_seconds_count\{[^}]*agent="security"[^}]*outcome="ok"[^}]*\} 1/);
    expect(text).toMatch(/clawreview_agent_duration_seconds_count\{[^}]*agent="style"[^}]*outcome="error"[^}]*\} 1/);
    // skipped is NOT observed in the histogram (no work was done).
    expect(text).not.toMatch(/clawreview_agent_duration_seconds_count\{[^}]*agent="secrets"/);

    // Findings counter only fires when findings.length > 0.
    expect(text).toMatch(/clawreview_agent_findings_total\{[^}]*agent="security"[^}]*\} 3/);
    expect(text).not.toMatch(/clawreview_agent_findings_total\{[^}]*agent="style"/);
  });

  it('accepts a numeric findings count (not just an array) for callers with pre-summarised data', async () => {
    const metrics = getMetrics({ service: 'clawreview-test-2', defaultMetrics: false });
    observeAgentExecutions(metrics, [
      { agent: 'performance', status: 'ok', durationMs: 500, findings: 5 },
    ]);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_agent_findings_total\{[^}]*agent="performance"[^}]*\} 5/);
  });

  it('is a safe no-op on an empty input', async () => {
    const metrics = getMetrics({ service: 'clawreview-test-3', defaultMetrics: false });
    observeAgentExecutions(metrics, []);
    const text = await metrics.registry.metrics();
    // The series definitions still appear (Prometheus expects them),
    // but no sample rows should be present yet.
    expect(text).toContain('# TYPE clawreview_agent_duration_seconds histogram');
    expect(text).not.toMatch(/clawreview_agent_invocations_total\{[^}]*agent=/);
  });

  it('records the duration value in seconds (durationMs / 1000)', async () => {
    const metrics = getMetrics({ service: 'clawreview-test-4', defaultMetrics: false });
    observeAgentExecutions(metrics, [
      { agent: 'security', status: 'ok', durationMs: 2500, findings: [] },
    ]);
    const text = await metrics.registry.metrics();
    // _sum reports the cumulative observed seconds; for one 2.5s obs
    // we expect a sum of 2.5.
    expect(text).toMatch(/clawreview_agent_duration_seconds_sum\{[^}]*agent="security"[^}]*\} 2\.5/);
  });

  it('accumulates per agent across multiple invocations', async () => {
    const metrics = getMetrics({ service: 'clawreview-test-5', defaultMetrics: false });
    observeAgentExecutions(metrics, [
      { agent: 'security', status: 'ok', durationMs: 1000, findings: 1 },
      { agent: 'security', status: 'ok', durationMs: 2000, findings: 2 },
      { agent: 'security', status: 'error', durationMs: 500, findings: 0 },
    ]);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_agent_invocations_total\{[^}]*agent="security"[^}]*outcome="ok"[^}]*\} 2/);
    expect(text).toMatch(/clawreview_agent_invocations_total\{[^}]*agent="security"[^}]*outcome="error"[^}]*\} 1/);
    expect(text).toMatch(/clawreview_agent_findings_total\{[^}]*agent="security"[^}]*\} 3/);
  });
});

describe('observeSimilarityMerges', () => {
  it('emits clawreview_similarity_merges_total{winner_agent,loser_agent}', async () => {
    const metrics = getMetrics({ service: 'clawreview-sim-1', defaultMetrics: false });
    observeSimilarityMerges(metrics, [
      { winner: 'sql-injection', losers: ['security'] },
      { winner: 'sql-injection', losers: ['security'] },
      { winner: 'performance', losers: ['style'] },
    ]);
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_similarity_merges_total counter');
    expect(text).toMatch(
      /clawreview_similarity_merges_total\{[^}]*winner_agent="sql-injection"[^}]*loser_agent="security"[^}]*\} 2/,
    );
    expect(text).toMatch(
      /clawreview_similarity_merges_total\{[^}]*winner_agent="performance"[^}]*loser_agent="style"[^}]*\} 1/,
    );
  });

  it('fans out N-way merges into one counter per (winner, loser) pair', async () => {
    const metrics = getMetrics({ service: 'clawreview-sim-2', defaultMetrics: false });
    observeSimilarityMerges(metrics, [
      { winner: 'security', losers: ['style', 'performance'] },
    ]);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_similarity_merges_total\{[^}]*winner_agent="security"[^}]*loser_agent="style"[^}]*\} 1/,
    );
    expect(text).toMatch(
      /clawreview_similarity_merges_total\{[^}]*winner_agent="security"[^}]*loser_agent="performance"[^}]*\} 1/,
    );
  });

  it('is a safe no-op on an empty list', async () => {
    const metrics = getMetrics({ service: 'clawreview-sim-3', defaultMetrics: false });
    observeSimilarityMerges(metrics, []);
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_similarity_merges_total counter');
    expect(text).not.toMatch(/clawreview_similarity_merges_total\{[^}]*winner_agent=/);
  });
});
