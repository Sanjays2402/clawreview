import {
  compareSeverity,
  type Finding,
  type FindingCategory,
  type Severity,
  SEVERITY_ORDER,
} from '@clawreview/types';

import { findingDigest } from './digest.js';

export interface AggregateOptions {
  threshold?: Severity;
  maxPerFile?: number;
  /** Lines distance to treat two findings as duplicates. */
  dedupRadius?: number;
  /**
   * Floor on a finding's `confidence` field. Findings strictly below
   * this value are dropped, regardless of severity. Independent of the
   * `calibrateConfidence` pass: calibration NUDGES severity (and adds
   * a `calibrated:*` tag); `minConfidence` HARD-DROPS noise that is so
   * low-confidence it shouldn't reach the reviewer at all.
   *
   * Default `0` (no floor). A typical production knob lands around
   * `0.25-0.4` -- low enough to keep most genuine findings, high
   * enough to silence a model that hallucinates a `severity: medium`
   * with `confidence: 0.1`.
   *
   * Findings dropped here are not counted toward `maxPerFile` so the
   * cap continues to mean "best N per file" rather than "first N to
   * survive the floor".
   */
  minConfidence?: number;
}

export interface AggregateResult {
  findings: Finding[];
  groupedByFile: Array<{ file: string; findings: Finding[] }>;
  totals: Record<Severity, number>;
  /**
   * Count of surviving findings grouped by category. Useful for the PR
   * comment breakdown, dashboard charts, and metrics exporters that want
   * to slice findings without re-walking the array.
   */
  categoryTotals: Partial<Record<FindingCategory, number>>;
  /** Count of surviving findings grouped by the producing agent. */
  agentTotals: Record<string, number>;
}

export function dedupFindings(input: Finding[], radius = 2): Finding[] {
  const seen: Finding[] = [];
  const accepted: Finding[] = [];
  for (const f of input) {
    const dupIdx = seen.findIndex(
      (s) =>
        s.file === f.file &&
        s.category === f.category &&
        Math.abs(s.startLine - f.startLine) <= radius &&
        similar(s.title, f.title),
    );
    if (dupIdx === -1) {
      seen.push(f);
      accepted.push(f);
      continue;
    }
    const existing = seen[dupIdx]!;
    if (preferOver(f, existing)) {
      seen[dupIdx] = f;
      const acceptedIdx = accepted.indexOf(existing);
      if (acceptedIdx >= 0) accepted[acceptedIdx] = f;
    }
  }
  return accepted;
}

function preferOver(a: Finding, b: Finding): boolean {
  const sev = compareSeverity(a.severity, b.severity);
  if (sev !== 0) return sev < 0;
  return a.confidence > b.confidence;
}

function similar(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;
  const wa = na.split(' ').filter(Boolean);
  const wb = nb.split(' ').filter(Boolean);
  const minWords = Math.min(wa.length, wb.length);
  if (minWords === 0) return false;
  const overlap = sharedWords(wa, wb);
  return overlap / minWords >= 0.6;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sharedWords(wa: string[], wb: string[]): number {
  const setB = new Set(wb);
  let hits = 0;
  for (const w of wa) if (setB.has(w)) hits += 1;
  return hits;
}

/**
 * Clamp a confidence-shaped option into [0, 1]. Mirrors the helper in
 * `calibrate.ts`; kept local so this file's only cross-module dep
 * stays `@clawreview/types`.
 */
function clampConfidence(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Result of a standalone `applyMinConfidence` pass.
 *
 * `kept` is the findings that survived the floor (in input order);
 * `dropped` is everything that fell below it. Both arrays together
 * always reconstruct the input — useful for callers that want to count
 * drops separately (e.g. for telemetry) without re-running the filter.
 *
 * `threshold` is the effective floor used (after clamping into [0, 1]).
 * Callers that want to surface the actual cutoff to the user (logs, PR
 * comments) should read it from here, not from the raw config knob.
 */
export interface ApplyMinConfidenceResult {
  kept: Finding[];
  dropped: Finding[];
  threshold: number;
}

/**
 * Drop findings whose `confidence` falls strictly below `threshold`.
 *
 * Extracted from `aggregate()` so callers can run JUST the floor (and
 * count the drops) without re-running dedup, sort, and per-file capping.
 * Two real callers today:
 *
 *   - the worker emits `clawreview_findings_dropped_total{reason="min_confidence"}`
 *     from the dropped count BEFORE calling `aggregate()`, so the
 *     counter reflects findings the floor removed rather than findings
 *     the cap removed.
 *   - the CLI's stderr summary ("dropped N finding(s) below
 *     min_confidence=...") wants the same count without rebuilding the
 *     filter inline.
 *
 * Semantics match the inline path in `aggregate()`:
 *   - `threshold` is clamped into [0, 1] (NaN / negative / >1 are
 *     normalised), matching the runtime behaviour of `aggregate()`.
 *   - The comparison is `f.confidence >= threshold` (inclusive at the
 *     boundary), so `threshold: 0.5` keeps a finding with `confidence: 0.5`.
 *   - With `threshold: 0` everything passes through (no floor).
 *
 * Pure: never mutates the input array or its findings.
 */
export function applyMinConfidence(
  findings: Finding[],
  threshold: number,
): ApplyMinConfidenceResult {
  const t = clampConfidence(threshold);
  if (t === 0) {
    return { kept: [...findings], dropped: [], threshold: 0 };
  }
  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  for (const f of findings) {
    if (f.confidence >= t) kept.push(f);
    else dropped.push(f);
  }
  return { kept, dropped, threshold: t };
}

export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sev = compareSeverity(a.severity, b.severity);
    if (sev !== 0) return sev;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.startLine - b.startLine;
  });
}

