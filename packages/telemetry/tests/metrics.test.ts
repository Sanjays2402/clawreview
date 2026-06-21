import { afterEach, describe, expect, it } from 'vitest';

import {
  FINDING_DROP_REASONS,
  OPERATOR_POLL_RESULTS,
  getMetrics,
  observeAgentExecutions,
  observeAuthorAttribution,
  observeFindingsDropped,
  observeOperatorPoll,
  observeSimilarityMerges,
  observeWebhookDelivery,
  resetMetricsForTests,
  sanitizeAuthorLabel,
  sanitizeOperatorPollProbe,
  sanitizeRepoLabel,
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

describe('sanitizeAuthorLabel', () => {
  it('prefers email when present and lowercases it', () => {
    expect(sanitizeAuthorLabel('Sanjay Singh', 'Sanjay@Example.COM')).toBe('sanjay@example.com');
  });

  it('falls back to a slugified name when email is blank', () => {
    expect(sanitizeAuthorLabel('Sanjay Singh', '')).toBe('sanjay-singh');
    expect(sanitizeAuthorLabel('Sanjay Singh', '   ')).toBe('sanjay-singh');
  });

  it('strips control characters and angle brackets', () => {
    expect(sanitizeAuthorLabel('weird', '<bad\nname>@x')).toBe('badname@x');
  });

  it('caps the label at 80 characters', () => {
    const long = 'a'.repeat(200) + '@example.com';
    const out = sanitizeAuthorLabel('', long);
    expect(out.length).toBe(80);
  });

  it('returns "unknown" when both inputs sanitize to empty', () => {
    expect(sanitizeAuthorLabel('', '')).toBe('unknown');
    expect(sanitizeAuthorLabel('\n\t', '   ')).toBe('unknown');
  });
});

describe('observeAuthorAttribution', () => {
  it('emits clawreview_authors_attributed_total per (sanitized author) with the total findings count', async () => {
    const metrics = getMetrics({ service: 'clawreview-authors-1', defaultMetrics: false });
    observeAuthorAttribution(metrics, [
      { authorName: 'Sanjay Singh', authorEmail: 'sanjay@example.com', total: 5 },
      { authorName: 'Alex', authorEmail: 'alex@example.com', total: 2 },
    ]);
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_authors_attributed_total counter');
    expect(text).toMatch(
      /clawreview_authors_attributed_total\{[^}]*author="sanjay@example.com"[^}]*\} 5/,
    );
    expect(text).toMatch(
      /clawreview_authors_attributed_total\{[^}]*author="alex@example.com"[^}]*\} 2/,
    );
  });

  it('uses findings.length when total is not pre-computed', async () => {
    const metrics = getMetrics({ service: 'clawreview-authors-2', defaultMetrics: false });
    observeAuthorAttribution(metrics, [
      { authorName: 'X', authorEmail: 'x@example.com', findings: { length: 3 } },
    ]);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_authors_attributed_total\{[^}]*author="x@example.com"[^}]*\} 3/);
  });

  it('skips authors with zero findings rather than emitting a zero sample', async () => {
    const metrics = getMetrics({ service: 'clawreview-authors-3', defaultMetrics: false });
    observeAuthorAttribution(metrics, [
      { authorName: 'Empty', authorEmail: 'empty@example.com', total: 0 },
      { authorName: 'Other', authorEmail: 'other@example.com', total: 1 },
    ]);
    const text = await metrics.registry.metrics();
    expect(text).not.toMatch(/clawreview_authors_attributed_total\{[^}]*author="empty@example.com"/);
    expect(text).toMatch(/clawreview_authors_attributed_total\{[^}]*author="other@example.com"[^}]*\} 1/);
  });

  it('accumulates across multiple calls (counter, not gauge)', async () => {
    const metrics = getMetrics({ service: 'clawreview-authors-4', defaultMetrics: false });
    observeAuthorAttribution(metrics, [
      { authorName: 'Alex', authorEmail: 'alex@example.com', total: 2 },
    ]);
    observeAuthorAttribution(metrics, [
      { authorName: 'Alex', authorEmail: 'alex@example.com', total: 3 },
    ]);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_authors_attributed_total\{[^}]*author="alex@example.com"[^}]*\} 5/);
  });

  it('is a safe no-op on an empty list', async () => {
    const metrics = getMetrics({ service: 'clawreview-authors-5', defaultMetrics: false });
    observeAuthorAttribution(metrics, []);
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_authors_attributed_total counter');
    expect(text).not.toMatch(/clawreview_authors_attributed_total\{[^}]*author=/);
  });
});

