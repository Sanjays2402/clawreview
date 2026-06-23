import { afterEach, describe, expect, it } from 'vitest';

import {
  FINDING_DROP_REASONS,
  OPERATOR_POLL_BYPASS_REASONS,
  OPERATOR_POLL_RESULTS,
  REVIEW_DIGEST_DRIFT_KINDS,
  REVIEW_DIGEST_PERSISTED_DRIFT_KINDS,
  WEBHOOK_STATS_WINDOW_MODES,
  deriveReviewDigestDriftKind,
  deriveReviewDigestPersistedDriftKind,
  deriveWebhookStatsWindowMode,
  getMetrics,
  observeAgentExecutions,
  observeAuthorAttribution,
  observeFindingsDropped,
  observeOperatorPoll,
  observeOperatorPollBypass,
  observeReviewDigestDrift,
  observeReviewDigestPersistedDrift,
  observeSimilarityMerges,
  observeWebhookDelivery,
  observeWebhookStatsWindowAnchor,
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

// Tick 12: clawreview_operator_poll_bypass_total{probe,reason}
// attribution counter. The volume metric (operatorPollTotal) answers
// "how many bypasses?"; this one answers "why was each bypass
// authorised?" so a security audit can graph reason drift separately
// from raw bypass volume.
describe('observeOperatorPollBypass', () => {
  it('records bypass reasons against the probe label', async () => {
    const metrics = getMetrics({ service: 'clawreview-byp-1', defaultMetrics: false });
    observeOperatorPollBypass(metrics, 'stats-sidebar', 'force');
    observeOperatorPollBypass(metrics, 'stats-sidebar', 'force');
    observeOperatorPollBypass(metrics, 'replay-recent', 'force');
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_operator_poll_bypass_total counter');
    expect(text).toMatch(
      /clawreview_operator_poll_bypass_total\{[^}]*probe="stats-sidebar"[^}]*reason="force"[^}]*\} 2/,
    );
    expect(text).toMatch(
      /clawreview_operator_poll_bypass_total\{[^}]*probe="replay-recent"[^}]*reason="force"[^}]*\} 1/,
    );
  });

  it('routes null / unset probes under (none) so anonymous bypasses are still surfaced', async () => {
    const metrics = getMetrics({ service: 'clawreview-byp-2', defaultMetrics: false });
    observeOperatorPollBypass(metrics, null, 'force');
    observeOperatorPollBypass(metrics, undefined, 'force');
    observeOperatorPollBypass(metrics, '', 'force');
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_operator_poll_bypass_total\{[^}]*probe="\(none\)"[^}]*reason="force"[^}]*\} 3/,
    );
  });

  it('exposes a closed OPERATOR_POLL_BYPASS_REASONS literal so callers cannot drift on label values', () => {
    // The bypass-reason set is intentionally tiny today (only
    // 'force') but the closed type guards against the most likely
    // future regression: a security-sensitive new bypass path
    // landing without showing up in the metric. Adding a new
    // authorised bypass MUST extend this constant and surface in a
    // PR diff that a security reviewer can spot.
    expect(OPERATOR_POLL_BYPASS_REASONS).toEqual(['force']);
  });

  it('reconciles with operatorPollTotal{result="bypass"} on the volume axis', async () => {
    // The rate-limit hook calls BOTH counters on the same request:
    // volume metric for "how many" + attribution for "why". The two
    // must agree per-probe on the total-by-bypass count so an
    // operator can sanity-check one against the other in Prom.
    const metrics = getMetrics({ service: 'clawreview-byp-3', defaultMetrics: false });
    for (let i = 0; i < 4; i++) {
      observeOperatorPoll(metrics, 'stats-sidebar', 'bypass');
      observeOperatorPollBypass(metrics, 'stats-sidebar', 'force');
    }
    const text = await metrics.registry.metrics();
    // Both counters land at 4 for the same probe.
    expect(text).toMatch(
      /clawreview_operator_poll_total\{[^}]*probe="stats-sidebar"[^}]*result="bypass"[^}]*\} 4/,
    );
    expect(text).toMatch(
      /clawreview_operator_poll_bypass_total\{[^}]*probe="stats-sidebar"[^}]*reason="force"[^}]*\} 4/,
    );
  });

  it('shares the bundle cache so the rate-limit hook does not double-create the counter', async () => {
    // Same guard as the volume counter: two getMetrics() calls hand
    // back the same Counter object. Without this, every request
    // through the rate-limit hook would create a fresh counter and
    // lose increments.
    const m1 = getMetrics({ service: 'clawreview-byp-4', defaultMetrics: false });
    const m2 = getMetrics({ service: 'clawreview-byp-4', defaultMetrics: false });
    expect(m1.operatorPollBypassTotal).toBe(m2.operatorPollBypassTotal);
    observeOperatorPollBypass(m1, 'p1', 'force');
    observeOperatorPollBypass(m2, 'p1', 'force');
    const text = await m1.registry.metrics();
    expect(text).toMatch(
      /clawreview_operator_poll_bypass_total\{[^}]*probe="p1"[^}]*reason="force"[^}]*\} 2/,
    );
  });
});

// Tick 13: clawreview_webhook_stats_window_anchor_total{mode} counter
// + deriveWebhookStatsWindowMode helper. Pairs with the tick-12
// `?bucketWindow=` anchor override on /api/internal/webhook/stats so
// Prom can graph live vs snapshot reads.
describe('deriveWebhookStatsWindowMode', () => {
  it('returns `live` for null / undefined / non-string non-number values', () => {
    // No anchor supplied -> default behaviour -> live.
    expect(deriveWebhookStatsWindowMode(null)).toBe('live');
    expect(deriveWebhookStatsWindowMode(undefined)).toBe('live');
  });

  it('returns `snapshot` for a finite numeric anchor (epoch ms)', () => {
    // A real anchor override -> snapshot. The number itself is
    // never validated here -- the route layer rejects negatives /
    // non-finite values up-front and silently falls back to the
    // live clock, so a non-finite value reaches this helper as
    // null (not a number).
    expect(deriveWebhookStatsWindowMode(1718987400000)).toBe('snapshot');
    expect(deriveWebhookStatsWindowMode(0)).toBe('snapshot');
    expect(deriveWebhookStatsWindowMode(1)).toBe('snapshot');
  });

  it('falls back to `live` for non-finite numbers (defensive guard)', () => {
    // A non-finite value should never reach this helper because the
    // route layer rejects it earlier and substitutes null. The
    // belt-and-braces guard ensures a bug in the route layer can't
    // poison the counter with a `NaN` label value.
    expect(deriveWebhookStatsWindowMode(NaN)).toBe('live');
    expect(deriveWebhookStatsWindowMode(Infinity)).toBe('live');
    expect(deriveWebhookStatsWindowMode(-Infinity)).toBe('live');
  });

  it('exposes a closed WEBHOOK_STATS_WINDOW_MODES literal so callers cannot drift', () => {
    // Pin the runtime shape so a future tick can't quietly add a
    // third mode without updating tests. Adding a new mode would
    // need an explicit edit + a corresponding counter label slot.
    expect(WEBHOOK_STATS_WINDOW_MODES).toEqual(['live', 'snapshot']);
  });
});

