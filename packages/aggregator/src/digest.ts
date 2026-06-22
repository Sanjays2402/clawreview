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
   * Tag bucket counts. Sparse: only tags that appeared on at least one
   * finding are present. A single finding can contribute to MULTIPLE
   * tag buckets (one per `finding.tags[i]`); a finding with no tags is
   * counted under the synthetic `'(untagged)'` bucket so a dashboard
   * panel rendering `byTag` always sums to >= `total` (the bucket sum
   * equals total when every finding has 0 or 1 tags; it grows beyond
   * total as findings accumulate multiple tags).
   *
   * Use case: tags are how callers attach cross-cutting labels --
   * "owasp:a01", "needs-followup", a config preset's `tag:` audit note
   * (see ClawReviewConfig.severity_rules.actions.tag). A dashboard
   * panel keyed by tag answers "how many findings touched the
   * `owasp:a07` policy this week?" without re-walking findings.
   *
   * The synthetic `'(untagged)'` bucket is the closed sentinel for
   * findings that ship with `tags: []`. Wrapped in parens so it can
   * never collide with a user-supplied tag (no real tag can start
   * with `(` -- the convention is `namespace:value` or `kebab-case`).
   */
  byTag: Record<string, number>;
  /**
   * Top files by descending count, then by file path (ascending) on
   * ties. Capped at `opts.topFiles` (default 5, hard ceiling 200) so a
   * misconfigured caller can't ask the digest to render a multi-thousand
   * entry list. Always sorted; consumers can render directly.
   */
  topFiles: Array<{ file: string; count: number }>;
  /**
   * Top agents by descending count, then by agent name (ascending) on
   * ties. Capped at `opts.topAgents` (default 10, hard ceiling 200).
   * Mirror of `topFiles` so the CLI's `stats --by agent --top-agents n`
   * (and the worker's PR comment header) can render an already-sorted
   * slice without re-walking the `byAgent` map.
   *
   * Always sorted; consumers can render directly. The full unsliced
   * map is still on `byAgent` for callers that want it.
   */
  topAgents: Array<{ agent: string; count: number }>;
  /**
   * Top categories by descending count, then by category (ascending)
   * on ties. Capped at `opts.topCategories` (default 10, hard ceiling
   * 200). Same rationale as `topAgents` -- the CLI's `stats --by
   * category --top-categories n` consumes this directly so the worker
   * and the CLI render identical numbers.
   */
  topCategories: Array<{ category: FindingCategory; count: number }>;
  /**
   * Top tags by descending count, then by tag (ascending) on ties.
   * Capped at `opts.topTags` (default 10, hard ceiling 200). Mirror
   * of topAgents / topCategories / topFiles -- a dashboard panel
   * keyed by tag wants the pre-sorted top-N slice without filtering
   * the sparse `byTag` map itself.
   *
   * Includes the synthetic `'(untagged)'` bucket when it has a
   * non-zero count; consumers that want to hide it can `.filter()`
   * against the exported `UNTAGGED_BUCKET` constant. We keep it in
   * by default because "how many findings were untagged?" is a real
   * dashboard signal (a tag-rule landed and reduced untagged volume
   * is a normal trend to chart).
   *
   * Always sorted; consumers can render directly. The full unsliced
   * map is still on `byTag` for callers that want it.
   */
  topTags: Array<{ tag: string; count: number }>;
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
   * Cap on the rendered top-agents list. Defaults to 10 (matches the
   * CLI `stats --by agent` text output). Hard ceiling 200 -- same
   * shape contract as topFiles.
   */
  topAgents?: number;
  /**
   * Cap on the rendered top-categories list. Defaults to 10 (matches
   * the CLI `stats --by category` text output). Hard ceiling 200.
   */
  topCategories?: number;
  /**
   * Cap on the rendered top-tags list. Defaults to 10 (matches the
   * shape of topAgents / topCategories). Hard ceiling 200 -- same
   * contract as the other top-N caps.
   */
  topTags?: number;
  /**
   * When set, also compute hotspot clusters and attach them under
   * `digest.hotspots`. `true` uses the default `findHotspots` options;
   * an object value forwards those knobs through to the clusterer.
   */
  hotspots?: boolean | HotspotOptions;
}

