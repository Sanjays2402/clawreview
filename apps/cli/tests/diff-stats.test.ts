import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '@clawreview/diff';

import { computeDiffStats, renderDiffStatsText } from '../src/commands/diff-stats.js';

const SAMPLE = `diff --git a/src/auth.ts b/src/auth.ts
index 1234..5678 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,6 @@
 export function authenticate(token: string): boolean {
-  return token === 'admin';
+  if (!token) return false;
+  if (token.length < 8) return false;
+  return verifyHmac(token);
 }
diff --git a/src/util.py b/src/util.py
new file mode 100644
index 0000..abcd
--- /dev/null
+++ b/src/util.py
@@ -0,0 +1,4 @@
+def helper():
+    pass
+
+# trailing
diff --git a/old.js b/old.js
deleted file mode 100644
index abcd..0000
--- a/old.js
+++ /dev/null
@@ -1,2 +0,0 @@
-const old = true;
-export default old;
diff --git a/binary.png b/binary.png
new file mode 100644
index 0000..1234
Binary files /dev/null and b/binary.png differ
`;

describe('computeDiffStats', () => {
  it('counts files, hunks, and +/- lines across the diff', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    const stats = computeDiffStats(parsed.files);
    expect(stats.totals.files).toBe(4);
    expect(stats.totals.hunks).toBe(3); // binary file has no hunks
    expect(stats.totals.addedLines).toBe(3 + 4); // auth.ts: +3, util.py: +4
    expect(stats.totals.removedLines).toBe(1 + 2); // auth.ts: -1, old.js: -2
    expect(stats.totals.changedLines).toBe(10);
    expect(stats.totals.binaryFiles).toBe(1);
  });

  it('groups files by status', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    const stats = computeDiffStats(parsed.files);
    expect(stats.byStatus.modified).toBe(1);
    expect(stats.byStatus.added).toBe(2);
    expect(stats.byStatus.deleted).toBe(1);
  });

  it('aggregates by detected language, sorted by changed-lines desc', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    const stats = computeDiffStats(parsed.files);
    const ts = stats.byLanguage.find((l) => l.language === 'typescript');
    const py = stats.byLanguage.find((l) => l.language === 'python');
    expect(ts?.files).toBe(1);
    expect(ts?.addedLines).toBe(3);
    expect(ts?.removedLines).toBe(1);
    expect(py?.files).toBe(1);
    expect(py?.addedLines).toBe(4);
    // Sorted desc by changedLines: py (4) before ts (4) tie-broken by name,
    // then js (2) then unknown (binary, 0).
    expect(stats.byLanguage[0]!.changedLines).toBeGreaterThanOrEqual(
      stats.byLanguage[stats.byLanguage.length - 1]!.changedLines,
    );
  });

  it('returns the top-10 largest files ordered by total changed lines', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    const stats = computeDiffStats(parsed.files);
    expect(stats.largestFiles.length).toBe(4);
    // Largest by changedLines should come first.
    const first = stats.largestFiles[0]!;
    expect(first.changedLines).toBeGreaterThanOrEqual(stats.largestFiles[1]!.changedLines);
  });

  it('does not double-count diff header lines (+++ / ---) as added/removed', () => {
    const sample = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-foo
+bar
`;
    const parsed = parseUnifiedDiff(sample);
    const stats = computeDiffStats(parsed.files);
    expect(stats.totals.addedLines).toBe(1);
    expect(stats.totals.removedLines).toBe(1);
  });

  it('returns zeroed totals for an empty file list', () => {
    const stats = computeDiffStats([]);
    expect(stats.totals.files).toBe(0);
    expect(stats.totals.hunks).toBe(0);
    expect(stats.totals.addedLines).toBe(0);
    expect(stats.totals.changedLines).toBe(0);
    expect(stats.byLanguage).toEqual([]);
    expect(stats.largestFiles).toEqual([]);
  });
});

describe('renderDiffStatsText', () => {
  it('produces a readable human summary with totals, languages, and largest files', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    const stats = computeDiffStats(parsed.files);
    const out = renderDiffStatsText(stats, { noColor: true });
    expect(out).toContain('ClawReview diff stats');
    expect(out).toContain('4 files');
    expect(out).toContain('+7');
    expect(out).toContain('-3');
    expect(out).toContain('By language');
    expect(out).toContain('typescript');
    expect(out).toContain('python');
    expect(out).toContain('Largest files');
    expect(out).toContain('src/util.py');
    expect(out).toContain('binary');
  });

  it('omits the "binary" footnote when there are no binary files', () => {
    const sample = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-foo
+bar
`;
    const parsed = parseUnifiedDiff(sample);
    const stats = computeDiffStats(parsed.files);
    const out = renderDiffStatsText(stats, { noColor: true });
    expect(out).not.toContain('binary');
  });
});
