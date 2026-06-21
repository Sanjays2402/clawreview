import type { Finding } from '@clawreview/types';
import { describe, expect, it } from 'vitest';

import {
  computeDigestDrift,
  findingDigest,
  severityIterationOrder,
} from '../src/digest.js';

function f(over: Partial<Finding>): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'medium',
    title: 'Issue',
    rationale: 'Reason',
    file: 'src/x.ts',
    startLine: 10,
    confidence: 0.7,
    tags: [],
    ...over,
  } as Finding;
}

describe('findingDigest', () => {
  it('walks the input once and produces all bucket maps', () => {
    const findings = [
      f({ agent: 'security', category: 'security', severity: 'critical', file: 'src/a.ts' }),
      f({ agent: 'security', category: 'security', severity: 'high', file: 'src/a.ts', startLine: 20 }),
      f({ agent: 'style', category: 'style', severity: 'medium', file: 'src/b.ts' }),
      f({ agent: 'style', category: 'style', severity: 'nit', file: 'src/c.ts' }),
    ];

    const digest = findingDigest(findings);

    expect(digest.total).toBe(4);
    expect(digest.totalsBySeverity.critical).toBe(1);
    expect(digest.totalsBySeverity.high).toBe(1);
    expect(digest.totalsBySeverity.medium).toBe(1);
    expect(digest.totalsBySeverity.nit).toBe(1);
    expect(digest.totalsBySeverity.low).toBe(0);

    expect(digest.byAgent.security).toBe(2);
    expect(digest.byAgent.style).toBe(2);

    expect(digest.byCategory.security).toBe(2);
    expect(digest.byCategory.style).toBe(2);

    expect(digest.byFile['src/a.ts']).toBe(2);
    expect(digest.byFile['src/b.ts']).toBe(1);
  });

  it('returns a fixed-shape severity totals record even when buckets are empty', () => {
    const digest = findingDigest([]);
    expect(digest.total).toBe(0);
    expect(Object.keys(digest.totalsBySeverity).sort()).toEqual(
      ['critical', 'high', 'low', 'medium', 'nit'],
    );
    for (const v of Object.values(digest.totalsBySeverity)) {
      expect(v).toBe(0);
    }
    expect(digest.topFiles).toEqual([]);
    expect(digest.hotspots).toBeUndefined();
  });

  it('returns topFiles sorted by descending count then by file path', () => {
    const findings = [
      f({ file: 'src/b.ts' }),
      f({ file: 'src/a.ts' }),
      f({ file: 'src/a.ts', startLine: 20 }),
      f({ file: 'src/c.ts' }),
      f({ file: 'src/c.ts', startLine: 30 }),
    ];
    const digest = findingDigest(findings, { topFiles: 5 });
    // a and c are tied at 2; a sorts first alphabetically.
    expect(digest.topFiles[0]).toEqual({ file: 'src/a.ts', count: 2 });
    expect(digest.topFiles[1]).toEqual({ file: 'src/c.ts', count: 2 });
    expect(digest.topFiles[2]).toEqual({ file: 'src/b.ts', count: 1 });
  });

  it('caps topFiles at the requested limit', () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 20; i += 1) {
      findings.push(f({ file: `src/file-${String(i).padStart(2, '0')}.ts` }));
    }
    const digest = findingDigest(findings, { topFiles: 3 });
    expect(digest.topFiles).toHaveLength(3);
    // Every file has count 1, so sort is purely alphabetical.
    expect(digest.topFiles[0]!.file).toBe('src/file-00.ts');
    expect(digest.topFiles[1]!.file).toBe('src/file-01.ts');
    expect(digest.topFiles[2]!.file).toBe('src/file-02.ts');
  });

  it('clamps topFiles into [1, 200] so a hostile caller cannot disable or blow it up', () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 5; i += 1) {
      findings.push(f({ file: `src/file-${i}.ts` }));
    }
    const tooLow = findingDigest(findings, { topFiles: 0 });
    expect(tooLow.topFiles).toHaveLength(1);
    const negative = findingDigest(findings, { topFiles: -100 });
    expect(negative.topFiles).toHaveLength(1);
    const huge = findingDigest(findings, { topFiles: 10_000 });
    // Hard ceiling 200, but only 5 distinct files exist so we cap at 5.
    expect(huge.topFiles).toHaveLength(5);
  });

  it('omits the hotspots field when not requested (so JSON consumers can tell "not computed" from "empty")', () => {
    const digest = findingDigest([
      f({ file: 'src/a.ts', startLine: 10 }),
      f({ file: 'src/a.ts', startLine: 12 }),
      f({ file: 'src/a.ts', startLine: 14 }),
    ]);
    expect(digest.hotspots).toBeUndefined();
    expect('hotspots' in digest).toBe(false);
  });

  it('includes hotspots when opts.hotspots = true (uses default clusterer options)', () => {
    const findings = [
      f({ file: 'src/a.ts', startLine: 10, severity: 'high' }),
      f({ file: 'src/a.ts', startLine: 12, severity: 'medium' }),
      f({ file: 'src/a.ts', startLine: 14, severity: 'low' }),
      f({ file: 'src/b.ts', startLine: 200 }),
    ];
    const digest = findingDigest(findings, { hotspots: true });
    expect(digest.hotspots).toBeDefined();
    expect(digest.hotspots!.length).toBeGreaterThanOrEqual(1);
    const cluster = digest.hotspots![0]!;
    expect(cluster.file).toBe('src/a.ts');
    expect(cluster.count).toBeGreaterThanOrEqual(2);
  });

  it('forwards hotspot opts when opts.hotspots is an object', () => {
    const findings = [
      f({ file: 'src/a.ts', startLine: 10 }),
      f({ file: 'src/a.ts', startLine: 11 }),
      f({ file: 'src/b.ts', startLine: 10 }),
      f({ file: 'src/b.ts', startLine: 11 }),
    ];
    // limit=1 should trim to a single returned cluster.
    const digest = findingDigest(findings, { hotspots: { limit: 1, minFindings: 2 } });
    expect(digest.hotspots).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const findings = [
      f({ file: 'src/a.ts', startLine: 10 }),
      f({ file: 'src/a.ts', startLine: 20 }),
    ];
    const snapshot = findings.map((x) => ({ ...x }));
    findingDigest(findings, { hotspots: true });
    expect(findings.map((x) => ({ ...x }))).toEqual(snapshot);
  });

  it('byCategory is sparse: absent categories do not appear in the map', () => {
    const digest = findingDigest([f({ category: 'security' })]);
    expect(digest.byCategory.security).toBe(1);
    expect(digest.byCategory.performance).toBeUndefined();
    expect(Object.keys(digest.byCategory)).toEqual(['security']);
  });

  it('returns topAgents sorted by descending count then by agent name', () => {
    const findings = [
      f({ agent: 'security' }),
      f({ agent: 'security' }),
      f({ agent: 'style' }),
      f({ agent: 'secrets' }),
      f({ agent: 'secrets' }),
    ];
    const digest = findingDigest(findings, { topAgents: 5 });
    // security and secrets tied at 2; alphabetical sort puts secrets
    // first (s-e-c-r before s-e-c-u).
    expect(digest.topAgents[0]).toEqual({ agent: 'secrets', count: 2 });
    expect(digest.topAgents[1]).toEqual({ agent: 'security', count: 2 });
    expect(digest.topAgents[2]).toEqual({ agent: 'style', count: 1 });
  });

  it('caps topAgents at the requested limit and defaults to 10', () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 15; i += 1) {
      findings.push(f({ agent: `agent-${String(i).padStart(2, '0')}` }));
    }
    const explicit = findingDigest(findings, { topAgents: 3 });
    expect(explicit.topAgents).toHaveLength(3);
    expect(explicit.topAgents[0]!.agent).toBe('agent-00');
    // Default cap is 10 when --top-agents is omitted.
    const defaulted = findingDigest(findings);
    expect(defaulted.topAgents).toHaveLength(10);
    // Underlying byAgent map still carries everything; the cap is just
    // on the topAgents render slice.
    expect(Object.keys(defaulted.byAgent).length).toBe(15);
  });

  it('clamps topAgents into [1, 200] like topFiles', () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 4; i += 1) {
      findings.push(f({ agent: `agent-${i}` }));
    }
    const tooLow = findingDigest(findings, { topAgents: 0 });
    expect(tooLow.topAgents).toHaveLength(1);
    const negative = findingDigest(findings, { topAgents: -100 });
    expect(negative.topAgents).toHaveLength(1);
    const huge = findingDigest(findings, { topAgents: 10_000 });
    expect(huge.topAgents).toHaveLength(4);
  });

  it('returns topCategories sorted and capped', () => {
    const findings = [
      f({ category: 'security' }),
      f({ category: 'security' }),
      f({ category: 'style' }),
      f({ category: 'performance' }),
      f({ category: 'performance' }),
      f({ category: 'performance' }),
    ];
    const digest = findingDigest(findings, { topCategories: 2 });
    expect(digest.topCategories).toHaveLength(2);
    // performance > security > style ; top 2 are performance + security.
    expect(digest.topCategories[0]).toEqual({ category: 'performance', count: 3 });
    expect(digest.topCategories[1]).toEqual({ category: 'security', count: 2 });
    // The full sparse map is still on byCategory.
    expect(digest.byCategory.style).toBe(1);
  });
});

