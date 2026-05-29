import { describe, expect, it } from 'vitest';

import { BudgetGuard } from '../src/budget.js';

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
});
