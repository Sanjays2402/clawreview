/**
 * Tick 27: aggregator-side mirror of the CLI's `computeFilterReportDelta`
 * helper.
 *
 * The CLI shipped `computeFilterReportDelta` (and `FilterReportDelta`)
 * in tick 25 as a pure helper inside `apps/cli/src/commands/review.ts`.
 * That was the right home initially (the CLI was the only consumer),
 * but non-CLI consumers now want the same delta:
 *
 *   - a dashboard server that wants to render "filter shape changed"
 *     between two persisted filter-report bodies without shelling out
 *     to the CLI,
 *   - a webhook handler that wants to gate a CI pipeline on the delta
 *     bit without spawning a Node process,
 *   - a future review-store layer that wants to log the delta inline
 *     when a fresh worker run lands.
 *
 * The aggregator package is the natural home: it already owns
 * `findingDigestWithFilterReport` (the helper that BUILDS the
 * persisted filter-report shape) and `computeDigestDrift` (the
 * pure delta helper for the persisted digest). The filter-report
 * delta belongs in the same pure-helper neighborhood.
 *
 * Design choice: this helper accepts a STRUCTURALLY-TYPED body shape
 * (NOT the CLI's `FilterReportBody` union) so the aggregator package
 * doesn't pull a dependency on `apps/cli`. The structural type is
 * permissive: it only requires the fields this helper actually reads.
 * The CLI's existing `FilterReportBodyFull` / `FilterReportBodySlim`
 * are assignable to it. Callers (dashboard server, future webhook
 * handler) can pass the raw `/api/reviews/:id/filter-report` response
 * body verbatim.
 *
 * Back-compat: the CLI's `computeFilterReportDelta` is now a thin
 * delegator to this helper. The CLI's `FilterReportDelta` type
 * structurally matches `FilterReportDelta` here so existing test
 * surfaces (which import from `apps/cli/src/commands/review.ts`)
 * keep working byte-identically.
 */

/**
 * Tick 27: structurally-typed filter-report body shape accepted by
 * `computeFilterReportDelta`.
 *
 * Only requires the fields this helper reads:
 *   - `applied: boolean`   -- top-level applied bit
 *   - `inputTotal: number` -- pre-filter finding count
 *   - `droppedTotal: number` -- count the filter removed
 *   - `appliedFilters` (optional) -- per-axis detail; absent on slim bodies
 *
 * The CLI's `FilterReportBodyFull` / `FilterReportBodySlim` are
 * assignable to this shape. A dashboard server can pass the raw
 * `/api/reviews/:id/filter-report` response body verbatim.
 */
export interface FilterReportBodyLike {
  applied: boolean;
  inputTotal: number;
  droppedTotal: number;
  /**
   * Per-axis applied filters. Absent on slim bodies (the route's
   * `?slim=true` projection strips this). When absent, the per-axis
   * delta surfaces as base=null/target=null with changed=false (we
   * can't tell whether a slim consumer ran a filter on those axes).
   */
  appliedFilters?: {
    minConfidence: { applied: boolean; normalised: number };
    severityThreshold: { applied: boolean; normalised: string | null };
  };
}

/**
 * Tick 27: per-field delta between two filter-report bodies.
 *
 * Shape mirrors the CLI's `FilterReportDelta` (tick 25) so a CLI test
 * surface that imports from `apps/cli/src/commands/review.ts` and a
 * server test surface that imports from `@clawreview/aggregator`
 * type-check against the same shape.
 *
 * Each field tracks WHETHER it changed plus the before/after values so
 * a downstream consumer can render "min_confidence 0.5 -> 0.8" or
 * "severity_threshold added: high" without computing the delta itself.
 *
 * A bug-fix-only delta (no fields changed) returns hasDelta=false;
 * a CI gate that wants "did anything change?" reads one field.
 */
export interface FilterReportDelta {
  /** Top-level applied bit transition. */
  applied: { base: boolean; target: boolean; changed: boolean };
  /** Input total (pre-filter count). */
  inputTotal: { base: number; target: number; delta: number; changed: boolean };
  /** Dropped total (count of findings the filter removed). */
  droppedTotal: { base: number; target: number; delta: number; changed: boolean };
  /**
   * Min-confidence axis. Tracks the normalised threshold (the
   * resolved value the worker applied; the raw input is operator-
   * controlled and not stable for comparison). Threshold absence
   * (no filter on that axis) is represented as null.
   */
  minConfidence: { base: number | null; target: number | null; changed: boolean };
  /**
   * Severity-threshold axis. Same shape as minConfidence; threshold
   * absent on that axis is null.
   */
  severityThreshold: { base: string | null; target: string | null; changed: boolean };
  /** True if ANY field above carries changed=true. CI gate reads this. */
  hasDelta: boolean;
}

