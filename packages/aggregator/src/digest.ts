import {
  SEVERITY_ORDER,
  type Finding,
  type FindingCategory,
  type Severity,
} from '@clawreview/types';

import { detectHotspots, type Hotspot, type HotspotOptions } from './hotspots.js';

/**
 * Result of a single pass over a `Finding[]` that pulls every shape a
 * dashboard, CLI, or PR comment renderer would otherwise re-derive on
 * its own.
 *
 * `findingDigest()` is intentionally *thin*: it does NOT dedupe,
 * threshold, calibrate, or floor. Run those passes upstream
 * (`aggregate`, `applyMinConfidence`, `calibrateConfidence`, ...) and
 * hand the surviving findings to `findingDigest` to get a numbers-only
 * summary. Doing the analytics in one pass keeps the CLI's `stats`
 * command, the worker's dashboard-feed code, and the PR comment header
 * agreeing exactly on counts — today every consumer inlines its own
 * `for` loop and they can quietly drift apart.
 */
export interface FindingDigest {
  /** Number of findings the digest summarised. */
  total: number;
  /**
   * Severity bucket counts. All five buckets are always present (zero
   * if absent) so a consumer can render a fixed-shape histogram without
   * defaulting each key.
   */
  totalsBySeverity: Record<Severity, number>;
  /**
   * Category bucket counts. Sparse: only categories that appeared in
   * the input are present. Sort the entries on the consumer side if a
   * deterministic order is needed.
   */
  byCategory: Partial<Record<FindingCategory, number>>;
  /** Agent bucket counts. Sparse for the same reason as `byCategory`. */
  byAgent: Record<string, number>;
  /** File bucket counts. Sparse. */
  byFile: Record<string, number>;
  /**
   * Top files by descending count, then by file path (ascending) on
   * ties. Capped at `opts.topFiles` (default 5, hard ceiling 200) so a
   * misconfigured caller can't ask the digest to render a multi-thousand
   * entry list. Always sorted; consumers can render directly.
   */
  topFiles: Array<{ file: string; count: number }>;
  /**
   * Optional hotspot clusters, computed via `findHotspots`. Off by
   * default (clustering walks the findings array a second time and not
   * every consumer wants the cost). Pass `opts.hotspots = true` to
   * enable, or `opts.hotspots = { ...HotspotOptions }` to forward
   * tuning knobs to the clusterer.
   *
   * When disabled, the field is omitted entirely rather than set to an
   * empty array so a JSON consumer can distinguish "did not compute"
   * from "computed and found none".
   */
  hotspots?: Hotspot[];
}

export interface FindingDigestOptions {
  /**
   * Cap on the rendered top-files list. Defaults to 5 (matches the CLI
   * `stats` text output). Hard ceiling 200 so a misconfigured caller
   * can't generate a multi-thousand-entry payload.
   */
  topFiles?: number;
  /**
   * When set, also compute hotspot clusters and attach them under
   * `digest.hotspots`. `true` uses the default `findHotspots` options;
   * an object value forwards those knobs through to the clusterer.
   */
  hotspots?: boolean | HotspotOptions;
}

const DEFAULT_TOP_FILES = 5;
const MAX_TOP_FILES = 200;

const EMPTY_SEVERITY_TOTALS: Record<Severity, number> = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  nit: 0,
};

/**
 * Walk a `Finding[]` once and return a digest with the shapes a
 * dashboard / CLI / PR-comment renderer needs.
 *
 * Pure: never mutates the input array or its findings.
 *
 * The output `topFiles` is always sorted (count desc, file asc on
 * ties); the bucket maps are insertion-order so callers should not
 * assume key order beyond that.
 */
export function findingDigest(
  findings: Finding[],
  opts: FindingDigestOptions = {},
): FindingDigest {
  const topFiles = Math.max(1, Math.min(MAX_TOP_FILES, opts.topFiles ?? DEFAULT_TOP_FILES));

  const totalsBySeverity: Record<Severity, number> = { ...EMPTY_SEVERITY_TOTALS };
  const byCategory: Partial<Record<FindingCategory, number>> = {};
  const byAgent: Record<string, number> = {};
  const byFile: Record<string, number> = {};

  for (const f of findings) {
    // Safe indexed access because `Severity` is the exact union the map
    // is keyed by; `noUncheckedIndexedAccess` would otherwise flag
    // `totalsBySeverity[f.severity]` as `number | undefined`.
    totalsBySeverity[f.severity] = (totalsBySeverity[f.severity] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    byAgent[f.agent] = (byAgent[f.agent] ?? 0) + 1;
    byFile[f.file] = (byFile[f.file] ?? 0) + 1;
  }

  const sortedFiles = Object.entries(byFile).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const topFilesList = sortedFiles.slice(0, topFiles).map(([file, count]) => ({ file, count }));

  const digest: FindingDigest = {
    total: findings.length,
    totalsBySeverity,
    byCategory,
    byAgent,
    byFile,
    topFiles: topFilesList,
  };

  if (opts.hotspots) {
    const hotspotOpts: HotspotOptions = typeof opts.hotspots === 'object' ? opts.hotspots : {};
    digest.hotspots = detectHotspots(findings, hotspotOpts);
  }

  return digest;
}

/**
 * Compare two severity buckets so consumers can render in canonical
 * order (critical first) without re-importing the severity constants.
 *
 * Re-exported for parity with `aggregate.ts`'s shape contract: every
 * helper that returns a `Record<Severity, _>` should pair with the
 * canonical iteration order.
 */
export function severityIterationOrder(): readonly Severity[] {
  return (['critical', 'high', 'medium', 'low', 'nit'] as Severity[]).slice().sort(
    (a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b],
  );
}
