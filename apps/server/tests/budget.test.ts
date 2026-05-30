import { describe, expect, it, beforeEach } from 'vitest';

import { BudgetGuard, _resetBudgetGuardForTests, getBudgetGuard } from '../src/budget.js';

describe('BudgetGuard', () => {
  it('starts a new period when month changes', () => {
    const g = new BudgetGuard(10);
    g.spent(1, 5);
    expect(g.overLimit(1)).toBe(false);
    g.spent(1, 6);
    expect(g.overLimit(1)).toBe(true);
  });

  it('produces a stable period key', () => {
    const d = new Date(Date.UTC(2026, 4, 1));
    expect(BudgetGuard.periodKey(d)).toBe('2026-05');
  });

  it('snapshot returns zero for an unknown installation', () => {
    const g = new BudgetGuard(20);
    const snap = g.snapshot(42);
    expect(snap.spentUsd).toBe(0);
    expect(snap.limitUsd).toBe(20);
  });

  it('wouldExceed accounts for projected cost', () => {
    const g = new BudgetGuard(10);
    g.spent(1, 7);
    expect(g.wouldExceed(1, 2)).toBe(false);
    expect(g.wouldExceed(1, 4)).toBe(true);
  });

  it('reset clears state for a single installation', () => {
    const g = new BudgetGuard(10);
    g.spent(1, 9);
    g.spent(2, 9);
    g.reset(1);
    expect(g.snapshot(1).spentUsd).toBe(0);
    expect(g.snapshot(2).spentUsd).toBe(9);
  });

  it('PUT-style limit override via spent(0, newLimit) takes effect', () => {
    const g = new BudgetGuard(10);
    g.spent(1, 8);
    expect(g.overLimit(1)).toBe(false);
    g.spent(1, 0, 5);
    expect(g.overLimit(1)).toBe(true);
  });
});

describe('getBudgetGuard singleton', () => {
  beforeEach(() => _resetBudgetGuardForTests());

  it('returns the same instance across calls', () => {
    const a = getBudgetGuard(10);
    const b = getBudgetGuard(99);
    expect(a).toBe(b);
  });
});