/**
 * Tick 27: compute the per-field delta between two filter-report
 * bodies. Pure (no IO, no mutation, no side effects) so it can be
 * tested without driving the HTTP layer.
 *
 * Slim bodies (no `appliedFilters`) are tolerated: the per-axis
 * deltas surface as base=null/target=null with changed=false, since
 * we can't tell whether a slim consumer ran a filter on those axes.
 * This keeps the helper symmetric across projection modes.
 *
 * Byte-identical to the CLI's tick-25 `computeFilterReportDelta`:
 * the CLI now delegates here. A change to this logic flows through
 * BOTH the CLI's `review filter-report --diff` command and any
 * non-CLI consumer (dashboard server, webhook handler) in lockstep.
 */
export function computeFilterReportDelta(
  base: FilterReportBodyLike,
  target: FilterReportBodyLike,
): FilterReportDelta {
  const appliedChanged = base.applied !== target.applied;
  const inputDelta = target.inputTotal - base.inputTotal;
  const droppedDelta = target.droppedTotal - base.droppedTotal;
  // Extract the per-axis thresholds; slim bodies carry no
  // appliedFilters object, so we read defensively.
  const baseFull = base.appliedFilters;
  const targetFull = target.appliedFilters;
  // Normalised values are the resolved thresholds the worker
  // actually applied. We compare on those (the raw input is
  // operator-controlled and not stable for comparison).
  const baseMinConf = baseFull && baseFull.minConfidence.applied
    ? baseFull.minConfidence.normalised
    : null;
  const targetMinConf = targetFull && targetFull.minConfidence.applied
    ? targetFull.minConfidence.normalised
    : null;
  const baseSev = baseFull && baseFull.severityThreshold.applied
    ? baseFull.severityThreshold.normalised
    : null;
  const targetSev = targetFull && targetFull.severityThreshold.applied
    ? targetFull.severityThreshold.normalised
    : null;
  const minConfChanged = baseMinConf !== targetMinConf;
  const sevChanged = baseSev !== targetSev;
  const hasDelta =
    appliedChanged ||
    inputDelta !== 0 ||
    droppedDelta !== 0 ||
    minConfChanged ||
    sevChanged;
  return {
    applied: { base: base.applied, target: target.applied, changed: appliedChanged },
    inputTotal: {
      base: base.inputTotal,
      target: target.inputTotal,
      delta: inputDelta,
      changed: inputDelta !== 0,
    },
    droppedTotal: {
      base: base.droppedTotal,
      target: target.droppedTotal,
      delta: droppedDelta,
      changed: droppedDelta !== 0,
    },
    minConfidence: { base: baseMinConf, target: targetMinConf, changed: minConfChanged },
    severityThreshold: { base: baseSev, target: targetSev, changed: sevChanged },
    hasDelta,
  };
}

/**
 * Tick 28: closed set of axis names on a `FilterReportDelta`. Frozen
 * so a downstream consumer (a Slack template builder, a webhook
 * fan-out router) cannot accidentally extend the set via `push`.
 *
 * Mirrors the ordering of `FilterReportDelta` keys: a per-axis
 * iteration consumes them in the same order the deep delta surfaces
 * them in the JSON output, so a CI dashboard alphabetising on the
 * label sees a stable column ordering.
 */
export const FILTER_REPORT_DELTA_AXES = [
  'applied',
  'inputTotal',
  'droppedTotal',
  'minConfidence',
  'severityThreshold',
] as const;
export type FilterReportDeltaAxis = (typeof FILTER_REPORT_DELTA_AXES)[number];

/**
 * Tick 28: compact summary of a `FilterReportDelta` suitable for a
 * Slack message body, an email subject line, or a webhook hook's
 * "what's the headline?" field.
 *
 * Where `FilterReportDelta` carries the full per-axis before/after
 * shape (for a CI dashboard that wants to render a side-by-side
 * comparison), `FilterReportDeltaSummary` collapses it down to:
 *
 *   - `hasDelta`: byte-identical mirror of the source delta's bit,
 *                 so a Slack template can short-circuit on "no delta"
 *                 without inspecting the changed-axis list.
 *   - `changedAxes`: ordered tuple of just the axis names that
 *                 flipped, in canonical order. Empty when hasDelta
 *                 is false. A Slack template iterates this list to
 *                 produce "Changed: inputTotal, severityThreshold".
 *   - `regression`: "did the target get noisier?" -- a positive
 *                 inputTotal delta OR a relaxed filter (applied
 *                 false->true is intent-ambiguous; applied true->false
 *                 means filter REMOVED, which is a regression for
 *                 noise control). Captured as a boolean so a
 *                 webhook router can route regressions to a
 *                 louder channel.
 *   - `bugFix`: the complement -- "did the target get quieter?"
 *                 negative inputTotal delta OR applied false->true.
 *                 Both `regression` and `bugFix` can be true at
 *                 once (e.g. applied flipped + inputTotal grew),
 *                 representing a mixed change.
 *
 * Pure: takes a delta, returns the summary. No IO, no mutation.
 *
 * Use case: a hook payload that ships to `--on-delta` carries the
 * full delta (verbose, structured); a hook payload that ships to
 * a Slack template carries the summary (compact, headline-shaped).
 * A future enhancement could surface the summary in the diff
 * command's text renderer as a one-line preamble.
 */
