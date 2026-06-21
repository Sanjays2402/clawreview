import { describe, expect, it } from 'vitest';
import type { Finding } from '@clawreview/types';

import { applySuppressions, buildSuppressionMap } from '../src/suppress.js';

function finding(partial: Partial<Finding> & Pick<Finding, 'file' | 'startLine' | 'agent'>): Finding {
  return {
    agent: partial.agent,
    category: partial.category ?? 'security',
    severity: partial.severity ?? 'high',
    title: partial.title ?? 'test issue',
    rationale: partial.rationale ?? 'because',
    file: partial.file,
    startLine: partial.startLine,
    endLine: partial.endLine,
    confidence: partial.confidence ?? 0.8,
    tags: partial.tags ?? [],
  };
}

const DIFF_SAME_LINE = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const password = "hunter2"; // clawreview-ignore
+const ok = true;
 const b = 2;
`;

const DIFF_NEXT_LINE = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,5 @@
 // file
+// clawreview-ignore-next-line: secrets
+const token = "abc";
+const noSuppress = 1;
`;

const DIFF_SCOPED = `diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,1 +1,3 @@
 x
+const sql = "SELECT * FROM users WHERE id = " + id; // clawreview-ignore: sql-injection
+const other = "y";
`;

const DIFF_DISABLE_FILE = `diff --git a/src/legacy.ts b/src/legacy.ts
--- a/src/legacy.ts
+++ b/src/legacy.ts
@@ -1,0 +1,4 @@
+// clawreview-disable-file
+const a = 1;
+const b = 2;
+const c = 3;
`;

const DIFF_DISABLE_FILE_SCOPED = `diff --git a/src/styles.ts b/src/styles.ts
--- a/src/styles.ts
+++ b/src/styles.ts
@@ -1,0 +1,3 @@
+// clawreview-disable-file: style
+const a = 1;
+const b = 2;
`;

