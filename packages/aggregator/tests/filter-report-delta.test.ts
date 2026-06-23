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