describe('observeWebhookStatsWindowAnchor', () => {
  it('records `live` reads when no anchor override is supplied', async () => {
    const metrics = getMetrics({ service: 'clawreview-wsa-1', defaultMetrics: false });
    observeWebhookStatsWindowAnchor(metrics, null);
    observeWebhookStatsWindowAnchor(metrics, undefined);
    observeWebhookStatsWindowAnchor(metrics, null);
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_webhook_stats_window_anchor_total counter');
    expect(text).toMatch(
      /clawreview_webhook_stats_window_anchor_total\{[^}]*mode="live"[^}]*\} 3/,
    );
  });

  it('records `snapshot` reads when a finite numeric anchor is supplied', async () => {
    const metrics = getMetrics({ service: 'clawreview-wsa-2', defaultMetrics: false });
    observeWebhookStatsWindowAnchor(metrics, 1718987400000);
    observeWebhookStatsWindowAnchor(metrics, 1718987500000);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_webhook_stats_window_anchor_total\{[^}]*mode="snapshot"[^}]*\} 2/,
    );
  });

  it('partitions the two modes cleanly (a mix of live + snapshot reads)', async () => {
    // Real dashboards mix the two: most reads live, a few snapshot
    // during postmortems. The counter must give both buckets per
    // scrape so a Grafana alert can compute the snapshot ratio.
    const metrics = getMetrics({ service: 'clawreview-wsa-3', defaultMetrics: false });
    for (let i = 0; i < 6; i++) observeWebhookStatsWindowAnchor(metrics, null);
    for (let i = 0; i < 2; i++) observeWebhookStatsWindowAnchor(metrics, 1718987400000);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_webhook_stats_window_anchor_total\{[^}]*mode="live"[^}]*\} 6/,
    );
    expect(text).toMatch(
      /clawreview_webhook_stats_window_anchor_total\{[^}]*mode="snapshot"[^}]*\} 2/,
    );
  });

  it('coerces non-finite numeric anchors to the `live` bucket (mirrors deriveWebhookStatsWindowMode)', async () => {
    // The route layer never lets these through, but the counter
    // helper's contract is "match the predicate", not "trust the
    // caller". If a future route bug starts passing NaN through,
    // the counter must NOT fragment the series with a `NaN` label.
    const metrics = getMetrics({ service: 'clawreview-wsa-4', defaultMetrics: false });
    observeWebhookStatsWindowAnchor(metrics, NaN);
    observeWebhookStatsWindowAnchor(metrics, Infinity);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_webhook_stats_window_anchor_total\{[^}]*mode="live"[^}]*\} 2/,
    );
    // No `mode="NaN"` or similar leak.
    expect(text).not.toMatch(/mode="NaN"/);
    expect(text).not.toMatch(/mode="Infinity"/);
  });

  it('shares the bundle cache so the route hook does not double-create the counter', async () => {
    // Same guard as the operator-poll counters: two getMetrics()
    // calls return the same Counter object so increments from
    // different request paths accumulate to the same series.
    const m1 = getMetrics({ service: 'clawreview-wsa-5', defaultMetrics: false });
    const m2 = getMetrics({ service: 'clawreview-wsa-5', defaultMetrics: false });
    expect(m1.webhookStatsWindowAnchorTotal).toBe(m2.webhookStatsWindowAnchorTotal);
    observeWebhookStatsWindowAnchor(m1, null);
    observeWebhookStatsWindowAnchor(m2, null);
    const text = await m1.registry.metrics();
    expect(text).toMatch(
      /clawreview_webhook_stats_window_anchor_total\{[^}]*mode="live"[^}]*\} 2/,
    );
  });

  it('accumulates across many reads (counter, not gauge)', async () => {
    // The classic counter contract: the metric only goes up,
    // never resets between scrapes within a single process.
    const metrics = getMetrics({ service: 'clawreview-wsa-6', defaultMetrics: false });
    for (let i = 0; i < 10; i++) observeWebhookStatsWindowAnchor(metrics, null);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_webhook_stats_window_anchor_total\{[^}]*mode="live"[^}]*\} 10/,
    );
  });
});

describe('deriveReviewDigestDriftKind', () => {
  it('returns "stale" when hasDrift is true', () => {
    expect(deriveReviewDigestDriftKind({ hasDrift: true })).toBe('stale');
  });

  it('returns "fresh" when hasDrift is false', () => {
    expect(deriveReviewDigestDriftKind({ hasDrift: false })).toBe('fresh');
  });

  it('returns one of the closed-set kinds (defense against drift)', () => {
    // The label set is closed; the helper must always return one of
    // the two literals from REVIEW_DIGEST_DRIFT_KINDS so a future
    // route layer cannot smuggle a third value through.
    const drift = deriveReviewDigestDriftKind({ hasDrift: true });
    expect(REVIEW_DIGEST_DRIFT_KINDS).toContain(drift);
  });

  it('REVIEW_DIGEST_DRIFT_KINDS is exactly [fresh, stale] (cardinality contract)', () => {
    expect([...REVIEW_DIGEST_DRIFT_KINDS]).toEqual(['fresh', 'stale']);
  });
});

describe('observeReviewDigestDrift', () => {
  it('emits the stale label on hasDrift=true', async () => {
    const metrics = getMetrics({ service: 'clawreview-rdd-1', defaultMetrics: false });
    observeReviewDigestDrift(metrics, { hasDrift: true });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_digest_drift_total\{[^}]*kind="stale"[^}]*\} 1/,
    );
  });

  it('emits the fresh label on hasDrift=false', async () => {
    const metrics = getMetrics({ service: 'clawreview-rdd-2', defaultMetrics: false });
    observeReviewDigestDrift(metrics, { hasDrift: false });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_digest_drift_total\{[^}]*kind="fresh"[^}]*\} 1/,
    );
  });

  it('mixes both kinds without fragmenting the series', async () => {
    const metrics = getMetrics({ service: 'clawreview-rdd-3', defaultMetrics: false });
    observeReviewDigestDrift(metrics, { hasDrift: true });
    observeReviewDigestDrift(metrics, { hasDrift: false });
    observeReviewDigestDrift(metrics, { hasDrift: true });
    observeReviewDigestDrift(metrics, { hasDrift: false });
    observeReviewDigestDrift(metrics, { hasDrift: false });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_digest_drift_total\{[^}]*kind="stale"[^}]*\} 2/,
    );
    expect(text).toMatch(
      /clawreview_review_digest_drift_total\{[^}]*kind="fresh"[^}]*\} 3/,
    );
  });

  it('shares the bundle cache so two routes increment the same counter', async () => {
    const m1 = getMetrics({ service: 'clawreview-rdd-4', defaultMetrics: false });
    const m2 = getMetrics({ service: 'clawreview-rdd-4', defaultMetrics: false });
    expect(m1.reviewDigestDriftTotal).toBe(m2.reviewDigestDriftTotal);
    observeReviewDigestDrift(m1, { hasDrift: true });
    observeReviewDigestDrift(m2, { hasDrift: true });
    const text = await m1.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_digest_drift_total\{[^}]*kind="stale"[^}]*\} 2/,
    );
  });

  it('accumulates across many reads (counter, not gauge)', async () => {
    const metrics = getMetrics({ service: 'clawreview-rdd-5', defaultMetrics: false });
    for (let i = 0; i < 7; i++) observeReviewDigestDrift(metrics, { hasDrift: i % 2 === 0 });
    const text = await metrics.registry.metrics();
    // i = 0, 2, 4, 6 -> stale: 4 ; i = 1, 3, 5 -> fresh: 3
    expect(text).toMatch(
      /clawreview_review_digest_drift_total\{[^}]*kind="stale"[^}]*\} 4/,
    );
    expect(text).toMatch(
      /clawreview_review_digest_drift_total\{[^}]*kind="fresh"[^}]*\} 3/,
    );
  });
});

describe('deriveReviewDigestPersistedDriftKind (tick 15)', () => {
  it('returns fresh when priorDigest is null (no prior persisted to compare)', () => {
    expect(deriveReviewDigestPersistedDriftKind(null, { hasDrift: true })).toBe('fresh');
    expect(deriveReviewDigestPersistedDriftKind(null, { hasDrift: false })).toBe('fresh');
  });

  it('returns fresh when priorDigest is undefined (legacy review path)', () => {
    expect(deriveReviewDigestPersistedDriftKind(undefined, { hasDrift: true })).toBe('fresh');
  });

  it('returns stale when prior existed AND hasDrift is true', () => {
    // Any truthy object is a "prior persisted exists" signal.
    expect(deriveReviewDigestPersistedDriftKind({}, { hasDrift: true })).toBe('stale');
    expect(deriveReviewDigestPersistedDriftKind({ total: 5 }, { hasDrift: true })).toBe('stale');
  });

  it('returns unchanged when prior existed AND hasDrift is false', () => {
    expect(deriveReviewDigestPersistedDriftKind({}, { hasDrift: false })).toBe('unchanged');
    expect(deriveReviewDigestPersistedDriftKind({ total: 5 }, { hasDrift: false })).toBe(
      'unchanged',
    );
  });

  it('REVIEW_DIGEST_PERSISTED_DRIFT_KINDS is exactly [fresh, unchanged, stale] (cardinality contract)', () => {
    expect([...REVIEW_DIGEST_PERSISTED_DRIFT_KINDS]).toEqual(['fresh', 'unchanged', 'stale']);
  });

  it('returned kind is always a member of the closed set', () => {
    const cases: Array<[unknown, { hasDrift: boolean }]> = [
      [null, { hasDrift: true }],
      [null, { hasDrift: false }],
      [undefined, { hasDrift: true }],
      [{}, { hasDrift: true }],
      [{}, { hasDrift: false }],
    ];
    for (const [prior, drift] of cases) {
      const kind = deriveReviewDigestPersistedDriftKind(prior, drift);
      expect(REVIEW_DIGEST_PERSISTED_DRIFT_KINDS).toContain(kind);
    }
  });
});