export interface FilterReportDeltaSummary {
  hasDelta: boolean;
  changedAxes: readonly FilterReportDeltaAxis[];
  /**
   * True when the target represents a "noisier" filter state:
   *   - inputTotal grew (more raw findings entering the pipeline);
   *   - OR the applied bit went true -> false (filter removed,
   *     so MORE findings make it through);
   *   - OR droppedTotal SHRANK while inputTotal stayed flat
   *     (the filter is letting more through).
   * NOT mutually exclusive with `bugFix` (a mixed change can flag
   * both axes); a downstream router that wants exclusive routing
   * should resolve precedence in its own logic.
   */
  regression: boolean;
  /**
   * True when the target represents a "quieter" filter state:
   *   - inputTotal shrank (real noise reduction at the source);
   *   - OR the applied bit went false -> true (filter added);
   *   - OR droppedTotal grew while inputTotal stayed flat (the
   *     filter is rejecting more).
   * See `regression` for the mutual-exclusivity note.
   */
  bugFix: boolean;
}

/**
 * Tick 28: compute a `FilterReportDeltaSummary` from a delta.
 *
 * Walks the delta's axes in canonical order and collects the names
 * of any with `changed=true` into `changedAxes`. The `regression`
 * and `bugFix` bits are derived from the input/dropped deltas and
 * the applied bit transition.
 *
 * Pure: takes a delta, returns the summary. No IO.
 *
 * Exported through the aggregator's public API so non-CLI consumers
 * (dashboard server, webhook router) can produce the same headline
 * shape the CLI uses without re-implementing the axis-flag walk.
 */
export function summariseFilterReportDelta(
  delta: FilterReportDelta,
): FilterReportDeltaSummary {
  const changedAxes: FilterReportDeltaAxis[] = [];
  if (delta.applied.changed) changedAxes.push('applied');
  if (delta.inputTotal.changed) changedAxes.push('inputTotal');
  if (delta.droppedTotal.changed) changedAxes.push('droppedTotal');
  if (delta.minConfidence.changed) changedAxes.push('minConfidence');
  if (delta.severityThreshold.changed) changedAxes.push('severityThreshold');
  // Regression bit: the target is "noisier" than the base.
  // Three sources:
  //   1. inputTotal grew (real noise increase),
  //   2. applied flipped TRUE -> FALSE (filter removed),
  //   3. droppedTotal shrank while inputTotal didn't grow (filter
  //      is letting more findings through).
  // Each is sufficient on its own; ORed together because any one
  // of them is a real regression signal a webhook router might
  // care about.
  const inputGrew = delta.inputTotal.delta > 0;
  const filterRemoved = delta.applied.base === true && delta.applied.target === false;
  const droppedShrankWithoutInputGrowth =
    delta.droppedTotal.delta < 0 && delta.inputTotal.delta <= 0;
  const regression = inputGrew || filterRemoved || droppedShrankWithoutInputGrowth;
  // Bug-fix bit: the target is "quieter" than the base. Symmetric:
  //   1. inputTotal shrank (real noise decrease),
  //   2. applied flipped FALSE -> TRUE (filter added),
  //   3. droppedTotal grew while inputTotal didn't shrink (filter
  //      is rejecting more).
  const inputShrank = delta.inputTotal.delta < 0;
  const filterAdded = delta.applied.base === false && delta.applied.target === true;
  const droppedGrewWithoutInputShrink =
    delta.droppedTotal.delta > 0 && delta.inputTotal.delta >= 0;
  const bugFix = inputShrank || filterAdded || droppedGrewWithoutInputShrink;
  return {
    hasDelta: delta.hasDelta,
    changedAxes: Object.freeze(changedAxes),
    regression,
    bugFix,
  };
}
