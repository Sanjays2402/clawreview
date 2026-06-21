import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryQueue } from '../src/in-memory.js';

describe('InMemoryQueue.details()', () => {
  let queue: InMemoryQueue;
  beforeEach(() => {
    queue = new InMemoryQueue({ failureRingSize: 3 });
  });
  afterEach(async () => {
    await queue.close();
  });

  it('reports backend, pending/inflight totals, and an ISO sampledAt timestamp', async () => {
    await queue.enqueue('alpha', { x: 1 });
    await queue.enqueue('alpha', { x: 2 });
    await queue.enqueue('beta', { x: 3 });
    const d = await queue.details();
    expect(d.backend).toBe('memory');
    expect(d.ok).toBe(true);
    expect(d.pending).toBe(3);
    expect(d.inflight).toBe(0);
    expect(d.sampledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('breaks down pending counts by job name, sorted alphabetically', async () => {
    await queue.enqueue('beta', { x: 1 });
    await queue.enqueue('alpha', { x: 2 });
    await queue.enqueue('alpha', { x: 3 });
    const d = await queue.details();
    expect(d.byName).toEqual([
      { name: 'alpha', pending: 2, inflight: 0 },
      { name: 'beta', pending: 1, inflight: 0 },
    ]);
  });

  it('captures recent handler failures into the bounded ring, newest-first', async () => {
    let counter = 0;
    await queue.process('flaky', async () => {
      counter += 1;
      throw new Error(`fail-${counter}`);
    });
    await queue.enqueue('flaky', { i: 1 });
    await queue.enqueue('flaky', { i: 2 });
    await queue.enqueue('flaky', { i: 3 });
    await queue.enqueue('flaky', { i: 4 });
    await queue.drain();
    const d = await queue.details();
    // failureRingSize=3, so the oldest (fail-1) was evicted.
    expect(d.recentFailures?.length).toBe(3);
    expect(d.recentFailures?.[0]?.error).toMatch(/^fail-[234]$/);
    const errors = d.recentFailures?.map((f) => f.error);
    expect(errors).not.toContain('fail-1');
    // Each failure carries the job id, name, and attempts.
    for (const f of d.recentFailures ?? []) {
      expect(f.id).toBeTruthy();
      expect(f.name).toBe('flaky');
      expect(f.attempts).toBe(1);
      expect(typeof f.failedAt).toBe('number');
    }
  });

  it('returns ok=false and surfaces "queue_closed" once the queue is closed', async () => {
    await queue.close();
    const d = await queue.details();
    expect(d.ok).toBe(false);
    expect(d.error).toBe('queue_closed');
  });

  it('reports zero counts and empty arrays for an idle queue', async () => {
    const d = await queue.details();
    expect(d.pending).toBe(0);
    expect(d.inflight).toBe(0);
    expect(d.byName).toEqual([]);
    expect(d.recentFailures).toEqual([]);
  });
});