describe('observeReviewDigestPersistedDrift (tick 15)', () => {
  it('emits the fresh label when priorDigest is null (first run / legacy)', async () => {
    const metrics = getMetrics({ service: 'clawreview-rdpd-1', defaultMetrics: false });
    observeReviewDigestPersistedDrift(metrics, null, { hasDrift: true });
    const text = await metrics.registry.metrics();
    // Even though hasDrift=true, kind is fresh because no prior to compare against.
    expect(text).toMatch(
      /clawreview_review_digest_persisted_drift_total\{[^}]*kind="fresh"[^}]*\} 1/,
    );
  });

  it('emits the unchanged label when prior existed AND hasDrift=false', async () => {
    const metrics = getMetrics({ service: 'clawreview-rdpd-2', defaultMetrics: false });
    observeReviewDigestPersistedDrift(metrics, { total: 3 }, { hasDrift: false });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_digest_persisted_drift_total\{[^}]*kind="unchanged"[^}]*\} 1/,
    );
  });

  it('emits the stale label when prior existed AND hasDrift=true', async () => {
    const metrics = getMetrics({ service: 'clawreview-rdpd-3', defaultMetrics: false });
    observeReviewDigestPersistedDrift(metrics, { total: 3 }, { hasDrift: true });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_digest_persisted_drift_total\{[^}]*kind="stale"[^}]*\} 1/,
    );
  });

  it('accumulates across the three kinds independently', async () => {
    const metrics = getMetrics({ service: 'clawreview-rdpd-4', defaultMetrics: false });
    // 2 fresh + 3 unchanged + 1 stale
    observeReviewDigestPersistedDrift(metrics, null, { hasDrift: false });
    observeReviewDigestPersistedDrift(metrics, undefined, { hasDrift: false });
    observeReviewDigestPersistedDrift(metrics, { x: 1 }, { hasDrift: false });
    observeReviewDigestPersistedDrift(metrics, { x: 1 }, { hasDrift: false });
    observeReviewDigestPersistedDrift(metrics, { x: 1 }, { hasDrift: false });
    observeReviewDigestPersistedDrift(metrics, { x: 1 }, { hasDrift: true });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_digest_persisted_drift_total\{[^}]*kind="fresh"[^}]*\} 2/,
    );
    expect(text).toMatch(
      /clawreview_review_digest_persisted_drift_total\{[^}]*kind="unchanged"[^}]*\} 3/,
    );
    expect(text).toMatch(
      /clawreview_review_digest_persisted_drift_total\{[^}]*kind="stale"[^}]*\} 1/,
    );
  });

  it('does NOT touch the read-side counter (kept distinct from observeReviewDigestDrift)', async () => {
    // The write-side and read-side counters are SEPARATE metrics. A
    // worker write-side fire must not also bump the read-side total,
    // otherwise the dashboard's "stale rate on reads vs writes"
    // comparison would silently double-count.
    const metrics = getMetrics({ service: 'clawreview-rdpd-5', defaultMetrics: false });
    observeReviewDigestPersistedDrift(metrics, { x: 1 }, { hasDrift: true });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_review_digest_persisted_drift_total/);
    // No read-side counter samples should have been emitted.
    expect(text).not.toMatch(/clawreview_review_digest_drift_total\{/);
  });
});

describe('deriveReviewDigestPersistedDriftLogLevel (tick 16)', () => {
  // Pure predicate the worker now uses to pick the structured log
  // level for a write-side persisted-drift outcome. Pairs with the
  // existing Prometheus counter -- the counter answers "how often
  // does each kind fire?"; this predicate answers "should the worker
  // also surface it in structured logs, and at what level?".

  it('elevates stale to warn so an on-call log alert picks it up', async () => {
    const { deriveReviewDigestPersistedDriftLogLevel } = await import('../src/metrics.js');
    expect(deriveReviewDigestPersistedDriftLogLevel('stale')).toBe('warn');
  });

  it('keeps unchanged at info (steady-state; useful audit but not alert-worthy)', async () => {
    const { deriveReviewDigestPersistedDriftLogLevel } = await import('../src/metrics.js');
    expect(deriveReviewDigestPersistedDriftLogLevel('unchanged')).toBe('info');
  });

  it('returns none for fresh so first-run / legacy reviews dont flood logs', async () => {
    // First runs and legacy reviews (pre-tick-12) cant have drift by
    // definition; logging would add no signal. The counter already
    // captures volume.
    const { deriveReviewDigestPersistedDriftLogLevel } = await import('../src/metrics.js');
    expect(deriveReviewDigestPersistedDriftLogLevel('fresh')).toBe('none');
  });

  it('covers every kind in the closed REVIEW_DIGEST_PERSISTED_DRIFT_KINDS set', async () => {
    // Defensive: when a future tick adds a new kind, this test fires
    // forcing the predicate to grow alongside it instead of
    // defaulting silently.
    const { deriveReviewDigestPersistedDriftLogLevel, REVIEW_DIGEST_PERSISTED_DRIFT_KINDS } = await import(
      '../src/metrics.js'
    );
    const expected = new Set(['warn', 'info', 'none']);
    for (const kind of REVIEW_DIGEST_PERSISTED_DRIFT_KINDS) {
      const level = deriveReviewDigestPersistedDriftLogLevel(kind);
      // Every kind must map to one of the three known levels.
      expect(expected).toContain(level);
    }
  });

  it('composes with deriveReviewDigestPersistedDriftKind (full worker pipeline)', async () => {
    // The worker derives kind first, then derives the log level
    // from kind. Verify the composition stays consistent across
    // every (priorDigest, hasDrift) combination the worker sees.
    const { deriveReviewDigestPersistedDriftKind, deriveReviewDigestPersistedDriftLogLevel } = await import(
      '../src/metrics.js'
    );
    // No prior digest -> kind=fresh -> level=none (no log line).
    expect(
      deriveReviewDigestPersistedDriftLogLevel(
        deriveReviewDigestPersistedDriftKind(null, { hasDrift: true }),
      ),
    ).toBe('none');
    // Prior digest + no drift -> kind=unchanged -> level=info.
    expect(
      deriveReviewDigestPersistedDriftLogLevel(
        deriveReviewDigestPersistedDriftKind({ total: 5 }, { hasDrift: false }),
      ),
    ).toBe('info');
    // Prior digest + drift -> kind=stale -> level=warn.
    expect(
      deriveReviewDigestPersistedDriftLogLevel(
        deriveReviewDigestPersistedDriftKind({ total: 5 }, { hasDrift: true }),
      ),
    ).toBe('warn');
  });
});

