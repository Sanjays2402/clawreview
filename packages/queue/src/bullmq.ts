import type {
  JobHandle,
  QueueAdapter,
  QueueDetails,
  QueueFailure,
  QueueHealth,
} from './adapter.js';

export interface BullAdapterOptions {
  redisUrl: string;
  queueName: string;
  /** Max failed jobs to fetch from BullMQ for the details() response. */
  detailsFailedLimit?: number;
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

  async details(): Promise<QueueDetails> {
    const base = await this.health();
    const failedLimit = this.opts.detailsFailedLimit ?? 25;
    try {
      const queue = await this.getQueue();
      const q = queue as unknown as {
        getJobCounts?: () => Promise<Record<string, number>>;
        getFailed?: (
          start?: number,
          end?: number,
        ) => Promise<
          Array<{
            id?: string;
            name?: string;
            failedReason?: string;
            finishedOn?: number;
            attemptsMade?: number;
          }>
        >;
      };
      const failedJobs = (await q.getFailed?.(0, failedLimit - 1)) ?? [];
      const recentFailures: QueueFailure[] = failedJobs
        .map((j) => ({
          id: j.id ?? 'unknown',
          name: j.name ?? this.opts.queueName,
          error: j.failedReason ?? 'unknown',
          failedAt: j.finishedOn ?? Date.now(),
          attempts: j.attemptsMade ?? 1,
        }))
        .sort((a, b) => b.failedAt - a.failedAt);
      // BullMQ aggregates per-queue, not per-job-name, so byName collapses
      // to a single row representing the queue's overall pending/inflight.
      // Operators wanting finer detail should run BullMQ's own UI.
      const byName = [
        {
          name: this.opts.queueName,
          pending: base.pending ?? 0,
          inflight: base.inflight ?? 0,
        },
      ];
      return {
        ...base,
        byName,
        recentFailures,
        sampledAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        ...base,
        ok: false,
        error: (err as Error).message,
        sampledAt: new Date().toISOString(),
      };
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