describe('severityIterationOrder', () => {
  it('returns the canonical critical-first order', () => {
    expect(severityIterationOrder()).toEqual(['critical', 'high', 'medium', 'low', 'nit']);
  });
});

// Tick 13: computeDigestDrift compares two findingDigest snapshots
// and surfaces the per-bucket delta. Use case: tick 12 persists
// `digest` on ReviewRecord; after a bulk dismiss the persisted shape
// drifts from the live findings. The dashboard / CLI calls this
// helper to surface "review header counts are stale" without
// re-walking findings.
describe('computeDigestDrift', () => {
  it('returns hasDrift=false and zero deltas for two byte-identical digests', () => {
    // The canonical "no drift" case: a freshly-persisted digest
    // compared with a fresh recompute against the same findings.
    // Every bucket delta is zero; hasDrift is false.
    const findings = [
      f({ agent: 'security', category: 'security', severity: 'high', file: 'a.ts' }),
      f({ agent: 'style', category: 'style', severity: 'nit', file: 'b.ts' }),
    ];
    const persisted = findingDigest(findings, { topAgents: 8, topCategories: 8 });
    const fresh = findingDigest(findings, { topAgents: 8, topCategories: 8 });
    const drift = computeDigestDrift(persisted, fresh);
    expect(drift.hasDrift).toBe(false);
    expect(drift.totalDelta).toBe(0);
    expect(drift.bySeverityDelta).toEqual({
      critical: 0, high: 0, medium: 0, low: 0, nit: 0,
    });
    expect(drift.byAgentDelta).toEqual({});
    expect(drift.byCategoryDelta).toEqual({});
    expect(drift.byFileDelta).toEqual({});
  });

  it('reports a negative delta when findings are dropped after persist (bulk dismiss)', () => {
    // Concrete scenario: dashboard persisted 3 findings; operator
    // bulk-dismissed 1; fresh recompute shows 2. The drift report
    // surfaces totalDelta=-1 and the dropped finding's per-bucket
    // attribution.
    const persistedFindings = [
      f({ agent: 'security', category: 'security', severity: 'high', file: 'a.ts' }),
      f({ agent: 'security', category: 'security', severity: 'medium', file: 'a.ts', startLine: 11 }),
      f({ agent: 'style', category: 'style', severity: 'nit', file: 'b.ts' }),
    ];
    const freshFindings = [
      f({ agent: 'security', category: 'security', severity: 'high', file: 'a.ts' }),
      f({ agent: 'style', category: 'style', severity: 'nit', file: 'b.ts' }),
    ];
    const persisted = findingDigest(persistedFindings);
    const fresh = findingDigest(freshFindings);
    const drift = computeDigestDrift(persisted, fresh);
    expect(drift.hasDrift).toBe(true);
    expect(drift.totalDelta).toBe(-1);
    // The dropped finding was medium severity, security agent + category, on a.ts.
    expect(drift.bySeverityDelta.medium).toBe(-1);
    // Other severities are still in the fixed-shape histogram at 0.
    expect(drift.bySeverityDelta.high).toBe(0);
    expect(drift.bySeverityDelta.nit).toBe(0);
    // Sparse maps surface only the changed key.
    expect(drift.byAgentDelta).toEqual({ security: -1 });
    expect(drift.byCategoryDelta).toEqual({ security: -1 });
    expect(drift.byFileDelta).toEqual({ 'a.ts': -1 });
  });

  it('reports a positive delta when fresh findings appeared after persist (rerun added findings)', () => {
    // Opposite scenario: a rerun produced 1 extra finding that the
    // persisted shape never saw. Drift is +1 across the relevant
    // buckets.
    const persistedFindings = [
      f({ agent: 'security', category: 'security', severity: 'high', file: 'a.ts' }),
    ];
    const freshFindings = [
      f({ agent: 'security', category: 'security', severity: 'high', file: 'a.ts' }),
      f({ agent: 'perf', category: 'performance', severity: 'low', file: 'c.ts' }),
    ];
    const persisted = findingDigest(persistedFindings);
    const fresh = findingDigest(freshFindings);
    const drift = computeDigestDrift(persisted, fresh);
    expect(drift.hasDrift).toBe(true);
    expect(drift.totalDelta).toBe(1);
    expect(drift.bySeverityDelta.low).toBe(1);
    expect(drift.byAgentDelta).toEqual({ perf: 1 });
    expect(drift.byCategoryDelta).toEqual({ performance: 1 });
    expect(drift.byFileDelta).toEqual({ 'c.ts': 1 });
  });

  it('mixes positive and negative deltas when findings shift between buckets (severity recalibration)', () => {
    // A calibration pass might promote a finding from medium ->
    // high. The total stays the same, but per-severity buckets
    // shift: medium goes -1, high goes +1.
    const persistedFindings = [
      f({ agent: 'security', category: 'security', severity: 'medium', file: 'a.ts' }),
    ];
    const freshFindings = [
      f({ agent: 'security', category: 'security', severity: 'high', file: 'a.ts' }),
    ];
    const persisted = findingDigest(persistedFindings);
    const fresh = findingDigest(freshFindings);
    const drift = computeDigestDrift(persisted, fresh);
    expect(drift.hasDrift).toBe(true);
    expect(drift.totalDelta).toBe(0);
    expect(drift.bySeverityDelta.high).toBe(1);
    expect(drift.bySeverityDelta.medium).toBe(-1);
    // Agent / category / file all stayed the same so no entries
    // in those sparse maps.
    expect(drift.byAgentDelta).toEqual({});
    expect(drift.byCategoryDelta).toEqual({});
    expect(drift.byFileDelta).toEqual({});
  });

  it('omits zero-delta keys from the sparse bucket maps so the rendered drift focuses on changes', () => {
    // Two findings change: one drops out, one appears. The agents
    // that stayed unchanged (style on b.ts) must NOT appear in
    // byAgentDelta -- only `security` (which dropped) and `perf`
    // (which appeared) show up.
    const persistedFindings = [
      f({ agent: 'security', category: 'security', severity: 'high', file: 'a.ts' }),
      f({ agent: 'style', category: 'style', severity: 'nit', file: 'b.ts' }),
    ];
    const freshFindings = [
      f({ agent: 'perf', category: 'performance', severity: 'low', file: 'c.ts' }),
      f({ agent: 'style', category: 'style', severity: 'nit', file: 'b.ts' }),
    ];
    const persisted = findingDigest(persistedFindings);
    const fresh = findingDigest(freshFindings);
    const drift = computeDigestDrift(persisted, fresh);
    expect(drift.byAgentDelta).toEqual({ security: -1, perf: 1 });
    // `style` is in BOTH digests with count 1 -> delta 0 -> omitted.
    expect('style' in drift.byAgentDelta).toBe(false);
  });

  it('is symmetric: computeDigestDrift(a, b) negates computeDigestDrift(b, a)', () => {
    // Mathematical contract: swapping the two arguments inverts
    // every delta but preserves the hasDrift flag.
    const findings1 = [
      f({ agent: 'security', severity: 'high', file: 'a.ts' }),
    ];
    const findings2 = [
      f({ agent: 'security', severity: 'high', file: 'a.ts' }),
      f({ agent: 'style', severity: 'nit', file: 'b.ts' }),
    ];
    const d1 = findingDigest(findings1);
    const d2 = findingDigest(findings2);
    const ab = computeDigestDrift(d1, d2);
    const ba = computeDigestDrift(d2, d1);
    expect(ab.totalDelta).toBe(-ba.totalDelta);
    expect(ab.bySeverityDelta.nit).toBe(-ba.bySeverityDelta.nit);
    expect(ab.byAgentDelta.style).toBe(-ba.byAgentDelta.style);
    expect(ab.byFileDelta['b.ts']).toBe(-ba.byFileDelta['b.ts']);
    // hasDrift is identical in both directions (any-non-zero check).
    expect(ab.hasDrift).toBe(ba.hasDrift);
  });

  it('does not consider hotspots when computing drift (clusters re-derive on fresh)', () => {
    // Two findings on the same file produce a hotspot cluster. The
    // persisted digest was built WITHOUT hotspots; the fresh one
    // WITH hotspots. The drift report cares only about bucket
    // counts (which agree), not derived cluster shapes -- so
    // hasDrift is false.
    const findings = [
      f({ agent: 'security', severity: 'high', file: 'src/hot.ts', startLine: 10 }),
      f({ agent: 'security', severity: 'medium', file: 'src/hot.ts', startLine: 12 }),
    ];
    const persisted = findingDigest(findings, { hotspots: false });
    const fresh = findingDigest(findings, { hotspots: true });
    // Sanity: hotspots field genuinely differs between the two.
    expect(persisted.hotspots).toBeUndefined();
    expect(fresh.hotspots).toBeDefined();
    // Drift report ignores the hotspots difference because the
    // underlying bucket counts agree.
    const drift = computeDigestDrift(persisted, fresh);
    expect(drift.hasDrift).toBe(false);
    expect(drift.totalDelta).toBe(0);
  });

  it('does not mutate either input digest', () => {
    // Defensive: a drift consumer may persist the digest to a DB
    // or render it elsewhere. Mutating the input would break the
    // "snapshot is immutable" contract that tick 12 set up.
    const findings1 = [
      f({ agent: 'security', severity: 'high', file: 'a.ts' }),
    ];
    const findings2 = [
      f({ agent: 'security', severity: 'low', file: 'a.ts' }),
    ];
    const d1 = findingDigest(findings1);
    const d2 = findingDigest(findings2);
    const d1Snapshot = JSON.stringify(d1);
    const d2Snapshot = JSON.stringify(d2);
    computeDigestDrift(d1, d2);
    expect(JSON.stringify(d1)).toBe(d1Snapshot);
    expect(JSON.stringify(d2)).toBe(d2Snapshot);
  });

  it('handles an empty persisted digest (fresh review with all-new findings)', () => {
    // A review that persisted no findings (digest.total = 0) and
    // later acquired some. Edge case: the persisted byAgent /
    // byCategory / byFile maps are empty objects but the fresh
    // side has entries. Drift is positive across every bucket.
    const persisted = findingDigest([]);
    const freshFindings = [
      f({ agent: 'security', category: 'security', severity: 'high', file: 'a.ts' }),
    ];
    const fresh = findingDigest(freshFindings);
    const drift = computeDigestDrift(persisted, fresh);
    expect(drift.hasDrift).toBe(true);
    expect(drift.totalDelta).toBe(1);
    expect(drift.bySeverityDelta.high).toBe(1);
    expect(drift.byAgentDelta).toEqual({ security: 1 });
    expect(drift.byCategoryDelta).toEqual({ security: 1 });
    expect(drift.byFileDelta).toEqual({ 'a.ts': 1 });
  });

  it('handles an empty fresh digest (everything dismissed; totalDelta = -persisted.total)', () => {
    // Mirror case: the operator bulk-dismissed every finding. The
    // fresh digest is empty; the persisted side has entries. Drift
    // is negative across every bucket.
    const persistedFindings = [
      f({ agent: 'security', severity: 'high', file: 'a.ts' }),
      f({ agent: 'security', severity: 'medium', file: 'a.ts', startLine: 11 }),
    ];
    const persisted = findingDigest(persistedFindings);
    const fresh = findingDigest([]);
    const drift = computeDigestDrift(persisted, fresh);
    expect(drift.hasDrift).toBe(true);
    expect(drift.totalDelta).toBe(-2);
    expect(drift.bySeverityDelta.high).toBe(-1);
    expect(drift.bySeverityDelta.medium).toBe(-1);
    expect(drift.byAgentDelta).toEqual({ security: -2 });
    expect(drift.byFileDelta).toEqual({ 'a.ts': -2 });
  });

  it('ignores topAgents / topCategories cap differences (compares underlying buckets, not slices)', () => {
    // Two digests built from the same findings but with different
    // top-N caps end up with different topAgents arrays. The drift
    // report must NOT flag this as drift -- the underlying byAgent
    // map is identical.
    const findings = [];
    for (let i = 0; i < 5; i += 1) {
      findings.push(f({ agent: `agent-${i}`, file: `f-${i}.ts` }));
    }
    const persisted = findingDigest(findings, { topAgents: 2 });
    const fresh = findingDigest(findings, { topAgents: 5 });
    // Sanity: the slices DO differ.
    expect(persisted.topAgents.length).not.toBe(fresh.topAgents.length);
    // ... but drift is false because the buckets agree.
    const drift = computeDigestDrift(persisted, fresh);
    expect(drift.hasDrift).toBe(false);
  });
});