describe('deriveReviewDriftWatchResult (tick 17)', () => {
  it('returns ok when fetchOk=true and drift.hasDrift=false', async () => {
    const { deriveReviewDriftWatchResult } = await import('../src/metrics.js');
    expect(deriveReviewDriftWatchResult(true, { hasDrift: false })).toBe('ok');
  });

  it('returns drift when fetchOk=true and drift.hasDrift=true', async () => {
    const { deriveReviewDriftWatchResult } = await import('../src/metrics.js');
    expect(deriveReviewDriftWatchResult(true, { hasDrift: true })).toBe('drift');
  });

  it('returns error when fetchOk=false regardless of drift shape', async () => {
    const { deriveReviewDriftWatchResult } = await import('../src/metrics.js');
    // A failed fetch should always count as error, even if the loop
    // somehow carried a stale drift report from a prior iteration.
    expect(deriveReviewDriftWatchResult(false, { hasDrift: true })).toBe('error');
    expect(deriveReviewDriftWatchResult(false, { hasDrift: false })).toBe('error');
    expect(deriveReviewDriftWatchResult(false, null)).toBe('error');
  });

  it('returns error when fetchOk=true but drift is null (parse failure)', async () => {
    // The watch loop sets drift=null on a JSON parse failure even
    // when the HTTP fetch itself succeeded; the predicate must
    // surface that as 'error' for the counter.
    const { deriveReviewDriftWatchResult } = await import('../src/metrics.js');
    expect(deriveReviewDriftWatchResult(true, null)).toBe('error');
  });

  it('REVIEW_DRIFT_WATCH_RESULTS exports the closed three-value set', async () => {
    const { REVIEW_DRIFT_WATCH_RESULTS } = await import('../src/metrics.js');
    // Frozen tuple so a typo at a call site won't compile against
    // the union type. We assert the exact membership so a future
    // accidental widening (a fourth value) is caught here.
    expect([...REVIEW_DRIFT_WATCH_RESULTS]).toEqual(['ok', 'drift', 'error']);
  });
});

describe('observeReviewDriftWatchPoll (tick 17)', () => {
  it('bumps the counter under the ok label when fetchOk=true + no drift', async () => {
    resetMetricsForTests();
    const { observeReviewDriftWatchPoll } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewDriftWatchPoll(metrics, true, { hasDrift: false });
    observeReviewDriftWatchPoll(metrics, true, { hasDrift: false });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="ok"[^}]*\}\s*2/);
  });

  it('bumps the counter under the drift label when fetchOk=true + drift', async () => {
    resetMetricsForTests();
    const { observeReviewDriftWatchPoll } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewDriftWatchPoll(metrics, true, { hasDrift: true });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="drift"[^}]*\}\s*1/);
  });

  it('bumps the counter under the error label when fetchOk=false', async () => {
    resetMetricsForTests();
    const { observeReviewDriftWatchPoll } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewDriftWatchPoll(metrics, false, null);
    observeReviewDriftWatchPoll(metrics, false, { hasDrift: true });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="error"[^}]*\}\s*2/);
  });

  it('counts every poll separately across the three result buckets', async () => {
    // A mixed watch session: 3 ok, 2 drift, 1 error. Every bucket
    // should carry its own count; the buckets should not interfere
    // (no spillover from one label to another).
    resetMetricsForTests();
    const { observeReviewDriftWatchPoll } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewDriftWatchPoll(metrics, true, { hasDrift: false });
    observeReviewDriftWatchPoll(metrics, true, { hasDrift: false });
    observeReviewDriftWatchPoll(metrics, true, { hasDrift: false });
    observeReviewDriftWatchPoll(metrics, true, { hasDrift: true });
    observeReviewDriftWatchPoll(metrics, true, { hasDrift: true });
    observeReviewDriftWatchPoll(metrics, false, null);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="ok"[^}]*\}\s*3/);
    expect(text).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="drift"[^}]*\}\s*2/);
    expect(text).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="error"[^}]*\}\s*1/);
  });
});

// Tick 21: digest-filter-applied counter records whether the
// /api/reviews/:id/digest fresh recompute applied a pre-bucket
// filter on each axis (minConfidence, severityThreshold). Bounded
// at 4 series total (yes/yes, yes/no, no/yes, no/no).
describe('deriveReviewDigestFilterAppliedLabel (tick 21)', () => {
  it('returns yes when applied=true', async () => {
    const { deriveReviewDigestFilterAppliedLabel } = await import('../src/metrics.js');
    expect(deriveReviewDigestFilterAppliedLabel(true)).toBe('yes');
  });
  it('returns no when applied=false', async () => {
    const { deriveReviewDigestFilterAppliedLabel } = await import('../src/metrics.js');
    expect(deriveReviewDigestFilterAppliedLabel(false)).toBe('no');
  });
  it('REVIEW_DIGEST_FILTER_APPLIED_LABELS is the closed yes|no tuple', async () => {
    const { REVIEW_DIGEST_FILTER_APPLIED_LABELS } = await import('../src/metrics.js');
    // Frozen membership so a typo'd literal at a call site cannot
    // silently fragment the series.
    expect([...REVIEW_DIGEST_FILTER_APPLIED_LABELS]).toEqual(['yes', 'no']);
  });
});

describe('observeReviewDigestFilterApplied (tick 21)', () => {
  it('bumps the yes/yes series when both filters applied', async () => {
    resetMetricsForTests();
    const { observeReviewDigestFilterApplied } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewDigestFilterApplied(metrics, true, true);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_digest_filter_applied_total\{[^}]*min_confidence="yes"[^}]*severity_threshold="yes"[^}]*\}\s*1/,
    );
  });

  it('bumps the no/no series on the default no-filter call', async () => {
    resetMetricsForTests();
    const { observeReviewDigestFilterApplied } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewDigestFilterApplied(metrics, false, false);
    observeReviewDigestFilterApplied(metrics, false, false);
    const text = await metrics.registry.metrics();
    // no/no is the dominant series on default traffic.
    expect(text).toMatch(
      /clawreview_review_digest_filter_applied_total\{[^}]*min_confidence="no"[^}]*severity_threshold="no"[^}]*\}\s*2/,
    );
  });

  it('keeps yes/no and no/yes in independent buckets (no spillover)', async () => {
    // Three calls with the mixed shapes; the cross-product means each
    // call lands in its own labelset and the counts do not bleed
    // across.
    resetMetricsForTests();
    const { observeReviewDigestFilterApplied } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewDigestFilterApplied(metrics, true, false); // yes/no
    observeReviewDigestFilterApplied(metrics, true, false); // yes/no
    observeReviewDigestFilterApplied(metrics, false, true); // no/yes
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_digest_filter_applied_total\{[^}]*min_confidence="yes"[^}]*severity_threshold="no"[^}]*\}\s*2/,
    );
    expect(text).toMatch(
      /clawreview_review_digest_filter_applied_total\{[^}]*min_confidence="no"[^}]*severity_threshold="yes"[^}]*\}\s*1/,
    );
  });

  it('cardinality stays exactly 4 across the full cross-product', async () => {
    // Hit every cross-product cell. The closed yes|no x yes|no shape
    // is a hard 4-series ceiling so a future code-change that
    // accidentally widened either axis would surface here.
    resetMetricsForTests();
    const { observeReviewDigestFilterApplied } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewDigestFilterApplied(metrics, true, true);
    observeReviewDigestFilterApplied(metrics, true, false);
    observeReviewDigestFilterApplied(metrics, false, true);
    observeReviewDigestFilterApplied(metrics, false, false);
    const text = await metrics.registry.metrics();
    const seriesLines = text
      .split('\n')
      .filter((l) => l.startsWith('clawreview_review_digest_filter_applied_total{'));
    // Exactly four labelsets, each fired once.
    expect(seriesLines).toHaveLength(4);
    for (const line of seriesLines) {
      // Each series should carry a count of 1 (we fired each one
      // exactly once). The trailing whitespace + 1 is the value.
      expect(line).toMatch(/\}\s*1$/);
    }
  });

  it('reconciles per-axis cumulative counts with the bumped subsets', async () => {
    // 3 polls: 2 with minConfidence applied, 1 without; 1 with
    // severityThreshold applied, 2 without. The PER-AXIS sum across
    // the cross-product cells must agree with each per-axis total.
    resetMetricsForTests();
    const { observeReviewDigestFilterApplied } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewDigestFilterApplied(metrics, true, true);   // both yes
    observeReviewDigestFilterApplied(metrics, true, false);  // min yes only
    observeReviewDigestFilterApplied(metrics, false, false); // neither
    const text = await metrics.registry.metrics();
    // min_confidence=yes shows up in 2 calls (yes/yes + yes/no).
    const yesYes = text.match(
      /clawreview_review_digest_filter_applied_total\{[^}]*min_confidence="yes"[^}]*severity_threshold="yes"[^}]*\}\s*(\d+)/,
    );
    const yesNo = text.match(
      /clawreview_review_digest_filter_applied_total\{[^}]*min_confidence="yes"[^}]*severity_threshold="no"[^}]*\}\s*(\d+)/,
    );
    expect(yesYes).toBeTruthy();
    expect(yesNo).toBeTruthy();
    const minConfidenceYesTotal = Number(yesYes![1]) + Number(yesNo![1]);
    expect(minConfidenceYesTotal).toBe(2);
  });
});

