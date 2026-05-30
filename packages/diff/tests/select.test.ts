import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from '../src/parser.js';
import { selectReviewableFiles } from '../src/select.js';

function makeDiff(files: Array<{ path: string; bodyLines: string[]; binary?: boolean }>): string {
  return files
    .map((f) => {
      if (f.binary) {
        return `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\nBinary files a/${f.path} and b/${f.path} differ\n`;
      }
      const body = f.bodyLines.join('\n');
      const adds = f.bodyLines.filter((l) => l.startsWith('+')).length;
      return [
        `diff --git a/${f.path} b/${f.path}`,
        `--- a/${f.path}`,
        `+++ b/${f.path}`,
        `@@ -1,${Math.max(1, f.bodyLines.length - adds)} +1,${f.bodyLines.length} @@`,
        body,
        '',
      ].join('\n');
    })
    .join('');
}

describe('selectReviewableFiles', () => {
  it('skips binary files and files with no hunks', () => {
    const parsed = parseUnifiedDiff(
      makeDiff([
        { path: 'logo.png', bodyLines: [], binary: true },
        { path: 'src/a.ts', bodyLines: [' x', '+y'] },
      ]),
    );
    const { files, skipped } = selectReviewableFiles(parsed.files);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(skipped[0]).toMatchObject({ path: 'logo.png', reason: 'binary' });
  });

  it('skips known generated paths and extensions', () => {
    const parsed = parseUnifiedDiff(
      makeDiff([
        { path: 'pnpm-lock.yaml', bodyLines: [' a', '+b'] },
        { path: 'dist/bundle.js', bodyLines: [' a', '+b'] },
        { path: 'src/page.min.js', bodyLines: [' a', '+b'] },
        { path: 'src/real.ts', bodyLines: [' a', '+b'] },
      ]),
    );
    const { files, skipped } = selectReviewableFiles(parsed.files);
    expect(files.map((f) => f.path)).toEqual(['src/real.ts']);
    const reasons = Object.fromEntries(skipped.map((s) => [s.path, s.reason]));
    expect(reasons['pnpm-lock.yaml']).toBe('generated-path');
    expect(reasons['dist/bundle.js']).toBe('generated-path');
    expect(reasons['src/page.min.js']).toBe('generated-extension');
  });

  it('honors includeGenerated to disable the path detector', () => {
    const parsed = parseUnifiedDiff(
      makeDiff([{ path: 'dist/bundle.js', bodyLines: [' a', '+b'] }]),
    );
    const { files, skipped } = selectReviewableFiles(parsed.files, { includeGenerated: true });
    expect(files).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('skips oversize patches by changed-line count', () => {
    const big = [' base'];
    for (let i = 0; i < 50; i += 1) big.push(`+line ${i}`);
    const parsed = parseUnifiedDiff(makeDiff([{ path: 'src/huge.ts', bodyLines: big }]));
    const { files, skipped } = selectReviewableFiles(parsed.files, { maxChangedLines: 25 });
    expect(files).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ reason: 'oversize-lines' });
    expect(skipped[0]!.detail).toMatch(/changed lines/);
  });

  it('skips oversize patches by raw byte count', () => {
    const parsed = parseUnifiedDiff(makeDiff([{ path: 'src/a.ts', bodyLines: [' a', '+b'] }]));
    const { files, skipped } = selectReviewableFiles(parsed.files, { maxPatchBytes: 10 });
    expect(files).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ reason: 'oversize-bytes' });
  });
});
