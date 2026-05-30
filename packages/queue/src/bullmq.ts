import type { JobHandle, QueueAdapter, QueueHealth } from './adapter.js';

export interface BullAdapterOptions {
  redisUrl: string;
  queueName: string;
}

/**
 * Lightweight wrapper around BullMQ that defers importing the package until
 * runtime, so workspace builds do not require Redis to be installed.
 */
export class BullQueueAdapter implements QueueAdapter {
  private queue: { add: (name: string, data: unknown, opts?: Record<string, unknown>) => Promise<{ id?: string; name: string; data: unknown }>; close: () => Promise<void> } | null = null;
  private worker: { close: () => Promise<void> } | null = null;

  constructor(private readonly opts: BullAdapterOptions) {}

  async enqueue(name: string, data: unknown, opts: { delayMs?: number; jobId?: string } = {}): Promise<JobHandle> {
    const queue = await this.getQueue();
    const job = await queue.add(name, data, {
      jobId: opts.jobId,
      delay: opts.delayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 60 * 60, count: 1000 },
      removeOnFail: { age: 24 * 60 * 60 },
    });
    return { id: job.id ?? 'unknown', name: job.name, data: job.data };
  }

  async process(name: string, handler: (data: unknown) => Promise<void>): Promise<void> {
    const { Worker } = await import('bullmq');
    this.worker = new Worker(
      this.opts.queueName,
      async (job: { name: string; data: unknown }) => {
        if (job.name !== name) return;
        await handler(job.data);
      },
      { connection: { url: this.opts.redisUrl }, concurrency: 4 },
    );
  }

  async close(): Promise<void> {
    await this.queue?.close();
    await this.worker?.close();
  }

  async health(): Promise<QueueHealth> {
    try {
      const queue = await this.getQueue();
      const q = queue as unknown as {
        getJobCounts?: () => Promise<Record<string, number>>;
      };
      const counts = await q.getJobCounts?.();
      return {
        ok: true,
        backend: 'bullmq',
        pending: counts?.waiting ?? counts?.['wait'] ?? 0,
        inflight: counts?.active ?? 0,
      };
    } catch (err) {
      return { ok: false, backend: 'bullmq', error: (err as Error).message };
    }
  }

  private async getQueue() {
    if (this.queue) return this.queue;
    const { Queue } = await import('bullmq');
    this.queue = new Queue(this.opts.queueName, {
      connection: { url: this.opts.redisUrl },
    }) as unknown as typeof this.queue;
    return this.queue!;
  }
}
