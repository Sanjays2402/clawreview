import { randomUUID } from 'node:crypto';

import type {
  JobHandle,
  QueueAdapter,
  QueueDetails,
  QueueFailure,
  QueueHealth,
  QueueJobNameCounts,
} from './adapter.js';

interface PendingJob {
  id: string;
  name: string;
  data: unknown;
  runAt: number;
}

interface InflightJob {
  id: string;
  name: string;
  startedAt: number;
}

const DEFAULT_FAILURE_RING = 25;

export interface InMemoryQueueOptions {
  /** Max recent failures to retain for `details()`. Defaults to 25. */
  failureRingSize?: number;
}

export class InMemoryQueue implements QueueAdapter {
  private handlers = new Map<string, (data: unknown) => Promise<void>>();
  private pending: PendingJob[] = [];
  private inflightJobs: InflightJob[] = [];
  private timer?: NodeJS.Timeout;
  private closed = false;
  private inflight = 0;
  private failures: QueueFailure[] = [];
  private readonly failureRingSize: number;

  constructor(opts: InMemoryQueueOptions = {}) {
    this.failureRingSize = Math.max(1, opts.failureRingSize ?? DEFAULT_FAILURE_RING);
  }

  async enqueue(name: string, data: unknown, opts: { delayMs?: number; jobId?: string } = {}): Promise<JobHandle> {
    if (this.closed) throw new Error('Queue closed');
    const job: PendingJob = {
      id: opts.jobId ?? randomUUID(),
      name,
      data,
      runAt: Date.now() + (opts.delayMs ?? 0),
    };
    this.pending.push(job);
    this.kick();
    return { id: job.id, name: job.name, data: job.data };
  }

  async process(name: string, handler: (data: unknown) => Promise<void>): Promise<void> {
    this.handlers.set(name, handler);
    this.kick();
  }

  async drain(): Promise<void> {
    while (this.pending.length > 0 || this.inflight > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.handlers.clear();
    this.pending = [];
    this.inflightJobs = [];
  }

  async health(): Promise<QueueHealth> {
    return {
      ok: !this.closed,
      backend: 'memory',
      pending: this.pending.length,
      inflight: this.inflight,
      ...(this.closed ? { error: 'queue_closed' } : {}),
    };
  }

  async details(): Promise<QueueDetails> {
    const base = await this.health();
    const byNameMap = new Map<string, QueueJobNameCounts>();
    for (const job of this.pending) {
      const cur = byNameMap.get(job.name) ?? { name: job.name, pending: 0, inflight: 0 };
      cur.pending += 1;
      byNameMap.set(job.name, cur);
    }
    for (const job of this.inflightJobs) {
      const cur = byNameMap.get(job.name) ?? { name: job.name, pending: 0, inflight: 0 };
      cur.inflight += 1;
      byNameMap.set(job.name, cur);
    }
    const byName = [...byNameMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    return {
      ...base,
      byName,
      // Newest first; tests rely on this ordering for predictable assertions.
      recentFailures: [...this.failures].sort((a, b) => b.failedAt - a.failedAt),
      sampledAt: new Date().toISOString(),
    };
  }

  /**
   * Exposed for tests + adapters that wrap InMemoryQueue (replay endpoint,
   * future on-disk persistence). NOT part of the public QueueAdapter
   * contract; production code should rely on `details()` instead.
   */
  _failuresForTests(): QueueFailure[] {
    return [...this.failures];
  }

  private recordFailure(job: PendingJob, err: unknown): void {
    const failure: QueueFailure = {
      id: job.id,
      name: job.name,
      error: err instanceof Error ? err.message : String(err),
      failedAt: Date.now(),
      attempts: 1,
    };
    this.failures.push(failure);
    if (this.failures.length > this.failureRingSize) {
      this.failures.splice(0, this.failures.length - this.failureRingSize);
    }
  }

  private kick(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => this.tick(), 0);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.closed) return;
    const now = Date.now();
    const remaining: PendingJob[] = [];
    for (const job of this.pending) {
      if (job.runAt > now) {
        remaining.push(job);
        continue;
      }
      const handler = this.handlers.get(job.name);
      if (!handler) {
        remaining.push(job);
        continue;
      }
      this.inflight += 1;
      const inflightEntry: InflightJob = { id: job.id, name: job.name, startedAt: now };
      this.inflightJobs.push(inflightEntry);
      handler(job.data)
        .catch((err) => {
          console.error(`[queue] handler ${job.name} failed`, err);
          this.recordFailure(job, err);
        })
        .finally(() => {
          this.inflight -= 1;
          const idx = this.inflightJobs.indexOf(inflightEntry);
          if (idx >= 0) this.inflightJobs.splice(idx, 1);
        });
    }
    this.pending = remaining;
    if (this.pending.length > 0) {
      const next = Math.max(5, Math.min(...this.pending.map((j) => j.runAt - Date.now())));
      this.timer = setTimeout(() => this.tick(), Math.max(0, next));
    }
  }
}
