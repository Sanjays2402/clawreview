import { describe, expect, it } from 'vitest';

import { buildBlameMapWith } from '../src/commands/authors.js';

const PORCELAIN_X = [
  'abc1234567 1 1 2',
  'author Sanjay Singh',
  'author-mail <sanjay@example.com>',
  '\tconst a = 1;',
  'def4567890 2 2 1',
  'author Cake Bot',
  'author-mail <cake@example.com>',
  '\tconst b = 2;',
].join('\n');

describe('buildBlameMapWith', () => {
  it('blames each file exactly once and merges per-file results into one map', async () => {
    const seenRequests: Array<{ ref: string; file: string }> = [];
    const map = await buildBlameMapWith(
      [
        { file: 'src/x.ts', startLine: 1 } as never,
        { file: 'src/x.ts', startLine: 2 } as never,
        { file: 'src/x.ts', startLine: 3 } as never, // out of porcelain range -> falls to unknown later
      ],
      'HEAD',
      async (ref, file) => {
        seenRequests.push({ ref, file });
        return PORCELAIN_X;
      },
    );
    expect(seenRequests).toHaveLength(1); // ONE git blame call, not three
    expect(seenRequests[0]).toEqual({ ref: 'HEAD', file: 'src/x.ts' });
    expect(map.get('src/x.ts:1')).toMatchObject({ authorEmail: 'sanjay@example.com' });
    expect(map.get('src/x.ts:2')).toMatchObject({ authorEmail: 'cake@example.com' });
    expect(map.get('src/x.ts:3')).toBeUndefined();
  });

  it('skips files where blame returns empty (newly-added files)', async () => {
    const map = await buildBlameMapWith(
      [{ file: 'src/brand-new.ts', startLine: 1 } as never],
      'HEAD',
      async () => '',
    );
    expect(map.size).toBe(0);
  });

  it('handles many files by issuing one fetch per unique file path', async () => {
    const seen: string[] = [];
    await buildBlameMapWith(
      [
        { file: 'a.ts', startLine: 1 } as never,
        { file: 'b.ts', startLine: 2 } as never,
        { file: 'a.ts', startLine: 3 } as never,
        { file: 'c.ts', startLine: 4 } as never,
      ],
      'HEAD',
      async (_ref, file) => {
        seen.push(file);
        return '';
      },
    );
    expect(seen.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});
