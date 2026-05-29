import type { ReviewSummary } from '@clawreview/types';

export interface ReviewService {
  recordStart(input: { installationId: number; owner: string; repo: string; prNumber: number; headSha: string; baseSha: string }): Promise<{ reviewId: string }>;
  recordComplete(reviewId: string, summary: ReviewSummary, commentId?: number, checkRunId?: number): Promise<void>;
  recordFailure(reviewId: string, error: Error): Promise<void>;
}

export class InMemoryReviewService implements ReviewService {
  private counter = 0;
  async recordStart() {
    this.counter += 1;
    return { reviewId: 'mem-' + this.counter };
  }
  async recordComplete() {}
  async recordFailure() {}
}