// Tick 22: worker-side filter coverage counter. Fires twice per
// completed review (once per phase: aggregate, worker_post). The
// applied axis is a closed yes|no set so the cross-product
// cardinality is exactly 4. Mirrors the tick-21 read-side counter
// shape so a dashboard can join the two by axis.
describe('observeFindingsFilterPreApplied (tick 22)', () => {
  it('exposes FINDINGS_FILTER_PHASES as the closed phase tuple', async () => {
    const { FINDINGS_FILTER_PHASES } = await import('../src/metrics.js');
    // Frozen membership so a typo'd phase literal (e.g. 'aggregator')
    // at a worker call site cannot silently fragment the series.
    expect([...FINDINGS_FILTER_PHASES]).toEqual(['aggregate', 'worker_post']);
  });

  it('bumps phase=aggregate, applied=yes when the worker filter is active', async () => {
    resetMetricsForTests();
    const { observeFindingsFilterPreApplied } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-fp-1', defaultMetrics: false });
    observeFindingsFilterPreApplied(metrics, 'aggregate', true);
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE clawreview_findings_filter_pre_applied_total counter');
    expect(text).toMatch(
      /clawreview_findings_filter_pre_applied_total\{[^}]*phase="aggregate"[^}]*applied="yes"[^}]*\}\s*1/,
    );
  });

  it('bumps phase=worker_post, applied=no on the default no-filter call', async () => {
    resetMetricsForTests();
    const { observeFindingsFilterPreApplied } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-fp-2', defaultMetrics: false });
    observeFindingsFilterPreApplied(metrics, 'worker_post', false);
    observeFindingsFilterPreApplied(metrics, 'worker_post', false);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_findings_filter_pre_applied_total\{[^}]*phase="worker_post"[^}]*applied="no"[^}]*\}\s*2/,
    );
  });

  it('keeps aggregate and worker_post phases in independent buckets', async () => {
    // Three calls; per-phase totals must NOT bleed into each other.
    // Worker pattern is to fire BOTH phases per review with the same
    // applied bit so a dashboard joining on applied="yes" gets 2x
    // the review count.
    resetMetricsForTests();
    const { observeFindingsFilterPreApplied } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-fp-3', defaultMetrics: false });
    observeFindingsFilterPreApplied(metrics, 'aggregate', true);
    observeFindingsFilterPreApplied(metrics, 'aggregate', true);
    observeFindingsFilterPreApplied(metrics, 'worker_post', true);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_findings_filter_pre_applied_total\{[^}]*phase="aggregate"[^}]*applied="yes"[^}]*\}\s*2/,
    );
    expect(text).toMatch(
      /clawreview_findings_filter_pre_applied_total\{[^}]*phase="worker_post"[^}]*applied="yes"[^}]*\}\s*1/,
    );
  });

  it('cardinality stays exactly 4 across the phase x applied cross-product', async () => {
    // Hit every cell. The closed phase x yes|no shape is a hard
    // 4-series ceiling. A future widening of either axis (e.g. a
    // third phase or a yes|no|maybe tri-state) would surface here.
    resetMetricsForTests();
    const { observeFindingsFilterPreApplied } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-fp-4', defaultMetrics: false });
    observeFindingsFilterPreApplied(metrics, 'aggregate', true);
    observeFindingsFilterPreApplied(metrics, 'aggregate', false);
    observeFindingsFilterPreApplied(metrics, 'worker_post', true);
    observeFindingsFilterPreApplied(metrics, 'worker_post', false);
    const text = await metrics.registry.metrics();
    const seriesLines = text
      .split('\n')
      .filter((l) => l.startsWith('clawreview_findings_filter_pre_applied_total{'));
    expect(seriesLines).toHaveLength(4);
    for (const line of seriesLines) {
      expect(line).toMatch(/\}\s*1$/);
    }
  });

  it('reconciles per-axis cumulative count with the worker fire pattern (BOTH phases share applied)', async () => {
    // Workflow contract: the worker fires `aggregate` AND
    // `worker_post` with the SAME `applied` bit per review. A
    // dashboard query rate(...{applied="yes"}[5m]) should therefore
    // return 2x the per-minute rate of filtered reviews. Pin that
    // ratio here so a future refactor that decouples the bits
    // breaks visibly.
    resetMetricsForTests();
    const { observeFindingsFilterPreApplied } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-fp-5', defaultMetrics: false });
    // 3 reviews: 2 with filter applied, 1 without. Each review fires
    // both phases.
    for (let i = 0; i < 2; i++) {
      observeFindingsFilterPreApplied(metrics, 'aggregate', true);
      observeFindingsFilterPreApplied(metrics, 'worker_post', true);
    }
    observeFindingsFilterPreApplied(metrics, 'aggregate', false);
    observeFindingsFilterPreApplied(metrics, 'worker_post', false);
    const text = await metrics.registry.metrics();
    const aggYes = text.match(
      /clawreview_findings_filter_pre_applied_total\{[^}]*phase="aggregate"[^}]*applied="yes"[^}]*\}\s*(\d+)/,
    );
    const postYes = text.match(
      /clawreview_findings_filter_pre_applied_total\{[^}]*phase="worker_post"[^}]*applied="yes"[^}]*\}\s*(\d+)/,
    );
    expect(aggYes).toBeTruthy();
    expect(postYes).toBeTruthy();
    // Worker fires both phases in lockstep -> per-phase totals must match.
    expect(Number(aggYes![1])).toBe(2);
    expect(Number(postYes![1])).toBe(2);
    // Sum across both phases is 2x the filtered-review count.
    expect(Number(aggYes![1]) + Number(postYes![1])).toBe(4);
  });
});

// Tick 23: /api/reviews/:id/filter-report read counter (full | slim
// shape attribution). Bounded at 2 series total.
describe('deriveReviewFilterReportShape (tick 23)', () => {
  it('returns slim when slim=true', async () => {
    const { deriveReviewFilterReportShape } = await import('../src/metrics.js');
    expect(deriveReviewFilterReportShape(true)).toBe('slim');
  });
  it('returns full when slim=false', async () => {
    const { deriveReviewFilterReportShape } = await import('../src/metrics.js');
    expect(deriveReviewFilterReportShape(false)).toBe('full');
  });
  it('REVIEW_FILTER_REPORT_SHAPES is the closed full|slim tuple', async () => {
    const { REVIEW_FILTER_REPORT_SHAPES } = await import('../src/metrics.js');
    // Frozen membership so a typo'd literal at a call site cannot
    // silently fragment the series.
    expect([...REVIEW_FILTER_REPORT_SHAPES]).toEqual(['full', 'slim']);
  });
});

