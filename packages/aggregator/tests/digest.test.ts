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

describe('findingDigest byTag bucket (tick 14)', () => {
  it('groups findings into per-tag buckets, multi-tag findings count once per tag', () => {
    const findings = [
      f({ tags: ['owasp:a01', 'security'], file: 'a.ts' }),
      f({ tags: ['owasp:a01'], file: 'b.ts' }),
      f({ tags: ['security'], file: 'c.ts' }),
    ];
    const digest = findingDigest(findings);
    // owasp:a01 appears on f0 + f1 -> count 2; security on f0 + f2 -> 2.
    expect(digest.byTag['owasp:a01']).toBe(2);
    expect(digest.byTag['security']).toBe(2);
    // Sum of buckets exceeds total when findings carry multiple tags.
    const bucketSum = Object.values(digest.byTag).reduce((a, b) => a + b, 0);
    expect(bucketSum).toBe(4);
    expect(digest.total).toBe(3);
  });

  it('routes findings with empty tags into the (untagged) sentinel bucket', () => {
    const findings = [
      f({ tags: [] }),
      f({ tags: [] }),
      f({ tags: ['real-tag'] }),
    ];
    const digest = findingDigest(findings);
    expect(digest.byTag['(untagged)']).toBe(2);
    expect(digest.byTag['real-tag']).toBe(1);
  });

  it('drops empty / whitespace-only tag entries silently (sloppy producer defense)', () => {
    const findings = [
      f({ tags: ['real', '', '   ', 'other'] }),
      f({ tags: ['   '] }), // ALL entries whitespace -> degrades to (untagged)
    ];
    const digest = findingDigest(findings);
    expect(digest.byTag['real']).toBe(1);
    expect(digest.byTag['other']).toBe(1);
    expect(digest.byTag['']).toBeUndefined();
    expect(digest.byTag['   ']).toBeUndefined();
    // Pure-whitespace tags array degrades to (untagged) so a sloppy
    // producer doesn't get its findings silently dropped from the
    // tag panel.
    expect(digest.byTag['(untagged)']).toBe(1);
  });

  it('emits an empty byTag when findings is empty (matches the other sparse maps)', () => {
    const digest = findingDigest([]);
    expect(digest.byTag).toEqual({});
  });

  it('UNTAGGED_BUCKET export is the literal "(untagged)" so consumers can avoid hard-coding', async () => {
    const mod = await import('../src/digest.js');
    expect(mod.UNTAGGED_BUCKET).toBe('(untagged)');
    // And the symbol is reachable through the package re-export.
    const pkg = await import('../src/index.js');
    expect((pkg as { UNTAGGED_BUCKET?: string }).UNTAGGED_BUCKET).toBe('(untagged)');
  });
});

