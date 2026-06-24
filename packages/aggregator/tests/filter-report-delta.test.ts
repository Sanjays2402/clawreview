import { describe, expect, it } from 'vitest';

import {
  computeFilterReportDelta,
  type FilterReportBodyLike,
} from '../src/filter-report-delta.js';

/**
 * Tick 27: tests for the aggregator-side `computeFilterReportDelta`
 * mirror.
 *
 * The CLI's tick-25 `computeFilterReportDelta` (in
 * `apps/cli/src/commands/review.ts`) has its own test surface
 * (review.test.ts). This file pins the AGGREGATOR-side helper's
 * shape independently so a non-CLI consumer (dashboard server,
 * webhook handler) can rely on the contract without importing the
 * CLI's tests.
 *
 * The helper is byte-identical to the CLI's: the CLI now delegates
 * here. These tests ALSO serve as the contract pin for the
 * delegation -- if the CLI's wrapper drifts, its tests catch it;
 * if the aggregator core drifts, these tests catch it.
 */

function makeBody(over: Partial<FilterReportBodyLike> = {}): FilterReportBodyLike {
  return {
    applied: true,
    inputTotal: 10,
    droppedTotal: 3,
    appliedFilters: {
      minConfidence: { applied: true, normalised: 0.5 },
      severityThreshold: { applied: false, normalised: null },
    },
    ...over,
  };
}

