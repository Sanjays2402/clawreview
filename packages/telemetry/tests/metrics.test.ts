import { afterEach, describe, expect, it } from 'vitest';

import {
  FINDING_DROP_REASONS,
  OPERATOR_POLL_BYPASS_REASONS,
  OPERATOR_POLL_RESULTS,
  WEBHOOK_STATS_WINDOW_MODES,
  deriveWebhookStatsWindowMode,
  getMetrics,
  observeAgentExecutions,
  observeAuthorAttribution,
  observeFindingsDropped,
  observeOperatorPoll,
  observeOperatorPollBypass,
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