describe('observeFindingsDropped', () => {
  it('exposes a fixed list of reasons so labels stay closed', () => {
    expect(FINDING_DROP_REASONS).toEqual(['severity_rule', 'min_confidence', 'inline_suppression']);
  });

  it('emits clawreview_findings_dropped_total labeled by reason', async () => {
    const metrics = getMetrics({ service: 'clawreview-drops-1', defaultMetrics: false });
    observeFindingsDropped(metrics, 'severity_rule', 3);
    observeFindingsDropped(metrics, 'min_confidence', 5);
    observeFindingsDropped(metrics, 'inline_suppression', 1);
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_findings_dropped_total counter');
    expect(text).toMatch(/clawreview_findings_dropped_total\{[^}]*reason="severity_rule"[^}]*\} 3/);
    expect(text).toMatch(/clawreview_findings_dropped_total\{[^}]*reason="min_confidence"[^}]*\} 5/);
    expect(text).toMatch(/clawreview_findings_dropped_total\{[^}]*reason="inline_suppression"[^}]*\} 1/);
  });

  it('defaults count to 1 when omitted', async () => {
    const metrics = getMetrics({ service: 'clawreview-drops-2', defaultMetrics: false });
    observeFindingsDropped(metrics, 'severity_rule');
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_findings_dropped_total\{[^}]*reason="severity_rule"[^}]*\} 1/);
  });

  it('accumulates across multiple calls (counter, not gauge)', async () => {
    const metrics = getMetrics({ service: 'clawreview-drops-3', defaultMetrics: false });
    observeFindingsDropped(metrics, 'min_confidence', 4);
    observeFindingsDropped(metrics, 'min_confidence', 2);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_findings_dropped_total\{[^}]*reason="min_confidence"[^}]*\} 6/);
  });

  it('is a safe no-op when count is zero, negative, or non-finite', async () => {
    const metrics = getMetrics({ service: 'clawreview-drops-4', defaultMetrics: false });
    observeFindingsDropped(metrics, 'severity_rule', 0);
    observeFindingsDropped(metrics, 'severity_rule', -3);
    observeFindingsDropped(metrics, 'severity_rule', Number.NaN);
    observeFindingsDropped(metrics, 'severity_rule', Number.POSITIVE_INFINITY);
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_findings_dropped_total counter');
    expect(text).not.toMatch(/clawreview_findings_dropped_total\{[^}]*reason="severity_rule"/);
  });
});

describe('sanitizeRepoLabel', () => {
  it('lower-cases owner/name so Org/Repo and org/repo collapse', () => {
    expect(sanitizeRepoLabel('Sanjays2402/ClawReview')).toBe('sanjays2402/clawreview');
    expect(sanitizeRepoLabel('sanjays2402/clawreview')).toBe('sanjays2402/clawreview');
  });

  it('returns "(none)" for the empty / missing / non-string cases', () => {
    expect(sanitizeRepoLabel('')).toBe('(none)');
    expect(sanitizeRepoLabel(undefined)).toBe('(none)');
    expect(sanitizeRepoLabel(null)).toBe('(none)');
    // After whitespace + control stripping, an all-whitespace input
    // collapses to empty and lands in the (none) bucket too.
    expect(sanitizeRepoLabel('   ')).toBe('(none)');
  });

  it('strips control characters, whitespace, and quote / backtick noise', () => {
    expect(sanitizeRepoLabel('owner /repo')).toBe('owner/repo');
    expect(sanitizeRepoLabel('owner\trepo\n')).toBe('ownerrepo');
    expect(sanitizeRepoLabel('o"w\'n`e r/ repo')).toBe('owner/repo');
    // A null byte mid-string is dropped.
    expect(sanitizeRepoLabel('owner/re\u0000po')).toBe('owner/repo');
  });

  it('caps at 100 chars so a runaway label can\'t blow up cardinality', () => {
    const long = 'a'.repeat(60) + '/' + 'b'.repeat(60);
    const out = sanitizeRepoLabel(long);
    expect(out.length).toBe(100);
    // Prefix of the cleaned input survives intact.
    expect(out.startsWith('a'.repeat(60) + '/')).toBe(true);
  });
});