describe('computeFilterReportDelta (aggregator-side mirror, tick 27)', () => {
  it('identical bodies produce hasDelta=false with every axis changed=false', () => {
    const delta = computeFilterReportDelta(makeBody(), makeBody());
    expect(delta.hasDelta).toBe(false);
    expect(delta.applied.changed).toBe(false);
    expect(delta.inputTotal.changed).toBe(false);
    expect(delta.droppedTotal.changed).toBe(false);
    expect(delta.minConfidence.changed).toBe(false);
    expect(delta.severityThreshold.changed).toBe(false);
  });

  it('top-level applied bit flip surfaces in applied.changed AND hasDelta', () => {
    const delta = computeFilterReportDelta(
      makeBody({ applied: false }),
      makeBody({ applied: true }),
    );
    expect(delta.applied.base).toBe(false);
    expect(delta.applied.target).toBe(true);
    expect(delta.applied.changed).toBe(true);
    expect(delta.hasDelta).toBe(true);
  });

  it('inputTotal delta computes target - base (positive)', () => {
    const delta = computeFilterReportDelta(
      makeBody({ inputTotal: 10 }),
      makeBody({ inputTotal: 25 }),
    );
    expect(delta.inputTotal.base).toBe(10);
    expect(delta.inputTotal.target).toBe(25);
    expect(delta.inputTotal.delta).toBe(15);
    expect(delta.inputTotal.changed).toBe(true);
  });

  it('droppedTotal delta computes target - base (negative when filter relaxed)', () => {
    const delta = computeFilterReportDelta(
      makeBody({ droppedTotal: 8 }),
      makeBody({ droppedTotal: 3 }),
    );
    expect(delta.droppedTotal.delta).toBe(-5);
    expect(delta.droppedTotal.changed).toBe(true);
    expect(delta.hasDelta).toBe(true);
  });

  it('minConfidence normalised drift surfaces in minConfidence.changed', () => {
    const delta = computeFilterReportDelta(
      makeBody({
        appliedFilters: {
          minConfidence: { applied: true, normalised: 0.3 },
          severityThreshold: { applied: false, normalised: null },
        },
      }),
      makeBody({
        appliedFilters: {
          minConfidence: { applied: true, normalised: 0.8 },
          severityThreshold: { applied: false, normalised: null },
        },
      }),
    );
    expect(delta.minConfidence.base).toBe(0.3);
    expect(delta.minConfidence.target).toBe(0.8);
    expect(delta.minConfidence.changed).toBe(true);
    expect(delta.hasDelta).toBe(true);
  });

  it('severityThreshold flip from null -> "high" surfaces as changed', () => {
    const delta = computeFilterReportDelta(
      makeBody({
        appliedFilters: {
          minConfidence: { applied: false, normalised: 0 },
          severityThreshold: { applied: false, normalised: null },
        },
      }),
      makeBody({
        appliedFilters: {
          minConfidence: { applied: false, normalised: 0 },
          severityThreshold: { applied: true, normalised: 'high' },
        },
      }),
    );
    expect(delta.severityThreshold.base).toBe(null);
    expect(delta.severityThreshold.target).toBe('high');
    expect(delta.severityThreshold.changed).toBe(true);
    expect(delta.hasDelta).toBe(true);
  });

  it('slim bodies (no appliedFilters) surface per-axis as base=null/target=null with changed=false', () => {
    // Use `as` to construct a slim body without the appliedFilters
    // field -- this matches the wire shape the route's ?slim=true
    // projection produces.
    const slim: FilterReportBodyLike = {
      applied: true,
      inputTotal: 10,
      droppedTotal: 3,
    };
    const delta = computeFilterReportDelta(slim, slim);
    expect(delta.minConfidence.base).toBe(null);
    expect(delta.minConfidence.target).toBe(null);
    expect(delta.minConfidence.changed).toBe(false);
    expect(delta.severityThreshold.base).toBe(null);
    expect(delta.severityThreshold.target).toBe(null);
    expect(delta.severityThreshold.changed).toBe(false);
    expect(delta.hasDelta).toBe(false);
  });

  it('axis-with-applied=false on one side surfaces as null on that side', () => {
    // Asymmetric: base has the filter applied, target does not. The
    // delta should show base=0.5 -> target=null (removed) and
    // changed=true.
    const delta = computeFilterReportDelta(
      makeBody({
        appliedFilters: {
          minConfidence: { applied: true, normalised: 0.5 },
          severityThreshold: { applied: false, normalised: null },
        },
      }),
      makeBody({
        appliedFilters: {
          minConfidence: { applied: false, normalised: 0 },
          severityThreshold: { applied: false, normalised: null },
        },
      }),
    );
    expect(delta.minConfidence.base).toBe(0.5);
    expect(delta.minConfidence.target).toBe(null);
    expect(delta.minConfidence.changed).toBe(true);
    expect(delta.hasDelta).toBe(true);
  });

  it('mixed axes: applied + inputTotal + minConfidence all change in one delta', () => {
    const delta = computeFilterReportDelta(
      makeBody({
        applied: false,
        inputTotal: 5,
        appliedFilters: {
          minConfidence: { applied: true, normalised: 0.2 },
          severityThreshold: { applied: false, normalised: null },
        },
      }),
      makeBody({
        applied: true,
        inputTotal: 20,
        appliedFilters: {
          minConfidence: { applied: true, normalised: 0.8 },
          severityThreshold: { applied: false, normalised: null },
        },
      }),
    );
    expect(delta.applied.changed).toBe(true);
    expect(delta.inputTotal.changed).toBe(true);
    expect(delta.inputTotal.delta).toBe(15);
    expect(delta.minConfidence.changed).toBe(true);
    expect(delta.severityThreshold.changed).toBe(false);
    expect(delta.hasDelta).toBe(true);
  });

  it('does NOT mutate input bodies (frozen-friendly)', () => {
    const base = Object.freeze(makeBody({ inputTotal: 10 }));
    const target = Object.freeze(makeBody({ inputTotal: 15 }));
    expect(() => computeFilterReportDelta(base, target)).not.toThrow();
  });

  it('inputTotal=droppedTotal=0 on both sides with applied=false yields hasDelta=false', () => {
    // The "no filter applied, nothing dropped" baseline -- a smoke
    // test that the helper doesn't fabricate spurious changes when
    // every counter is zero.
    const empty: FilterReportBodyLike = {
      applied: false,
      inputTotal: 0,
      droppedTotal: 0,
    };
    const delta = computeFilterReportDelta(empty, empty);
    expect(delta.hasDelta).toBe(false);
    expect(delta.applied.changed).toBe(false);
    expect(delta.inputTotal.delta).toBe(0);
    expect(delta.droppedTotal.delta).toBe(0);
  });
});