describe('observeReviewFilterReportRead (tick 23)', () => {
  it('bumps the full series when slim=false', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportRead } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frr-1', defaultMetrics: false });
    observeReviewFilterReportRead(metrics, false);
    observeReviewFilterReportRead(metrics, false);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_filter_report_reads_total\{[^}]*shape="full"[^}]*\}\s*2/,
    );
  });

  it('bumps the slim series when slim=true', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportRead } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frr-2', defaultMetrics: false });
    observeReviewFilterReportRead(metrics, true);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_filter_report_reads_total\{[^}]*shape="slim"[^}]*\}\s*1/,
    );
  });

  it('keeps full and slim independent (cardinality is exactly 2)', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportRead } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frr-3', defaultMetrics: false });
    observeReviewFilterReportRead(metrics, false); // full
    observeReviewFilterReportRead(metrics, true);  // slim
    observeReviewFilterReportRead(metrics, true);  // slim
    const text = await metrics.registry.metrics();
    const seriesLines = text
      .split('\n')
      .filter((l) => l.startsWith('clawreview_review_filter_report_reads_total{'));
    expect(seriesLines).toHaveLength(2);
    expect(text).toMatch(
      /clawreview_review_filter_report_reads_total\{[^}]*shape="full"[^}]*\}\s*1/,
    );
    expect(text).toMatch(
      /clawreview_review_filter_report_reads_total\{[^}]*shape="slim"[^}]*\}\s*2/,
    );
  });

  it('reconciles full + slim counts with the total read count', async () => {
    // Workflow contract: each read fires exactly once with one shape
    // label, so summing the two series gives the total read count.
    // Pin the invariant so a future refactor that double-fires
    // breaks visibly.
    resetMetricsForTests();
    const { observeReviewFilterReportRead } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frr-4', defaultMetrics: false });
    for (let i = 0; i < 5; i++) observeReviewFilterReportRead(metrics, false);
    for (let i = 0; i < 3; i++) observeReviewFilterReportRead(metrics, true);
    const text = await metrics.registry.metrics();
    const full = text.match(
      /clawreview_review_filter_report_reads_total\{[^}]*shape="full"[^}]*\}\s*(\d+)/,
    );
    const slim = text.match(
      /clawreview_review_filter_report_reads_total\{[^}]*shape="slim"[^}]*\}\s*(\d+)/,
    );
    expect(full).toBeTruthy();
    expect(slim).toBeTruthy();
    expect(Number(full![1])).toBe(5);
    expect(Number(slim![1])).toBe(3);
    expect(Number(full![1]) + Number(slim![1])).toBe(8); // 5 + 3 reads
  });
});

describe('observeReviewFilterReportReadDuration (tick 24)', () => {
  it('observes on the full series when slim=false', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportReadDuration } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrd-1', defaultMetrics: false });
    observeReviewFilterReportReadDuration(metrics, false, 0.005);
    observeReviewFilterReportReadDuration(metrics, false, 0.015);
    const text = await metrics.registry.metrics();
    // The histogram exposes _count and _sum per shape; pin both so
    // a future refactor that drops the labelled fire breaks visibly.
    expect(text).toMatch(
      /clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="full"[^}]*\}\s*2/,
    );
    // Sum is 0.005 + 0.015 = 0.02 (allow tiny float noise but match the prefix).
    expect(text).toMatch(
      /clawreview_review_filter_report_read_duration_seconds_sum\{[^}]*shape="full"[^}]*\}\s*0\.02/,
    );
  });

  it('observes on the slim series when slim=true', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportReadDuration } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrd-2', defaultMetrics: false });
    observeReviewFilterReportReadDuration(metrics, true, 0.001);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="slim"[^}]*\}\s*1/,
    );
  });

  it('keeps full and slim independent (cardinality is exactly 2)', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportReadDuration } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrd-3', defaultMetrics: false });
    observeReviewFilterReportReadDuration(metrics, false, 0.01);
    observeReviewFilterReportReadDuration(metrics, true, 0.002);
    observeReviewFilterReportReadDuration(metrics, true, 0.003);
    const text = await metrics.registry.metrics();
    // Two count series: one per shape. The _bucket / _sum lines per
    // shape are byte-byte regulars from prom-client; matching _count
    // is the canonical "this label appeared" assertion.
    const countLines = text
      .split('\n')
      .filter((l) =>
        l.startsWith('clawreview_review_filter_report_read_duration_seconds_count{'),
      );
    expect(countLines).toHaveLength(2);
    expect(text).toMatch(
      /clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="full"[^}]*\}\s*1/,
    );
    expect(text).toMatch(
      /clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="slim"[^}]*\}\s*2/,
    );
  });

  it('clamps non-finite durations to 0 (NaN / Infinity does not poison the histogram)', async () => {
    // A clock-skew or programming bug must never poison the histogram
    // because Prometheus quantile estimates would carry the bad value
    // forward indefinitely. Pin the clamp behaviour.
    resetMetricsForTests();
    const { observeReviewFilterReportReadDuration } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrd-4', defaultMetrics: false });
    observeReviewFilterReportReadDuration(metrics, false, Number.NaN);
    observeReviewFilterReportReadDuration(metrics, false, Number.POSITIVE_INFINITY);
    observeReviewFilterReportReadDuration(metrics, false, -1);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="full"[^}]*\}\s*3/,
    );
    // All three observations contributed 0, so the sum stays 0.
    expect(text).toMatch(
      /clawreview_review_filter_report_read_duration_seconds_sum\{[^}]*shape="full"[^}]*\}\s*0/,
    );
  });

  it('lands samples in the expected histogram buckets (1ms in le="0.001", 50ms in le="0.05")', async () => {
    // Bucket placement is the contract a dashboard depends on. Pin
    // the resolved buckets for two representative sample sizes.
    resetMetricsForTests();
    const { observeReviewFilterReportReadDuration } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrd-5', defaultMetrics: false });
    observeReviewFilterReportReadDuration(metrics, false, 0.001);  // exactly on the lowest bucket
    observeReviewFilterReportReadDuration(metrics, false, 0.045);  // below 0.05 bucket
    const text = await metrics.registry.metrics();
    // 1ms lands in le="0.001" AND every larger bucket (cumulative).
    expect(text).toMatch(
      /clawreview_review_filter_report_read_duration_seconds_bucket\{[^}]*le="0\.001"[^}]*\}\s*1/,
    );
    // 45ms is below 0.05, so the le="0.05" bucket holds both samples
    // (1ms also counts because cumulative).
    expect(text).toMatch(
      /clawreview_review_filter_report_read_duration_seconds_bucket\{[^}]*le="0\.05"[^}]*\}\s*2/,
    );
  });

  it('pairs cleanly with the counter (same shape label, same fire discipline)', async () => {
    // The route fires the counter and the histogram on the SAME 200
    // path; a divergence between the two breaks the dashboard join.
    // This test pins the contract: when an operator hits N full + M
    // slim reads, both series carry exactly N + M samples.
    resetMetricsForTests();
    const { observeReviewFilterReportRead, observeReviewFilterReportReadDuration } =
      await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrd-6', defaultMetrics: false });
    for (let i = 0; i < 4; i++) {
      observeReviewFilterReportRead(metrics, false);
      observeReviewFilterReportReadDuration(metrics, false, 0.01);
    }
    for (let i = 0; i < 2; i++) {
      observeReviewFilterReportRead(metrics, true);
      observeReviewFilterReportReadDuration(metrics, true, 0.005);
    }
    const text = await metrics.registry.metrics();
    // Counter:  4 full + 2 slim.
    const counterFull = text.match(
      /clawreview_review_filter_report_reads_total\{[^}]*shape="full"[^}]*\}\s*(\d+)/,
    );
    const counterSlim = text.match(
      /clawreview_review_filter_report_reads_total\{[^}]*shape="slim"[^}]*\}\s*(\d+)/,
    );
    expect(Number(counterFull![1])).toBe(4);
    expect(Number(counterSlim![1])).toBe(2);
    // Histogram: count series matches the counter.
    const histFull = text.match(
      /clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="full"[^}]*\}\s*(\d+)/,
    );
    const histSlim = text.match(
      /clawreview_review_filter_report_read_duration_seconds_count\{[^}]*shape="slim"[^}]*\}\s*(\d+)/,
    );
    expect(Number(histFull![1])).toBe(4);
    expect(Number(histSlim![1])).toBe(2);
  });
});

