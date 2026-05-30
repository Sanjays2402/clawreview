/**
 * Tracks cost per installation per month. The real implementation persists to
 * the Installation row; here we keep an in-memory ledger that mirrors the same
 * interface so the worker code can stay clean.
 */
export interface BudgetState {
  spentUsd: number;
  limitUsd: number;
  periodKey: string;
}

export class BudgetGuard {
  private state = new Map<number, BudgetState>();

  constructor(private readonly defaultLimit: number) {}

  static periodKey(d = new Date()): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** Read-only view of the current state, useful for /api/budget. */
  snapshot(installationId: number, limitUsd = this.defaultLimit): BudgetState {
    const key = BudgetGuard.periodKey();
    const cur = this.state.get(installationId);
    if (!cur || cur.periodKey !== key) {
      return { spentUsd: 0, limitUsd, periodKey: key };
    }
    return { ...cur };
  }

  /** Returns true if a new job of `projectedCostUsd` would exceed the limit. */
  wouldExceed(installationId: number, projectedCostUsd = 0, limitUsd = this.defaultLimit): boolean {
    const snap = this.snapshot(installationId, limitUsd);
    return snap.spentUsd + projectedCostUsd > snap.limitUsd;
  }

  spent(installationId: number, costUsd: number, limitUsd = this.defaultLimit): BudgetState {
    const key = BudgetGuard.periodKey();
    const cur = this.state.get(installationId);
    if (!cur || cur.periodKey !== key) {
      const fresh: BudgetState = { spentUsd: costUsd, limitUsd, periodKey: key };
      this.state.set(installationId, fresh);
      return fresh;
    }
    cur.spentUsd += costUsd;
    cur.limitUsd = limitUsd;
    return cur;
  }

  overLimit(installationId: number, limitUsd = this.defaultLimit): boolean {
    const cur = this.state.get(installationId);
    if (!cur) return false;
    return cur.spentUsd >= (cur.limitUsd ?? limitUsd);
  }

  reset(installationId: number): void {
    this.state.delete(installationId);
  }
}

let singleton: BudgetGuard | null = null;
export function getBudgetGuard(defaultLimit: number): BudgetGuard {
  if (!singleton) singleton = new BudgetGuard(defaultLimit);
  return singleton;
}
export function _resetBudgetGuardForTests(): void {
  singleton = null;
}
