import { createQueue, type QueueAdapter } from '@clawreview/queue';

import { env } from './env.js';

let queue: QueueAdapter | null = null;

export function getQueue(): QueueAdapter {
  if (queue) return queue;
  queue = createQueue({
    redisUrl: env.REDIS_URL || undefined,
    queueName: 'clawreview-reviews',
    forceInMemory: env.NODE_ENV === 'test' || !env.REDIS_URL,
  });
  return queue;
}

export const REVIEW_JOB = 'review.pull-request';

export interface ReviewJobData {
  reviewId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  reason: 'opened' | 'synchronize' | 'reopened' | 'ready_for_review' | 'manual';
}
