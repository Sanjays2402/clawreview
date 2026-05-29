import { describe, expect, it } from 'vitest';

import { chunkFile } from '../src/chunker.js';
import { parseUnifiedDiff } from '../src/parser.js';

const MULTI = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 x
+y
 z
@@ -10,2 +11,3 @@
 m
+n
 o
@@ -100,1 +101,2 @@
+far
 q
`;

describe('chunkFile', () => {
  it('merges nearby hunks and splits far ones', () => {
    const parsed = parseUnifiedDiff(MULTI);
    const chunks = chunkFile(parsed.files[0]!, { mergeGap: 10, maxChars: 9999 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.hunks).toHaveLength(2);
    expect(chunks[1]!.startLine).toBe(101);
  });

  it('returns empty for binary file with no hunks', () => {
    const parsed = parseUnifiedDiff(
      `diff --git a/bin b/bin\nBinary files a/bin and b/bin differ\n`,
    );
    expect(chunkFile(parsed.files[0]!)).toEqual([]);
  });
});