describe('observeWebhookDelivery', () => {
  it('emits clawreview_webhook_deliveries_total{event,repo}', async () => {
    const metrics = getMetrics({ service: 'clawreview-wd-1', defaultMetrics: false });
    observeWebhookDelivery(metrics, 'pull_request', 'Sanjays2402/clawreview');
    observeWebhookDelivery(metrics, 'pull_request', 'sanjays2402/clawreview');
    observeWebhookDelivery(metrics, 'push', 'sanjays2402/clawreview');
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_webhook_deliveries_total counter');
    // Org/Repo and org/repo collapse to one series via the sanitiser
    // so the count for pull_request lands at 2 (not 1 + 1 across two
    // case-shifted series).
    expect(text).toMatch(
      /clawreview_webhook_deliveries_total\{[^}]*event="pull_request"[^}]*repo="sanjays2402\/clawreview"[^}]*\} 2/,
    );
    expect(text).toMatch(
      /clawreview_webhook_deliveries_total\{[^}]*event="push"[^}]*repo="sanjays2402\/clawreview"[^}]*\} 1/,
    );
  });

  it('routes deliveries with no repoFullName under the "(none)" bucket', async () => {
    const metrics = getMetrics({ service: 'clawreview-wd-2', defaultMetrics: false });
    // Installation-class events frequently carry no repository in the
    // payload; the bucket must still surface so dashboards can see the
    // size of the no-repo slice.
    observeWebhookDelivery(metrics, 'installation', undefined);
    observeWebhookDelivery(metrics, 'installation', '');
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_webhook_deliveries_total\{[^}]*event="installation"[^}]*repo="\(none\)"[^}]*\} 2/,
    );
  });

  it('is a safe no-op when event is empty or non-string', async () => {
    const metrics = getMetrics({ service: 'clawreview-wd-3', defaultMetrics: false });
    observeWebhookDelivery(metrics, '', 'sanjay/demo');
    // Bypass the type system to verify the runtime guard.
    observeWebhookDelivery(metrics, undefined as unknown as string, 'sanjay/demo');
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_webhook_deliveries_total counter');
    expect(text).not.toMatch(/clawreview_webhook_deliveries_total\{[^}]*repo="sanjay\/demo"/);
  });

  it('accumulates across many deliveries (counter, not gauge)', async () => {
    const metrics = getMetrics({ service: 'clawreview-wd-4', defaultMetrics: false });
    for (let i = 0; i < 7; i++) {
      observeWebhookDelivery(metrics, 'pull_request', 'sanjay/demo');
    }
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_webhook_deliveries_total\{[^}]*event="pull_request"[^}]*repo="sanjay\/demo"[^}]*\} 7/,
    );
  });
});

