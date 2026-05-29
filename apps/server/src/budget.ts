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

  overLimit(installationId: number): boolean {
    const cur = this.state.get(installationId);
    if (!cur) return false;
    return cur.spentUsd >= cur.limitUsd;
  }

  reset(installationId: number): void {
    this.state.delete(installationId);
  }
}
