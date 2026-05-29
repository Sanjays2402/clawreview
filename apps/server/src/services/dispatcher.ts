import type { QueueAdapter } from '@clawreview/queue';
import { REVIEW_JOB, type ReviewJobData } from '../queue.js';

export class ReviewDispatcher {
  constructor(private readonly queue: QueueAdapter) {}
  async dispatch(data: ReviewJobData): Promise<string> {
    const jobId = 'pr-' + data.owner + '/' + data.repo + '-' + data.prNumber + '-' + data.headSha;
    const job = await this.queue.enqueue(REVIEW_JOB, data, { jobId });
    return job.id;
  }
}
