export interface JobHandle {
  id: string;
  name: string;
  data: unknown;
}

export interface QueueHealth {
  ok: boolean;
  backend: 'memory' | 'bullmq' | 'unknown';
  pending?: number;
  inflight?: number;
  error?: string;
}

export interface QueueAdapter<T = unknown> {
  enqueue(name: string, data: T, opts?: { delayMs?: number; jobId?: string }): Promise<JobHandle>;
  process(name: string, handler: (data: T) => Promise<void>): Promise<void>;
  close(): Promise<void>;
  health?(): Promise<QueueHealth>;
}
