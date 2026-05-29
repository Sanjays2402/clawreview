import { describe, expect, it } from 'vitest';

import { InMemoryQueue } from '../src/in-memory.js';

describe('InMemoryQueue', () => {
  it('delivers an enqueued job to its handler', async () => {
    const q = new InMemoryQueue();
    const seen: unknown[] = [];
    await q.process('review', async (data) => {
      seen.push(data);
    });
    await q.enqueue('review', { pr: 1 });
    await q.enqueue('review', { pr: 2 });
    await q.drain();
    expect(seen).toEqual([{ pr: 1 }, { pr: 2 }]);
    await q.close();
  });

  it('respects delay', async () => {
    const q = new InMemoryQueue();
    const seen: number[] = [];
    await q.process('x', async (data) => {
      seen.push((data as { n: number }).n);
    });
    await q.enqueue('x', { n: 1 }, { delayMs: 30 });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([]);
    await q.drain();
    expect(seen).toEqual([1]);
    await q.close();
  });
});
