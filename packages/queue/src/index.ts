import { BullQueueAdapter } from './bullmq.js';
import { InMemoryQueue } from './in-memory.js';
import type { QueueAdapter } from './adapter.js';

export interface QueueFactoryOptions {
  redisUrl?: string;
  queueName?: string;
  forceInMemory?: boolean;
}

export function createQueue(opts: QueueFactoryOptions = {}): QueueAdapter {
  if (opts.forceInMemory || !opts.redisUrl) return new InMemoryQueue();
  return new BullQueueAdapter({
    redisUrl: opts.redisUrl,
    queueName: opts.queueName ?? 'clawreview',
  });
}

export * from './adapter.js';
export * from './bullmq.js';
export * from './in-memory.js';