// Tick 25: clawreview_review_filter_report_diff_total{result} counter
// for the CLI `review filter-report --diff` two-review compare.
// Pair-of-helpers test surface mirrors deriveReviewDriftWatchResult +
// observeReviewDriftWatchPoll so the test patterns are uniform across
// the two CLI-driven counters.
describe('deriveReviewFilterReportDiffResult (tick 25)', () => {
  it('returns identical when fetchOk=true and delta.hasDelta=false', async () => {
    const { deriveReviewFilterReportDiffResult } = await import('../src/metrics.js');
    expect(deriveReviewFilterReportDiffResult(true, { hasDelta: false })).toBe('identical');
  });

  it('returns delta when fetchOk=true and delta.hasDelta=true', async () => {
    const { deriveReviewFilterReportDiffResult } = await import('../src/metrics.js');
    expect(deriveReviewFilterReportDiffResult(true, { hasDelta: true })).toBe('delta');
  });

  it('returns error when fetchOk=false regardless of delta shape', async () => {
    const { deriveReviewFilterReportDiffResult } = await import('../src/metrics.js');
    // A failed fetch / parse should always count as error, even if
    // the caller somehow carried a stale delta from earlier code.
    expect(deriveReviewFilterReportDiffResult(false, { hasDelta: true })).toBe('error');
    expect(deriveReviewFilterReportDiffResult(false, { hasDelta: false })).toBe('error');
    expect(deriveReviewFilterReportDiffResult(false, null)).toBe('error');
  });

  it('returns error when fetchOk=true but delta is null (parse failure)', async () => {
    const { deriveReviewFilterReportDiffResult } = await import('../src/metrics.js');
    expect(deriveReviewFilterReportDiffResult(true, null)).toBe('error');
  });

  it('REVIEW_FILTER_REPORT_DIFF_RESULTS exports the closed three-value set', async () => {
    const { REVIEW_FILTER_REPORT_DIFF_RESULTS } = await import('../src/metrics.js');
    // Frozen tuple so a typo at a call site won't compile against
    // the union type. We assert the exact membership so a future
    // accidental widening (a fourth value) is caught here.
    expect([...REVIEW_FILTER_REPORT_DIFF_RESULTS]).toEqual(['identical', 'delta', 'error']);
  });
});

describe('observeReviewFilterReportDiff (tick 25)', () => {
  it('bumps the counter under identical when fetchOk=true + no delta', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportDiff } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewFilterReportDiff(metrics, true, { hasDelta: false });
    observeReviewFilterReportDiff(metrics, true, { hasDelta: false });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_review_filter_report_diff_total\{[^}]*result="identical"[^}]*\}\s*2/);
  });

  it('bumps the counter under delta when fetchOk=true + hasDelta', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportDiff } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewFilterReportDiff(metrics, true, { hasDelta: true });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_review_filter_report_diff_total\{[^}]*result="delta"[^}]*\}\s*1/);
  });

  it('bumps the counter under error when fetchOk=false', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportDiff } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewFilterReportDiff(metrics, false, null);
    observeReviewFilterReportDiff(metrics, false, { hasDelta: true });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_review_filter_report_diff_total\{[^}]*result="error"[^}]*\}\s*2/);
  });

  it('counts every invocation separately across the three result buckets (no spillover)', async () => {
    // A mixed CI fleet: 4 identical, 2 delta, 1 error. Every bucket
    // should carry its own count; the buckets should not interfere.
    resetMetricsForTests();
    const { observeReviewFilterReportDiff } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewFilterReportDiff(metrics, true, { hasDelta: false });
    observeReviewFilterReportDiff(metrics, true, { hasDelta: false });
    observeReviewFilterReportDiff(metrics, true, { hasDelta: false });
    observeReviewFilterReportDiff(metrics, true, { hasDelta: false });
    observeReviewFilterReportDiff(metrics, true, { hasDelta: true });
    observeReviewFilterReportDiff(metrics, true, { hasDelta: true });
    observeReviewFilterReportDiff(metrics, false, null);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/clawreview_review_filter_report_diff_total\{[^}]*result="identical"[^}]*\}\s*4/);
    expect(text).toMatch(/clawreview_review_filter_report_diff_total\{[^}]*result="delta"[^}]*\}\s*2/);
    expect(text).toMatch(/clawreview_review_filter_report_diff_total\{[^}]*result="error"[^}]*\}\s*1/);
  });
});

// Tick 26: per-invocation latency histogram for `review filter-report
// --diff`. Pairs with the tick-25 counter under the same closed
// `result` label so a PromQL join-on-result lines up.
describe('observeReviewFilterReportDiffDuration (tick 26)', () => {
  it('records a sample under the identical bucket and the count goes up', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportDiffDuration } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewFilterReportDiffDuration(metrics, true, { hasDelta: false }, 0.05);
    observeReviewFilterReportDiffDuration(metrics, true, { hasDelta: false }, 0.12);
    const text = await metrics.registry.metrics();
    // Prometheus's text format emits _count / _sum for each label set.
    expect(text).toMatch(
      /clawreview_review_filter_report_diff_duration_seconds_count\{[^}]*result="identical"[^}]*\}\s*2/,
    );
  });

  it('records under the delta bucket when fetchOk=true + hasDelta=true', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportDiffDuration } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewFilterReportDiffDuration(metrics, true, { hasDelta: true }, 0.4);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_filter_report_diff_duration_seconds_count\{[^}]*result="delta"[^}]*\}\s*1/,
    );
  });

  it('records under the error bucket when fetchOk=false (delta=null does not crash)', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportDiffDuration } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewFilterReportDiffDuration(metrics, false, null, 0.02);
    observeReviewFilterReportDiffDuration(metrics, false, { hasDelta: true }, 0.03);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_filter_report_diff_duration_seconds_count\{[^}]*result="error"[^}]*\}\s*2/,
    );
  });

  it('clamps non-finite / negative durations to 0 so a clock-skew bug cannot poison the histogram', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportDiffDuration } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewFilterReportDiffDuration(metrics, true, { hasDelta: false }, -1);
    observeReviewFilterReportDiffDuration(metrics, true, { hasDelta: false }, NaN);
    observeReviewFilterReportDiffDuration(metrics, true, { hasDelta: false }, Infinity);
    const text = await metrics.registry.metrics();
    // All three samples land in the smallest bucket (0.01s); the
    // sum should be exactly 0 (three zero observations).
    const sumMatch = text.match(
      /clawreview_review_filter_report_diff_duration_seconds_sum\{[^}]*result="identical"[^}]*\}\s*([\d.eE+-]+)/,
    );
    expect(sumMatch).not.toBeNull();
    expect(Number(sumMatch?.[1] ?? 'NaN')).toBe(0);
  });

  it('joins cleanly with the tick-25 counter on the same `result` label (parallel fire reconciles)', async () => {
    // The whole point of the duration histogram is that a dashboard
    // can read (count, sum) per result label and divide them with
    // the tick-25 counter's series to derive avg-latency-per-outcome.
    // This test pins that the two share an identical result label
    // alphabet so a PromQL `on (result)` join works without rewrites.
    resetMetricsForTests();
    const { observeReviewFilterReportDiff, observeReviewFilterReportDiffDuration } =
      await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    // Mirror a real diff invocation: fire counter + duration with the
    // same (fetchOk, delta) tuple. The CLI does this through fireExit;
    // here we exercise the pair directly.
    observeReviewFilterReportDiff(metrics, true, { hasDelta: true });
    observeReviewFilterReportDiffDuration(metrics, true, { hasDelta: true }, 0.2);
    observeReviewFilterReportDiff(metrics, true, { hasDelta: false });
    observeReviewFilterReportDiffDuration(metrics, true, { hasDelta: false }, 0.05);
    observeReviewFilterReportDiff(metrics, false, null);
    observeReviewFilterReportDiffDuration(metrics, false, null, 0.02);
    const text = await metrics.registry.metrics();
    // The label values appearing on the histogram match the counter's.
    for (const result of ['identical', 'delta', 'error']) {
      expect(text).toContain(`result="${result}"`);
    }
    // Histogram _count tuples reconcile per result.
    expect(text).toMatch(
      /clawreview_review_filter_report_diff_duration_seconds_count\{[^}]*result="identical"[^}]*\}\s*1/,
    );
    expect(text).toMatch(
      /clawreview_review_filter_report_diff_duration_seconds_count\{[^}]*result="delta"[^}]*\}\s*1/,
    );
    expect(text).toMatch(
      /clawreview_review_filter_report_diff_duration_seconds_count\{[^}]*result="error"[^}]*\}\s*1/,
    );
  });

  it('histogram bucket boundaries cover sub-25ms through 5s (CI runner range)', async () => {
    // Pin the bucket definition so a future tweak that drops the
    // 0.01s lower bound (which would mean fast invocations all stack
    // in `le=0.025`) or the 5s upper bound (which would mean slow
    // ones land in `+Inf` and we lose visibility) regresses the test.
    resetMetricsForTests();
    const { observeReviewFilterReportDiffDuration } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    observeReviewFilterReportDiffDuration(metrics, true, { hasDelta: false }, 0.005);
    const text = await metrics.registry.metrics();
    // The smallest bucket should exist as `le="0.01"` (sub-25ms work
    // happens locally on a hot path); the largest finite as `le="5"`.
    expect(text).toContain('le="0.01"');
    expect(text).toContain('le="5"');
  });
});