describe('computeDigestDrift byTagDelta (tick 14)', () => {
  it('surfaces per-tag deltas (sparse, omits zeros)', () => {
    const persisted = findingDigest([
      f({ tags: ['owasp:a01'], file: 'a.ts' }),
      f({ tags: ['owasp:a01'], file: 'b.ts' }),
    ]);
    const fresh = findingDigest([
      f({ tags: ['owasp:a01'], file: 'a.ts' }),
      f({ tags: ['owasp:a07'], file: 'b.ts' }), // tag changed
    ]);
    const drift = computeDigestDrift(persisted, fresh);
    // owasp:a01: 2 -> 1 (delta -1). owasp:a07: absent -> 1 (delta +1).
    expect(drift.byTagDelta['owasp:a01']).toBe(-1);
    expect(drift.byTagDelta['owasp:a07']).toBe(1);
    expect(drift.hasDrift).toBe(true);
  });

  it('a (untagged) -> tagged transition surfaces as drift on both buckets', () => {
    // An operator landed a tag-rule that re-classified previously-untagged
    // findings. Drift should flag the (untagged) drop AND the new tag rise
    // so the dashboard "stale?" banner triggers.
    const persisted = findingDigest([f({ tags: [] }), f({ tags: [] })]);
    const fresh = findingDigest([f({ tags: ['new-rule'] }), f({ tags: ['new-rule'] })]);
    const drift = computeDigestDrift(persisted, fresh);
    expect(drift.byTagDelta['(untagged)']).toBe(-2);
    expect(drift.byTagDelta['new-rule']).toBe(2);
    expect(drift.hasDrift).toBe(true);
  });

  it('tolerates a legacy persisted digest with no byTag (treats absent as empty)', () => {
    // Pre-tick-14 digests don't have byTag. computeDigestDrift must
    // degrade gracefully and treat each new tag as a positive delta
    // rather than throwing on the sparseDelta walk.
    const persistedFindings = [f({ tags: ['legacy-tag'] })];
    const freshFindings = [f({ tags: ['legacy-tag'] })];
    const persistedRaw = findingDigest(persistedFindings);
    const fresh = findingDigest(freshFindings);
    // Synthesize a legacy persisted by deleting byTag.
    const persisted = { ...persistedRaw } as unknown as Record<string, unknown>;
    delete persisted['byTag'];
    const drift = computeDigestDrift(
      persisted as unknown as ReturnType<typeof findingDigest>,
      fresh,
    );
    // Because persisted treats absent as empty, every fresh tag is a
    // positive delta -- legacy-tag: 1.
    expect(drift.byTagDelta['legacy-tag']).toBe(1);
    expect(drift.hasDrift).toBe(true);
  });

  it('agreeing tag buckets do not flag drift', () => {
    const findings = [
      f({ tags: ['ok'], file: 'a.ts' }),
      f({ tags: ['ok'], file: 'b.ts' }),
    ];
    const drift = computeDigestDrift(findingDigest(findings), findingDigest(findings));
    expect(drift.byTagDelta).toEqual({});
    expect(drift.hasDrift).toBe(false);
  });
});

describe('findingDigest topTags slice (tick 15)', () => {
  it('returns topTags sorted by descending count then by tag name on ties', () => {
    const findings = [
      f({ tags: ['security'] }),
      f({ tags: ['security'] }),
      f({ tags: ['perf'] }),
      f({ tags: ['accessibility'] }),
      f({ tags: ['accessibility'] }),
    ];
    const digest = findingDigest(findings, { topTags: 5 });
    // accessibility and security tied at 2; alphabetical sort puts
    // accessibility first.
    expect(digest.topTags[0]).toEqual({ tag: 'accessibility', count: 2 });
    expect(digest.topTags[1]).toEqual({ tag: 'security', count: 2 });
    expect(digest.topTags[2]).toEqual({ tag: 'perf', count: 1 });
  });

  it('caps topTags at the requested limit and defaults to 10', () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 15; i += 1) {
      findings.push(f({ tags: [`tag-${String(i).padStart(2, '0')}`] }));
    }
    const explicit = findingDigest(findings, { topTags: 3 });
    expect(explicit.topTags).toHaveLength(3);
    expect(explicit.topTags[0]!.tag).toBe('tag-00');
    // Default cap is 10 when topTags is omitted, matching the other
    // top-N caps.
    const defaulted = findingDigest(findings);
    expect(defaulted.topTags).toHaveLength(10);
    // Underlying byTag map still carries everything; the cap is just
    // on the topTags render slice.
    expect(Object.keys(defaulted.byTag).length).toBe(15);
  });

  it('clamps topTags into [1, 200] like topFiles / topAgents / topCategories', () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 4; i += 1) {
      findings.push(f({ tags: [`tag-${i}`] }));
    }
    const tooLow = findingDigest(findings, { topTags: 0 });
    expect(tooLow.topTags).toHaveLength(1);
    const negative = findingDigest(findings, { topTags: -100 });
    expect(negative.topTags).toHaveLength(1);
    const huge = findingDigest(findings, { topTags: 10_000 });
    expect(huge.topTags).toHaveLength(4);
  });

  it('includes the (untagged) sentinel in topTags ranked by count alongside real tags', () => {
    // Many untagged findings, fewer real-tag findings -> (untagged)
    // should outrank `real-tag` and appear FIRST in topTags. This is
    // the "most of my findings have no tag" dashboard signal the slice
    // is meant to surface.
    const findings = [
      f({ tags: [] }),
      f({ tags: [] }),
      f({ tags: [] }),
      f({ tags: ['real-tag'] }),
    ];
    const digest = findingDigest(findings, { topTags: 5 });
    expect(digest.topTags[0]).toEqual({ tag: '(untagged)', count: 3 });
    expect(digest.topTags[1]).toEqual({ tag: 'real-tag', count: 1 });
  });

  it('emits an empty topTags slice when findings is empty', () => {
    const digest = findingDigest([]);
    expect(digest.topTags).toEqual([]);
    expect(digest.byTag).toEqual({});
  });

  it('multi-tag findings contribute to each tag bucket exactly once for sort ordering', () => {
    // A single finding with three tags should bump all three tag
    // counts; the sort within topTags should treat them symmetrically.
    const findings = [
      f({ tags: ['a', 'b', 'c'] }),
      f({ tags: ['a'] }),
      f({ tags: ['b'] }),
    ];
    const digest = findingDigest(findings, { topTags: 5 });
    // a appears on f0 + f1 = 2; b appears on f0 + f2 = 2; c on f0 = 1.
    expect(digest.topTags[0]).toEqual({ tag: 'a', count: 2 });
    expect(digest.topTags[1]).toEqual({ tag: 'b', count: 2 });
    expect(digest.topTags[2]).toEqual({ tag: 'c', count: 1 });
    // The slice agrees with the underlying byTag bucket counts.
    expect(digest.byTag['a']).toBe(2);
    expect(digest.byTag['b']).toBe(2);
    expect(digest.byTag['c']).toBe(1);
  });
});

