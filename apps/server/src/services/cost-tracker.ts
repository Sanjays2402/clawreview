import type { ReviewSummary } from '@clawreview/types';

export interface CostTracker {
  record(installationId: number, summary: ReviewSummary): void;
  monthSpent(installationId: number): number;
}

export class InMemoryCostTracker implements CostTracker {
  private totals = new Map<number, number>();
  record(installationId: number, summary: ReviewSummary): void {
    this.totals.set(installationId, (this.totals.get(installationId) ?? 0) + summary.totalCostUsd);
  }
  monthSpent(installationId: number): number {
    return this.totals.get(installationId) ?? 0;
  }
}