const DEFAULT_TOP_FILES = 5;
const DEFAULT_TOP_AGENTS = 10;
const DEFAULT_TOP_CATEGORIES = 10;
const DEFAULT_TOP_TAGS = 10;
const MAX_TOP = 200;

/**
 * Sentinel bucket key for findings that ship without any tags.
 *
 * Public + frozen so a dashboard / CLI consumer can compare against
 * the canonical value without hard-coding the literal:
 *
 *     import { UNTAGGED_BUCKET } from '@clawreview/aggregator';
 *     const untagged = digest.byTag[UNTAGGED_BUCKET] ?? 0;
 *
 * Wrapped in parens so it can never collide with a real tag (the
 * established tag convention is `namespace:value` or `kebab-case`,
 * neither of which can start with `(`).
 */
export const UNTAGGED_BUCKET = '(untagged)';

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
  const topFiles = Math.max(1, Math.min(MAX_TOP, opts.topFiles ?? DEFAULT_TOP_FILES));
  const topAgents = Math.max(1, Math.min(MAX_TOP, opts.topAgents ?? DEFAULT_TOP_AGENTS));
  const topCategories = Math.max(
    1,
    Math.min(MAX_TOP, opts.topCategories ?? DEFAULT_TOP_CATEGORIES),
  );
  const topTags = Math.max(1, Math.min(MAX_TOP, opts.topTags ?? DEFAULT_TOP_TAGS));

  const totalsBySeverity: Record<Severity, number> = { ...EMPTY_SEVERITY_TOTALS };
  const byCategory: Partial<Record<FindingCategory, number>> = {};
  const byAgent: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  const byTag: Record<string, number> = {};

  for (const f of findings) {
    // Safe indexed access because `Severity` is the exact union the map
    // is keyed by; `noUncheckedIndexedAccess` would otherwise flag
    // `totalsBySeverity[f.severity]` as `number | undefined`.
    totalsBySeverity[f.severity] = (totalsBySeverity[f.severity] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    byAgent[f.agent] = (byAgent[f.agent] ?? 0) + 1;
    byFile[f.file] = (byFile[f.file] ?? 0) + 1;
    // Tags: each finding contributes one bucket per tag (or one
    // `(untagged)` bucket when `tags` is empty). The sentinel string
    // uses parens so it can never collide with a user-supplied tag
    // (no real tag can start with `(` -- the established convention
    // is `namespace:value` or `kebab-case`). Empty / pure-whitespace
    // tag values are dropped so a sloppy producer doesn't widen the
    // bucket map with bogus keys; they're treated like `(untagged)`
    // only when the WHOLE tags array degrades to empty.
    const realTags = (f.tags ?? []).filter((t) => typeof t === 'string' && t.trim().length > 0);
    if (realTags.length === 0) {
      byTag[UNTAGGED_BUCKET] = (byTag[UNTAGGED_BUCKET] ?? 0) + 1;
    } else {
      for (const tag of realTags) {
        byTag[tag] = (byTag[tag] ?? 0) + 1;
      }
    }
  }

  const sortedFiles = Object.entries(byFile).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const topFilesList = sortedFiles.slice(0, topFiles).map(([file, count]) => ({ file, count }));

  // Same sort order as topFiles: descending count, ascending key on
  // ties. Stable enough for a deterministic dashboard / CLI render.
  const sortedAgents = Object.entries(byAgent).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const topAgentsList = sortedAgents
    .slice(0, topAgents)
    .map(([agent, count]) => ({ agent, count }));

  // byCategory is keyed by the FindingCategory union; cast back when
  // building the list so downstream consumers see the typed shape.
  const sortedCategories = (
    Object.entries(byCategory) as Array<[FindingCategory, number]>
  ).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const topCategoriesList = sortedCategories
    .slice(0, topCategories)
    .map(([category, count]) => ({ category, count }));

  // Tags share the topFiles / topAgents sort: descending count,
  // ascending key on ties. The synthetic `(untagged)` bucket sorts
  // alongside real tags by count -- it can legitimately be the
  // most-populated bucket on a corpus where most findings ship
  // without tags, and that's a useful dashboard signal.
  const sortedTags = Object.entries(byTag).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const topTagsList = sortedTags
    .slice(0, topTags)
    .map(([tag, count]) => ({ tag, count }));

  const digest: FindingDigest = {
    total: findings.length,
    totalsBySeverity,
    byCategory,
    byAgent,
    byFile,
    byTag,
    topFiles: topFilesList,
    topAgents: topAgentsList,
    topCategories: topCategoriesList,
    topTags: topTagsList,
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

/**
 * Drift report: per-bucket delta between two `FindingDigest` snapshots.
 *
 * Use case (tick 13): tick 12 persists `digest` on `ReviewRecord` for
 * the dashboard. After a bulk dismiss / reopen, the persisted digest's
 * totals no longer match the live findings. A consumer (dashboard
 * banner, CLI export, future drift-alert metric) calls
 * `findingDigest(record.findings)` to get the fresh shape, hands both
 * digests to `computeDigestDrift`, and renders a "review header counts
 * are stale, refresh comment?" prompt without re-walking findings.
 *
 * The drift is INTENTIONALLY shallow at the top-level bucket maps
 * (mirrors `computePresetDelta`'s shallow contract on
 * `clawreview presets diff`). A nested change inside `topFiles[i]`
 * surfaces as "topFiles: changed"; the caller can drill into the
 * digest itself for fine-grained data.
 *
 * Shape:
 *   - `totalDelta`         -- fresh.total - persisted.total
 *   - `bySeverityDelta`    -- per-severity (fresh - persisted); zeros
 *                              kept for the fixed-shape histogram.
 *   - `byAgentDelta`       -- sparse: agent keys that changed (or
 *                              appear in only one side); zeros omitted.
 *   - `byCategoryDelta`    -- sparse, same shape.
 *   - `byFileDelta`        -- sparse, same shape.
 *   - `hasDrift`           -- true iff any of the above is non-empty
 *                              or carries a non-zero delta. The
 *                              dashboard's "stale?" check is a single
 *                              `report.hasDrift`.
 *
 * Pure: never mutates either input digest.
 */
export interface FindingDigestDrift {
  /** total delta = fresh.total - persisted.total. Negative = findings dropped. */
  totalDelta: number;
  /**
   * Per-severity delta. Fixed-shape (every severity present) so a
   * dashboard histogram can render without defaulting keys.
   * Positive = the fresh recompute has more findings of that severity;
   * negative = fewer; zero = no change.
   */
  bySeverityDelta: Record<Severity, number>;
  /**
   * Per-agent delta. Sparse: keys appear only when they exist in
   * either side AND the delta is non-zero. Zero-deltas are omitted
   * so a dashboard can render "agents that changed" without filtering.
   */
  byAgentDelta: Record<string, number>;
  /** Per-category delta. Sparse, same shape as byAgentDelta. */
  byCategoryDelta: Partial<Record<FindingCategory, number>>;
  /** Per-file delta. Sparse, same shape as byAgentDelta. */
  byFileDelta: Record<string, number>;
  /**
   * Per-tag delta. Sparse, same shape as byAgentDelta. Includes the
   * synthetic `'(untagged)'` bucket when its count differs between
   * snapshots, since "untagged-finding count changed" is a real drift
   * signal a dashboard should surface (e.g. a tag-rule landed and
   * re-classified previously-untagged findings).
   */
  byTagDelta: Record<string, number>;
  /**
   * True iff at least one bucket has a non-zero delta. The dashboard's
   * "stale?" check is a single `report.hasDrift` rather than a fold
   * over every bucket.
   */
  hasDrift: boolean;
}

const EMPTY_SEVERITY_DELTA: Record<Severity, number> = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  nit: 0,
};

/**
 * Compute the bucket-level drift between two FindingDigest snapshots.
 *
 * The conventional shape is `computeDigestDrift(persisted, fresh)`:
 * deltas are `fresh - persisted` so a positive delta means "the live
 * data has more than the persisted snapshot showed". This matches
 * the natural "what changed since we wrote it down" framing.
 *
 * The two digests may have different `topFiles` / `topAgents` / etc.
 * cap settings; this helper compares the underlying bucket maps
 * (`byAgent`, `byCategory`, `byFile`, `totalsBySeverity`), NOT the
 * sorted top-N slices, so a different cap doesn't trigger spurious
 * drift. The caller can compare slices directly if needed.
 *
 * Symmetric in that `computeDigestDrift(a, b)` and
 * `computeDigestDrift(b, a)` produce numerically-opposite deltas;
 * `hasDrift` is identical in both directions.
 *
 * Hotspots are intentionally NOT in the drift report. Hotspot
 * detection is a derived view (clustering passes over findings); a
 * drift consumer would compute hotspots on the fresh shape if they
 * needed the new cluster list, not by diffing the persisted clusters.
 */
export function computeDigestDrift(
  persisted: FindingDigest,
  fresh: FindingDigest,
): FindingDigestDrift {
  const totalDelta = fresh.total - persisted.total;

  // Severity: walk the closed five-value set so the output stays
  // fixed-shape even when both sides had zero of a bucket.
  const bySeverityDelta: Record<Severity, number> = { ...EMPTY_SEVERITY_DELTA };
  let severityChanged = false;
  for (const sev of Object.keys(EMPTY_SEVERITY_DELTA) as Severity[]) {
    const d = (fresh.totalsBySeverity[sev] ?? 0) - (persisted.totalsBySeverity[sev] ?? 0);
    bySeverityDelta[sev] = d;
    if (d !== 0) severityChanged = true;
  }

  // Agent / category / file: sparse maps. Walk the union of keys and
  // omit zero-deltas so the rendered drift focuses on what actually
  // changed.
  const byAgentDelta = sparseDelta(persisted.byAgent, fresh.byAgent);
  const byFileDelta = sparseDelta(persisted.byFile, fresh.byFile);
  const byCategoryDelta = sparseDelta(
    persisted.byCategory as Record<string, number>,
    fresh.byCategory as Record<string, number>,
  ) as Partial<Record<FindingCategory, number>>;
  // byTag may legitimately be missing on a digest persisted before
  // tick 14 (the field was added then). Treat absent as empty so
  // drift against legacy digests degrades to "every new tag is a
  // positive delta" rather than throwing on the sparseDelta walk.
  const byTagDelta = sparseDelta(
    persisted.byTag ?? {},
    fresh.byTag ?? {},
  );

  const hasDrift =
    totalDelta !== 0 ||
    severityChanged ||
    Object.keys(byAgentDelta).length > 0 ||
    Object.keys(byFileDelta).length > 0 ||
    Object.keys(byCategoryDelta).length > 0 ||
    Object.keys(byTagDelta).length > 0;

  return {
    totalDelta,
    bySeverityDelta,
    byAgentDelta,
    byCategoryDelta,
    byFileDelta,
    byTagDelta,
    hasDrift,
  };
}

/**
 * Internal: walk the union of two sparse `string -> number` bucket
 * maps and return the per-key delta, omitting zero-deltas so the
 * caller's rendered drift focuses on what actually changed.
 *
 * Reused by `computeDigestDrift` for the byAgent / byCategory / byFile
 * buckets which all share the same sparse contract. Kept module-internal
 * so the export surface stays minimal -- callers want the typed wrapper.
 */
function sparseDelta(
  persisted: Record<string, number>,
  fresh: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const allKeys = new Set<string>([
    ...Object.keys(persisted),
    ...Object.keys(fresh),
  ]);
  for (const k of allKeys) {
    const d = (fresh[k] ?? 0) - (persisted[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}
