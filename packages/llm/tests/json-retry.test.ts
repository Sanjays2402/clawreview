import { describe, expect, it } from 'vitest';

import { extractJson } from '../src/json.js';
import { withRetry } from '../src/retry.js';

describe('extractJson', () => {
  it('parses straight JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('peels markdown fences', () => {
    expect(extractJson('here you go\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('falls back to brace-slice', () => {
    expect(extractJson('preamble {"a":3} trailing')).toEqual({ a: 3 });
  });

  it('throws on garbage', () => {
    expect(() => extractJson('definitely not json')).toThrow();
  });
});

describe('withRetry', () => {
  it('retries 5xx and eventually succeeds', async () => {
    let n = 0;
    const v = await withRetry(
      async () => {
        n += 1;
        if (n < 3) {
          const err = new Error('boom') as Error & { status: number };
          err.status = 503;
          throw err;
        }
        return 'ok';
      },
      { attempts: 5, baseDelayMs: 1, jitter: false },
    );
    expect(v).toBe('ok');
    expect(n).toBe(3);
  });

  it('does not retry 4xx besides 408/429', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          const err = new Error('nope') as Error & { status: number };
          err.status = 400;
          throw err;
        },
        { attempts: 5, baseDelayMs: 1, jitter: false },
      ),
    ).rejects.toThrow(/nope/);
    expect(n).toBe(1);
  });
});