export function aggregate(findings: Finding[], opts: AggregateOptions = {}): AggregateResult {
  const threshold = opts.threshold ?? 'low';
  const maxPerFile = opts.maxPerFile ?? 8;
  const radius = opts.dedupRadius ?? 2;
  // Floor low-confidence noise via the extracted helper so the floor
  // semantics are defined in exactly one place. `applyMinConfidence`
  // clamps the threshold into [0, 1] internally; we drop the result on
  // the floor and continue with the kept set.
  const floored = applyMinConfidence(findings, opts.minConfidence ?? 0);

  const filtered = floored.kept.filter(
    (f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[threshold],
  );
  const deduped = dedupFindings(filtered, radius);
  const ranked = rankFindings(deduped);

  const perFile = new Map<string, Finding[]>();
  for (const f of ranked) {
    const list = perFile.get(f.file) ?? [];
    if (list.length < maxPerFile) list.push(f);
    perFile.set(f.file, list);
  }

  const truncated = ranked.filter((f) => perFile.get(f.file)?.includes(f));

  const groupedByFile = [...perFile.entries()].map(([file, list]) => ({
    file,
    findings: list,
  }));

  const totals: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    nit: 0,
  };
  const categoryTotals: Partial<Record<FindingCategory, number>> = {};
  const agentTotals: Record<string, number> = {};
  for (const f of truncated) {
    totals[f.severity] += 1;
    categoryTotals[f.category] = (categoryTotals[f.category] ?? 0) + 1;
    agentTotals[f.agent] = (agentTotals[f.agent] ?? 0) + 1;
  }

  return { findings: truncated, groupedByFile, totals, categoryTotals, agentTotals };
}

/**
 * Re-derive `totals`, `categoryTotals`, `agentTotals`, and `groupedByFile`
 * on an `AggregateResult` whose `findings` array was mutated AFTER
 * `aggregate()` ran (typically by a post-aggregate suppression /
 * filter pass on the worker hot path).
 *
 * Why this exists: the worker runs `aggregate()` once, then walks the
 * surviving findings through `applySuppressions` (inline
 * `clawreview-ignore` markers) and assigns the kept set back to
 * `aggregated.findings`. Without re-deriving the counts, the rendered
 * PR comment header would show pre-suppression totals while the body
 * shows post-suppression findings -- a quiet drift that's hard to
 * notice until an operator audits a comment by hand.
 *
 * The counts are produced by `findingDigest()` so the PR comment,
 * the dashboard's review-store summary, and `clawreview stats` all
 * derive from the SAME helper. The previous worker code inlined its
 * own loop; if a future tick added a new bucket to `findingDigest`
 * the worker would silently fail to recompute it. Centralising here
 * makes that class of drift impossible.
 *
 * Mutating: writes into `result` in place because the worker passes
 * an already-built `AggregateResult` it owns. The function returns
 * the same reference so call sites can chain. Findings array itself
 * is NEVER mutated.
 *
 * `groupedByFile` is rebuilt from the kept findings in their existing
 * (post-suppression) order so the rendered comment renders files in
 * the same order it would have without the suppression pass.
 *
 * Pure semantics aside from the result mutation: idempotent.
 */
export function recomputeAggregateTotals<T extends AggregateResult>(result: T): T {
  // Reuse the digest helper so the worker, CLI, and dashboard all
  // ride on the same bucket arithmetic. We don't need the top-N
  // slices here -- the worker drops them on the floor -- so cap them
  // high enough that `byCategory` / `byAgent` are the only meaningful
  // outputs.
  const digest = findingDigest(result.findings, {
    topFiles: 1,
    topAgents: 1,
    topCategories: 1,
  });
  // Severity bucket assignment is exhaustive: `digest.totalsBySeverity`
  // always carries all five buckets, zero or not, so we can assign
  // directly instead of zeroing first.
  for (const k of Object.keys(result.totals) as Array<keyof typeof result.totals>) {
    result.totals[k] = digest.totalsBySeverity[k];
  }
  // Spread into a fresh object so the worker's previously-rendered
  // shape is replaced rather than appended to. A previously-set key
  // that no longer has any surviving findings (e.g. `'security': 3`
  // before suppression, zero after) must NOT linger as `'security': 0`
  // because the existing `aggregate()` contract treats absent keys as
  // "no findings in that bucket".
  result.categoryTotals = { ...digest.byCategory };
  result.agentTotals = { ...digest.byAgent };
  // Per-file grouping: walk the (post-suppression) findings in order
  // so the rendered comment surfaces files in the same insertion
  // order. `aggregate()` produces this via a Map; we mirror it.
  const perFile = new Map<string, Finding[]>();
  for (const f of result.findings) {
    const list = perFile.get(f.file) ?? [];
    list.push(f);
    perFile.set(f.file, list);
  }
  result.groupedByFile = [...perFile.entries()].map(([file, list]) => ({ file, findings: list }));
  return result;
}
