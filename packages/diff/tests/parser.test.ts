import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from '../src/parser.js';

const SAMPLE = `diff --git a/src/index.ts b/src/index.ts
index 0000000..1111111 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Hello
+World
`;

describe('parseUnifiedDiff', () => {
  it('parses multiple files with statuses and hunks', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    expect(parsed.files).toHaveLength(2);

    const idx = parsed.files[0]!;
    expect(idx.path).toBe('src/index.ts');
    expect(idx.status).toBe('modified');
    expect(idx.language).toBe('typescript');
    expect(idx.hunks).toHaveLength(1);
    expect(idx.hunks[0]!.newStart).toBe(1);
    expect(idx.hunks[0]!.newEndLine).toBe(4);

    const readme = parsed.files[1]!;
    expect(readme.status).toBe('added');
    expect(readme.oldPath).toBeNull();
    expect(readme.newPath).toBe('README.md');
  });

  it('handles a deleted file', () => {
    const diff = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1111111..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files[0]!.status).toBe('deleted');
    expect(parsed.files[0]!.newPath).toBeNull();
  });

  it('returns an empty result for empty input', () => {
    expect(parseUnifiedDiff('').files).toEqual([]);
  });
});