describe('findingDigest topAuthors slice (tick 17)', () => {
  // Inline BlameMap fixture builder so the tests don't have to import
  // the full authors module surface; mirrors the shape of
  // `attributeFindingsToAuthors`'s input.
  const blame = (entries: Array<[file: string, line: number, name: string, email: string]>): Map<
    string,
    { authorName: string; authorEmail: string }
  > => {
    const m = new Map<string, { authorName: string; authorEmail: string }>();
    for (const [file, line, authorName, authorEmail] of entries) {
      m.set(`${file}:${line}`, { authorName, authorEmail });
    }
    return m;
  };

  it('omits topAuthors entirely when opts.blame is not supplied', () => {
    const findings = [f({ file: 'src/a.ts', startLine: 1 })];
    const digest = findingDigest(findings);
    // Sentinel: the field stays undefined, not [], so a JSON consumer
    // can tell "no blame attempted" from "blame attempted, empty".
    expect(digest.topAuthors).toBeUndefined();
  });

  it('returns topAuthors ranked by count when blame is supplied', () => {
    const findings = [
      f({ file: 'src/a.ts', startLine: 1 }),
      f({ file: 'src/a.ts', startLine: 2 }),
      f({ file: 'src/a.ts', startLine: 3 }),
      f({ file: 'src/b.ts', startLine: 1 }),
    ];
    const blameMap = blame([
      ['src/a.ts', 1, 'Alice', 'alice@ex.com'],
      ['src/a.ts', 2, 'Alice', 'alice@ex.com'],
      ['src/a.ts', 3, 'Bob', 'bob@ex.com'],
      ['src/b.ts', 1, 'Bob', 'bob@ex.com'],
    ]);
    const digest = findingDigest(findings, { blame: blameMap });
    expect(digest.topAuthors).toEqual([
      { authorName: 'Alice', authorEmail: 'alice@ex.com', count: 2 },
      { authorName: 'Bob', authorEmail: 'bob@ex.com', count: 2 },
    ]);
  });

  it('tie-breaks on email (ascending) so identical-display-name authors stay deterministic', () => {
    // Two authors with the same display name but different emails;
    // tie-break MUST be on email so a downstream dashboard sees a
    // stable ordering across recomputes.
    const findings = [
      f({ file: 'src/a.ts', startLine: 1 }),
      f({ file: 'src/a.ts', startLine: 2 }),
    ];
    const blameMap = blame([
      ['src/a.ts', 1, 'Sam', 'zeta@ex.com'],
      ['src/a.ts', 2, 'Sam', 'alpha@ex.com'],
    ]);
    const digest = findingDigest(findings, { blame: blameMap });
    expect(digest.topAuthors).toEqual([
      { authorName: 'Sam', authorEmail: 'alpha@ex.com', count: 1 },
      { authorName: 'Sam', authorEmail: 'zeta@ex.com', count: 1 },
    ]);
  });

  it('includes the (unknown) sentinel for findings outside the blame map', () => {
    // src/a.ts:1 is in blame; src/missing.ts:5 is NOT -> (unknown) bucket.
    const findings = [
      f({ file: 'src/a.ts', startLine: 1 }),
      f({ file: 'src/missing.ts', startLine: 5 }),
      f({ file: 'src/missing.ts', startLine: 6 }),
    ];
    const blameMap = blame([['src/a.ts', 1, 'Alice', 'alice@ex.com']]);
    const digest = findingDigest(findings, { blame: blameMap });
    // (unknown) has 2 findings, Alice has 1; (unknown) ranks first.
    expect(digest.topAuthors).toHaveLength(2);
    expect(digest.topAuthors![0]).toEqual({
      authorName: '(unknown)',
      authorEmail: '',
      count: 2,
    });
    expect(digest.topAuthors![1]).toEqual({
      authorName: 'Alice',
      authorEmail: 'alice@ex.com',
      count: 1,
    });
  });

  it('caps topAuthors at the requested limit and defaults to 10', () => {
    const findings: Finding[] = [];
    const entries: Array<[string, number, string, string]> = [];
    for (let i = 0; i < 15; i += 1) {
      const file = `src/file-${i}.ts`;
      findings.push(f({ file, startLine: 1 }));
      // Pad the name so alphabetical tie-break is deterministic.
      const tag = String(i).padStart(2, '0');
      entries.push([file, 1, `Author-${tag}`, `author-${tag}@ex.com`]);
    }
    const blameMap = blame(entries);
    const explicit = findingDigest(findings, { blame: blameMap, topAuthors: 3 });
    expect(explicit.topAuthors).toHaveLength(3);
    // Default cap is 10 -- matches the other top-N defaults.
    const defaulted = findingDigest(findings, { blame: blameMap });
    expect(defaulted.topAuthors).toHaveLength(10);
  });

  it('clamps topAuthors into [1, 200]', () => {
    const findings = [
      f({ file: 'src/a.ts', startLine: 1 }),
      f({ file: 'src/b.ts', startLine: 1 }),
    ];
    const blameMap = blame([
      ['src/a.ts', 1, 'Alice', 'alice@ex.com'],
      ['src/b.ts', 1, 'Bob', 'bob@ex.com'],
    ]);
    const tooLow = findingDigest(findings, { blame: blameMap, topAuthors: 0 });
    expect(tooLow.topAuthors).toHaveLength(1);
    const negative = findingDigest(findings, { blame: blameMap, topAuthors: -50 });
    expect(negative.topAuthors).toHaveLength(1);
    const huge = findingDigest(findings, { blame: blameMap, topAuthors: 5_000 });
    expect(huge.topAuthors).toHaveLength(2);
  });

  it('returns an empty array when blame is supplied but findings is empty', () => {
    // The contract: blame supplied -> field PRESENT (empty array).
    // No blame -> field OMITTED. This distinction lets a JSON
    // consumer reliably check `'topAuthors' in digest` to know
    // whether attribution was attempted.
    const digest = findingDigest([], { blame: blame([]) });
    expect(digest.topAuthors).toEqual([]);
  });
});

