import { describe, expect, it, beforeEach } from 'vitest';

import { InMemoryDeliveryCache } from '../src/services/delivery-cache.js';

describe('InMemoryDeliveryCache', () => {
  let cache: InMemoryDeliveryCache;
  beforeEach(() => {
    cache = new InMemoryDeliveryCache(3);
  });

  it('reserves a new delivery exactly once', () => {
    expect(cache.reserve('d1')).toBe(true);
    expect(cache.reserve('d1')).toBe(false);
    expect(cache.reserve('d1')).toBe(false);
    expect(cache.has('d1')).toBe(true);
  });

  it('treats empty IDs as fresh (fail open)', () => {
    expect(cache.reserve('')).toBe(true);
    expect(cache.reserve('')).toBe(true);
    expect(cache.size()).toBe(0);
  });

  it('evicts the oldest entry when over capacity', () => {
    cache.reserve('a');
    cache.reserve('b');
    cache.reserve('c');
    cache.reserve('d'); // evicts 'a'
    expect(cache.has('a')).toBe(false);
    expect(cache.has('d')).toBe(true);
    // 'a' is forgotten so it reads as fresh again
    expect(cache.reserve('a')).toBe(true);
  });

  it('refreshes recency on duplicate so it survives later evictions', () => {
    cache.reserve('a');
    cache.reserve('b');
    cache.reserve('a'); // duplicate, refreshes a
    cache.reserve('c');
    cache.reserve('d'); // would have evicted a, but b is older now
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('clear() drops everything', () => {
    cache.reserve('a');
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.reserve('a')).toBe(true);
  });
});