describe('buildSuppressionMap', () => {
  it('marks a same-line clawreview-ignore as covering all rules', () => {
    const map = buildSuppressionMap(DIFF_SAME_LINE);
    const fileMap = map.byFile.get('src/a.ts')!;
    expect(fileMap).toBeDefined();
    // hunk starts at new line 1, context line `const a = 1;` -> line 1, then
    // added `const password` -> line 2 (suppressed), added `const ok` -> line 3.
    expect(fileMap.get(2)?.rules.size).toBe(0); // empty == all rules
    expect(fileMap.get(3)).toBeUndefined();
  });

  it('applies next-line markers only to the next added line', () => {
    const map = buildSuppressionMap(DIFF_NEXT_LINE);
    const fileMap = map.byFile.get('src/b.ts')!;
    // line 1 = context "// file"
    // line 2 = added "// clawreview-ignore-next-line: secrets"  (not suppressed itself)
    // line 3 = added "const token" -> should carry { rules: { secrets } }
    // line 4 = added "const noSuppress" -> not covered
    expect(fileMap.get(3)?.rules.has('secrets')).toBe(true);
    expect(fileMap.get(4)).toBeUndefined();
  });

  it('parses comma-separated scoped rule lists', () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -0,0 +1,2 @@
+// clawreview-ignore-next-line: security, performance
+const z = 1;
`;
    const map = buildSuppressionMap(diff);
    const sup = map.byFile.get('x.ts')!.get(2)!;
    expect([...sup.rules].sort()).toEqual(['performance', 'security']);
  });

  it('ignores binary and pure-context files', () => {
    const diff = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;
    const map = buildSuppressionMap(diff);
    expect(map.byFile.size).toBe(0);
  });

  it('records a file-level clawreview-disable-file marker as "all rules"', () => {
    const map = buildSuppressionMap(DIFF_DISABLE_FILE);
    const sup = map.fileLevel.get('src/legacy.ts');
    expect(sup).toBeDefined();
    expect(sup!.rules.size).toBe(0);
    // The disable-file line itself must NOT also land in the per-line map,
    // otherwise we'd double-account it as an "ignore" marker.
    expect(map.byFile.get('src/legacy.ts')).toBeUndefined();
  });

  it('honours scoped file-level markers', () => {
    const map = buildSuppressionMap(DIFF_DISABLE_FILE_SCOPED);
    const sup = map.fileLevel.get('src/styles.ts')!;
    expect([...sup.rules]).toEqual(['style']);
  });
});

describe('applySuppressions', () => {
  it('drops findings on a same-line all-rule marker', () => {
    const map = buildSuppressionMap(DIFF_SAME_LINE);
    const res = applySuppressions(
      [
        finding({ file: 'src/a.ts', startLine: 2, agent: 'secrets', category: 'secrets' }),
        finding({ file: 'src/a.ts', startLine: 3, agent: 'secrets', category: 'secrets' }),
      ],
      map,
    );
    expect(res.suppressed).toHaveLength(1);
    expect(res.kept).toHaveLength(1);
    expect(res.kept[0]!.startLine).toBe(3);
  });

  it('only suppresses when the agent or category matches a scoped rule', () => {
    const map = buildSuppressionMap(DIFF_SCOPED);
    const res = applySuppressions(
      [
        // scoped to sql-injection -> agent match
        finding({
          file: 'src/c.ts',
          startLine: 2,
          agent: 'sql-injection',
          category: 'sql-injection',
        }),
        // same line but a different agent/category -> NOT suppressed
        finding({ file: 'src/c.ts', startLine: 2, agent: 'style', category: 'style' }),
      ],
      map,
    );
    expect(res.suppressed.map((f) => f.agent)).toEqual(['sql-injection']);
    expect(res.kept.map((f) => f.agent)).toEqual(['style']);
  });

  it('requires the full multi-line range to be covered before suppressing', () => {
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -0,0 +1,4 @@
+const a = 1; // clawreview-ignore
+const b = 2;
+const c = 3; // clawreview-ignore
+const d = 4;
`;
    const map = buildSuppressionMap(diff);
    const res = applySuppressions(
      [
        finding({
          file: 'm.ts',
          startLine: 1,
          endLine: 2,
          agent: 'security',
          category: 'security',
        }),
        finding({
          file: 'm.ts',
          startLine: 1,
          endLine: 1,
          agent: 'security',
          category: 'security',
        }),
      ],
      map,
    );
    // Spanning lines 1-2: line 2 has no marker, so NOT fully covered.
    expect(res.kept).toHaveLength(1);
    expect(res.kept[0]!.endLine).toBe(2);
    // Single line 1: fully covered.
    expect(res.suppressed).toHaveLength(1);
  });

  it('returns findings unchanged when the diff has no markers', () => {
    const diff = `diff --git a/q.ts b/q.ts
--- a/q.ts
+++ b/q.ts
@@ -0,0 +1,1 @@
+const x = 1;
`;
    const map = buildSuppressionMap(diff);
    const fs = [finding({ file: 'q.ts', startLine: 1, agent: 'style', category: 'style' })];
    const res = applySuppressions(fs, map);
    expect(res.kept).toEqual(fs);
    expect(res.suppressed).toEqual([]);
  });

  it('drops every finding in a file marked clawreview-disable-file', () => {
    const map = buildSuppressionMap(DIFF_DISABLE_FILE);
    const res = applySuppressions(
      [
        finding({ file: 'src/legacy.ts', startLine: 2, agent: 'style', category: 'style' }),
        finding({ file: 'src/legacy.ts', startLine: 999, agent: 'security', category: 'security' }),
      ],
      map,
    );
    expect(res.suppressed).toHaveLength(2);
    expect(res.kept).toHaveLength(0);
  });

  it('respects rule scope on a file-level marker', () => {
    const map = buildSuppressionMap(DIFF_DISABLE_FILE_SCOPED);
    const res = applySuppressions(
      [
        finding({ file: 'src/styles.ts', startLine: 2, agent: 'style', category: 'style' }),
        // security is not in the file-level scope -> kept
        finding({ file: 'src/styles.ts', startLine: 2, agent: 'security', category: 'security' }),
      ],
      map,
    );
    expect(res.suppressed.map((f) => f.agent)).toEqual(['style']);
    expect(res.kept.map((f) => f.agent)).toEqual(['security']);
  });

  it('does not touch findings in unrelated files when a file-level marker exists elsewhere', () => {
    const map = buildSuppressionMap(DIFF_DISABLE_FILE);
    const res = applySuppressions(
      [finding({ file: 'src/other.ts', startLine: 1, agent: 'style', category: 'style' })],
      map,
    );
    expect(res.kept).toHaveLength(1);
  });
});
