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

/** A job that failed inside the queue handler. Kept on a small bounded
 *  ring so /api/internal/queue can show recent failures without growing
 *  unbounded in memory. */
export interface QueueFailure {
  id: string;
  name: string;
  /** Error message captured from the rejected handler. */
  error: string;
  /** Unix-epoch milliseconds when the failure was recorded. */
  failedAt: number;
  /** Number of attempts at the time of failure (1 = first attempt). */
  attempts?: number;
}

/** Per-job-name breakdown returned by `QueueAdapter.details()`. */
export interface QueueJobNameCounts {
  name: string;
  pending: number;
  inflight: number;
}

/**
 * Richer introspection used by the operator-facing /api/internal/queue
 * endpoint. Implementations expose what they can; missing fields are
 * fine and the route handles undefined gracefully.
 */
export interface QueueDetails extends QueueHealth {
  /** Breakdown of pending/inflight by job name. */
  byName?: QueueJobNameCounts[];
  /** Most recent failures, newest-first. */
  recentFailures?: QueueFailure[];
  /** ISO timestamp at which `details()` was called. */
  sampledAt: string;
}

export interface QueueAdapter<T = unknown> {
  enqueue(name: string, data: T, opts?: { delayMs?: number; jobId?: string }): Promise<JobHandle>;
  process(name: string, handler: (data: T) => Promise<void>): Promise<void>;
  close(): Promise<void>;
  health?(): Promise<QueueHealth>;
  /**
   * Optional introspection used by /api/internal/queue. Adapters that
   * don't implement it cause the endpoint to fall back to `health()`
   * alone (still useful but without the per-name / recent-failure
   * breakdown).
   */
  details?(): Promise<QueueDetails>;
}