describe('sanitizeOperatorPollProbe', () => {
  it('collapses null / undefined / empty / whitespace to (none) so the bucket is still visible', () => {
    expect(sanitizeOperatorPollProbe(null)).toBe('(none)');
    expect(sanitizeOperatorPollProbe(undefined)).toBe('(none)');
    expect(sanitizeOperatorPollProbe('')).toBe('(none)');
    expect(sanitizeOperatorPollProbe('   ')).toBe('(none)');
  });

  it('preserves the route-layer sanitised probe name as-is (no double-trim)', () => {
    // operatorPollProbeParam already strips disallowed chars and
    // caps at 64; the metric helper should trust that contract and
    // not re-sanitise. Passing a value with internal hyphens / dots
    // must survive untouched.
    expect(sanitizeOperatorPollProbe('stats-sidebar')).toBe('stats-sidebar');
    expect(sanitizeOperatorPollProbe('replay.recent')).toBe('replay.recent');
    expect(sanitizeOperatorPollProbe('top_repos_widget')).toBe('top_repos_widget');
  });

  it('coerces non-string values to (none) as a belt-and-braces guard', () => {
    // Defensive: the metric helper is the only write site, so a
    // misuse where the caller hands a number (e.g. forgot to extract
    // the string) must not poison the registry with `NaN` / `0` labels.
    expect(sanitizeOperatorPollProbe(42 as unknown as string)).toBe('(none)');
    expect(sanitizeOperatorPollProbe({} as unknown as string)).toBe('(none)');
    expect(sanitizeOperatorPollProbe([] as unknown as string)).toBe('(none)');
  });
});

describe('observeOperatorPoll', () => {
  it('records ok / bypass / throttled outcomes against the probe label', async () => {
    const metrics = getMetrics({ service: 'clawreview-op-1', defaultMetrics: false });
    observeOperatorPoll(metrics, 'stats-sidebar', 'ok');
    observeOperatorPoll(metrics, 'stats-sidebar', 'ok');
    observeOperatorPoll(metrics, 'stats-sidebar', 'throttled');
    observeOperatorPoll(metrics, 'replay-recent', 'bypass');

    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_operator_poll_total counter');
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="stats-sidebar"[^}]*result="ok"[^}]*\} 2/,
    );
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="stats-sidebar"[^}]*result="throttled"[^}]*\} 1/,
    );
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="replay-recent"[^}]*result="bypass"[^}]*\} 1/,
    );
  });

  it('routes null / unset probes under the (none) bucket so anonymous polling is still surfaced', async () => {
    const metrics = getMetrics({ service: 'clawreview-op-2', defaultMetrics: false });
    observeOperatorPoll(metrics, null, 'ok');
    observeOperatorPoll(metrics, undefined, 'ok');
    observeOperatorPoll(metrics, '', 'throttled');

    const text = await metrics.registry.metrics();
    // Two `ok` increments under `(none)`.
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="\(none\)"[^}]*result="ok"[^}]*\} 2/,
    );
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="\(none\)"[^}]*result="throttled"[^}]*\} 1/,
    );
  });

  it('exposes a closed OPERATOR_POLL_RESULTS literal so callers cannot drift on label values', () => {
    // Compile-time guard already prevents a stray literal, but
    // pin the runtime shape too so a future tick can't quietly
    // re-order or grow the result set without updating tests.
    expect(OPERATOR_POLL_RESULTS).toEqual(['ok', 'bypass', 'throttled']);
  });

  it('keeps the same metric bundle on repeated registration (no double-count after rebind)', async () => {
    // Verify the bundle cache: two getMetrics() calls inside one
    // process must hand back the same Counter object so independent
    // call sites can both increment without double-creating the
    // metric. Without this guard, the Fastify hook's per-request
    // getMetrics() call would create a fresh counter per request
    // and lose every increment.
    const m1 = getMetrics({ service: 'clawreview-op-3', defaultMetrics: false });
    const m2 = getMetrics({ service: 'clawreview-op-3', defaultMetrics: false });
    expect(m1.operatorPollTotal).toBe(m2.operatorPollTotal);
    observeOperatorPoll(m1, 'p1', 'ok');
    observeOperatorPoll(m2, 'p1', 'ok');
    const text = await m1.registry.metrics();
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="p1"[^}]*result="ok"[^}]*\} 2/,
    );
  });
});