// Tick 28: `summariseFilterReportDelta` -- compact summary helper
// suitable for a Slack message body, an email subject line, or a
// webhook router's "what's the headline?" payload. Where
// FilterReportDelta carries the full per-axis before/after shape,
// the summary collapses it to `changedAxes` + `regression` + `bugFix`
// bits so a downstream consumer can short-circuit on the headline.
describe('summariseFilterReportDelta (tick 28)', () => {
  async function importHelpers(): Promise<{
    summariseFilterReportDelta: typeof import('../src/filter-report-delta.js').summariseFilterReportDelta;
    FILTER_REPORT_DELTA_AXES: typeof import('../src/filter-report-delta.js').FILTER_REPORT_DELTA_AXES;
  }> {
    const mod = await import('../src/filter-report-delta.js');
    return {
      summariseFilterReportDelta: mod.summariseFilterReportDelta,
      FILTER_REPORT_DELTA_AXES: mod.FILTER_REPORT_DELTA_AXES,
    };
  }

  it('FILTER_REPORT_DELTA_AXES is a closed 5-tuple in canonical order', async () => {
    const { FILTER_REPORT_DELTA_AXES } = await importHelpers();
    // Pinning the order: the diff render path walks axes in this
    // sequence; the summary's changedAxes also iterates in this
    // order. A reorder would silently change every CI dashboard's
    // column layout.
    expect([...FILTER_REPORT_DELTA_AXES]).toEqual([
      'applied',
      'inputTotal',
      'droppedTotal',
      'minConfidence',
      'severityThreshold',
    ]);
  });

  it('identical bodies -> hasDelta=false, changedAxes empty, neither regression nor bugFix', async () => {
    const { summariseFilterReportDelta } = await importHelpers();
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(makeBody(), makeBody()),
    );
    expect(summary.hasDelta).toBe(false);
    expect([...summary.changedAxes]).toEqual([]);
    expect(summary.regression).toBe(false);
    expect(summary.bugFix).toBe(false);
  });

  it('inputTotal grew (10 -> 25) -> regression true, bugFix false, changedAxes=[inputTotal]', async () => {
    const { summariseFilterReportDelta } = await importHelpers();
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(
        makeBody({ inputTotal: 10 }),
        makeBody({ inputTotal: 25 }),
      ),
    );
    expect(summary.hasDelta).toBe(true);
    expect([...summary.changedAxes]).toEqual(['inputTotal']);
    expect(summary.regression).toBe(true);
    expect(summary.bugFix).toBe(false);
  });

  it('inputTotal shrank (25 -> 10) -> bugFix true, regression false', async () => {
    const { summariseFilterReportDelta } = await importHelpers();
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(
        makeBody({ inputTotal: 25 }),
        makeBody({ inputTotal: 10 }),
      ),
    );
    expect(summary.bugFix).toBe(true);
    expect(summary.regression).toBe(false);
    expect([...summary.changedAxes]).toEqual(['inputTotal']);
  });

  it('applied flipped true -> false (filter removed) -> regression true', async () => {
    const { summariseFilterReportDelta } = await importHelpers();
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(
        makeBody({ applied: true }),
        makeBody({ applied: false }),
      ),
    );
    expect(summary.regression).toBe(true);
    expect(summary.bugFix).toBe(false);
    expect([...summary.changedAxes]).toEqual(['applied']);
  });

  it('applied flipped false -> true (filter added) -> bugFix true', async () => {
    const { summariseFilterReportDelta } = await importHelpers();
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(
        makeBody({ applied: false }),
        makeBody({ applied: true }),
      ),
    );
    expect(summary.bugFix).toBe(true);
    expect(summary.regression).toBe(false);
  });

  it('droppedTotal shrank with inputTotal flat -> regression (filter letting more through)', async () => {
    const { summariseFilterReportDelta } = await importHelpers();
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(
        makeBody({ inputTotal: 10, droppedTotal: 8 }),
        makeBody({ inputTotal: 10, droppedTotal: 3 }),
      ),
    );
    expect(summary.regression).toBe(true);
    expect([...summary.changedAxes]).toEqual(['droppedTotal']);
  });

  it('droppedTotal grew with inputTotal flat -> bugFix (filter rejecting more)', async () => {
    const { summariseFilterReportDelta } = await importHelpers();
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(
        makeBody({ inputTotal: 10, droppedTotal: 3 }),
        makeBody({ inputTotal: 10, droppedTotal: 8 }),
      ),
    );
    expect(summary.bugFix).toBe(true);
    expect([...summary.changedAxes]).toEqual(['droppedTotal']);
  });

  it('mixed change (applied flipped AND inputTotal grew) -> BOTH regression and bugFix true', async () => {
    const { summariseFilterReportDelta } = await importHelpers();
    // applied false->true is a "bug fix" signal; inputTotal grew
    // is a "regression" signal. Both fire because the underlying
    // sources are independent (and a webhook router that wants
    // exclusive routing should resolve precedence itself).
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(
        makeBody({ applied: false, inputTotal: 10 }),
        makeBody({ applied: true, inputTotal: 25 }),
      ),
    );
    expect(summary.regression).toBe(true);
    expect(summary.bugFix).toBe(true);
    expect([...summary.changedAxes]).toEqual(['applied', 'inputTotal']);
  });

  it('threshold-only change (minConfidence 0.5 -> 0.8) -> hasDelta but neither regression nor bugFix', async () => {
    // A threshold drift alone doesn't move the input/dropped totals,
    // so neither bit fires. This is a deliberate design choice: a
    // threshold-only operator-config change is ambiguous (tightening
    // is "filter MORE strict" which is intent-fix; relaxing is the
    // opposite). The webhook router can inspect changedAxes for
    // 'minConfidence' or 'severityThreshold' if it wants to alert
    // on threshold drift specifically.
    const { summariseFilterReportDelta } = await importHelpers();
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(
        makeBody({
          appliedFilters: {
            minConfidence: { applied: true, normalised: 0.5 },
            severityThreshold: { applied: false, normalised: null },
          },
        }),
        makeBody({
          appliedFilters: {
            minConfidence: { applied: true, normalised: 0.8 },
            severityThreshold: { applied: false, normalised: null },
          },
        }),
      ),
    );
    expect(summary.hasDelta).toBe(true);
    expect([...summary.changedAxes]).toEqual(['minConfidence']);
    expect(summary.regression).toBe(false);
    expect(summary.bugFix).toBe(false);
  });

  it('multi-axis change (input AND severity AND minConfidence) -> changedAxes in canonical order', async () => {
    const { summariseFilterReportDelta } = await importHelpers();
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(
        makeBody({
          inputTotal: 10,
          appliedFilters: {
            minConfidence: { applied: true, normalised: 0.5 },
            severityThreshold: { applied: true, normalised: 'low' },
          },
        }),
        makeBody({
          inputTotal: 25,
          appliedFilters: {
            minConfidence: { applied: true, normalised: 0.8 },
            severityThreshold: { applied: true, normalised: 'medium' },
          },
        }),
      ),
    );
    expect([...summary.changedAxes]).toEqual([
      'inputTotal',
      'minConfidence',
      'severityThreshold',
    ]);
    expect(summary.regression).toBe(true); // inputTotal grew
  });

  it('changedAxes is frozen (cannot be extended by a careless caller)', async () => {
    const { summariseFilterReportDelta } = await importHelpers();
    const summary = summariseFilterReportDelta(
      computeFilterReportDelta(
        makeBody({ inputTotal: 10 }),
        makeBody({ inputTotal: 15 }),
      ),
    );
    // Frozen by Object.freeze; push throws in strict mode (which
    // ESM is) without a TypeError-tolerant `try` -- assert by
    // catching the throw.
    expect(() => {
      (summary.changedAxes as unknown as string[]).push('synthetic');
    }).toThrow();
  });
});

