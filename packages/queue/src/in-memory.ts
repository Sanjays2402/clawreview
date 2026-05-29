import { randomUUID } from 'node:crypto';

import type { JobHandle, QueueAdapter } from './adapter.js';

interface PendingJob {
  id: string;
  name: string;
  data: unknown;
  runAt: number;
}

export class InMemoryQueue implements QueueAdapter {
  private handlers = new Map<string, (data: unknown) => Promise<void>>();
  private pending: PendingJob[] = [];
  private timer?: NodeJS.Timeout;
  private closed = false;
  private inflight = 0;

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
      handler(job.data)
        .catch((err) => console.error(`[queue] handler ${job.name} failed`, err))
        .finally(() => {
          this.inflight -= 1;
        });
    }
    this.pending = remaining;
    if (this.pending.length > 0) {
      const next = Math.max(5, Math.min(...this.pending.map((j) => j.runAt - Date.now())));
      this.timer = setTimeout(() => this.tick(), Math.max(0, next));
    }
  }
}