// Tick 27: deriveReviewFilterReportProjection + observeReviewFilterReportReadProjection
// -- per-projection-mode counter for /api/reviews/:id/filter-report. Pairs
// with tick-23's per-shape counter (full|slim) but adds a third axis
// (fields) that the per-shape series collapses into 'full'.
describe('deriveReviewFilterReportProjection (tick 27)', () => {
  it('slim=false, fields=false -> full (default response, no projection)', async () => {
    const { deriveReviewFilterReportProjection } = await import('../src/metrics.js');
    expect(deriveReviewFilterReportProjection(false, false)).toBe('full');
  });

  it('slim=true, fields=false -> slim (collapsing projection)', async () => {
    const { deriveReviewFilterReportProjection } = await import('../src/metrics.js');
    expect(deriveReviewFilterReportProjection(true, false)).toBe('slim');
  });

  it('slim=false, fields=true -> fields (allowlist / deny-list projection)', async () => {
    const { deriveReviewFilterReportProjection } = await import('../src/metrics.js');
    expect(deriveReviewFilterReportProjection(false, true)).toBe('fields');
  });

  it('defensive both-true (mutex check should have caught this upstream) -> slim wins (safer default)', async () => {
    const { deriveReviewFilterReportProjection } = await import('../src/metrics.js');
    expect(deriveReviewFilterReportProjection(true, true)).toBe('slim');
  });

  it('REVIEW_FILTER_REPORT_PROJECTIONS is the closed tuple [full, slim, fields]', async () => {
    const { REVIEW_FILTER_REPORT_PROJECTIONS } = await import('../src/metrics.js');
    expect(REVIEW_FILTER_REPORT_PROJECTIONS).toEqual(['full', 'slim', 'fields']);
  });
});

describe('observeReviewFilterReportReadProjection (tick 27)', () => {
  afterEach(() => resetMetricsForTests());

  it('fires the full counter when slim=false, fields=false', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportReadProjection } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrp-1', defaultMetrics: false });
    observeReviewFilterReportReadProjection(metrics, false, false);
    observeReviewFilterReportReadProjection(metrics, false, false);
    const text = await metrics.registry.metrics();
    const match = text.match(
      /clawreview_review_filter_report_reads_projection_total\{[^}]*projection="full"[^}]*\}\s*(\d+)/,
    );
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(2);
  });

  it('fires the slim counter when slim=true', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportReadProjection } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrp-2', defaultMetrics: false });
    observeReviewFilterReportReadProjection(metrics, true, false);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /clawreview_review_filter_report_reads_projection_total\{[^}]*projection="slim"[^}]*\}\s*1/,
    );
  });

  it('fires the fields counter when fields=true', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportReadProjection } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrp-3', defaultMetrics: false });
    observeReviewFilterReportReadProjection(metrics, false, true);
    observeReviewFilterReportReadProjection(metrics, false, true);
    observeReviewFilterReportReadProjection(metrics, false, true);
    const text = await metrics.registry.metrics();
    const match = text.match(
      /clawreview_review_filter_report_reads_projection_total\{[^}]*projection="fields"[^}]*\}\s*(\d+)/,
    );
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(3);
  });

  it('three projections accumulate independently (no cross-fire)', async () => {
    resetMetricsForTests();
    const { observeReviewFilterReportReadProjection } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrp-4', defaultMetrics: false });
    for (let i = 0; i < 5; i++) observeReviewFilterReportReadProjection(metrics, false, false); // full
    for (let i = 0; i < 3; i++) observeReviewFilterReportReadProjection(metrics, true, false);  // slim
    for (let i = 0; i < 2; i++) observeReviewFilterReportReadProjection(metrics, false, true);  // fields
    const text = await metrics.registry.metrics();
    const full = text.match(
      /clawreview_review_filter_report_reads_projection_total\{[^}]*projection="full"[^}]*\}\s*(\d+)/,
    );
    const slim = text.match(
      /clawreview_review_filter_report_reads_projection_total\{[^}]*projection="slim"[^}]*\}\s*(\d+)/,
    );
    const fields = text.match(
      /clawreview_review_filter_report_reads_projection_total\{[^}]*projection="fields"[^}]*\}\s*(\d+)/,
    );
    expect(Number(full![1])).toBe(5);
    expect(Number(slim![1])).toBe(3);
    expect(Number(fields![1])).toBe(2);
    // Total reconciles
    expect(Number(full![1]) + Number(slim![1]) + Number(fields![1])).toBe(10);
  });

  it('reconciles with tick-23 reviewFilterReportReadsTotal when both fire on same request', async () => {
    // The route layer fires BOTH counters on each accepted 200. A
    // dashboard joining them must see consistent counts: tick-23 sees
    // (full | slim), tick-27 sees (full | slim | fields) where the
    // fields-projection reads contribute to tick-23's 'full' bucket
    // (because the response body shape is still full when ?fields is in play).
    resetMetricsForTests();
    const {
      observeReviewFilterReportRead,
      observeReviewFilterReportReadProjection,
    } = await import('../src/metrics.js');
    const metrics = getMetrics({ service: 'clawreview-frrp-5', defaultMetrics: false });
    // Simulate 3 default-full + 2 slim + 4 fields reads.
    for (let i = 0; i < 3; i++) {
      observeReviewFilterReportRead(metrics, false);
      observeReviewFilterReportReadProjection(metrics, false, false);
    }
    for (let i = 0; i < 2; i++) {
      observeReviewFilterReportRead(metrics, true);
      observeReviewFilterReportReadProjection(metrics, true, false);
    }
    for (let i = 0; i < 4; i++) {
      observeReviewFilterReportRead(metrics, false); // fields-projection still surfaces as full SHAPE
      observeReviewFilterReportReadProjection(metrics, false, true);
    }
    const text = await metrics.registry.metrics();
    // Tick-23: full=7 (3 default + 4 fields), slim=2
    const shapeFull = text.match(/clawreview_review_filter_report_reads_total\{[^}]*shape="full"[^}]*\}\s*(\d+)/);
    const shapeSlim = text.match(/clawreview_review_filter_report_reads_total\{[^}]*shape="slim"[^}]*\}\s*(\d+)/);
    expect(Number(shapeFull![1])).toBe(7);
    expect(Number(shapeSlim![1])).toBe(2);
    // Tick-27: full=3 (default only), slim=2, fields=4
    const projFull = text.match(/clawreview_review_filter_report_reads_projection_total\{[^}]*projection="full"[^}]*\}\s*(\d+)/);
    const projSlim = text.match(/clawreview_review_filter_report_reads_projection_total\{[^}]*projection="slim"[^}]*\}\s*(\d+)/);
    const projFields = text.match(/clawreview_review_filter_report_reads_projection_total\{[^}]*projection="fields"[^}]*\}\s*(\d+)/);
    expect(Number(projFull![1])).toBe(3);
    expect(Number(projSlim![1])).toBe(2);
    expect(Number(projFields![1])).toBe(4);
    // Cross-series invariant: tick-23.full == tick-27.full + tick-27.fields
    // (fields projection produces full-shape responses).
    expect(Number(shapeFull![1])).toBe(Number(projFull![1]) + Number(projFields![1]));
    // And tick-23.slim == tick-27.slim
    expect(Number(shapeSlim![1])).toBe(Number(projSlim![1]));
  });
});


