import { describe, expect, it } from 'vitest';
import type { Finding } from '@clawreview/types';

import { buildInlineComments, commentableLines } from '../src/inline.js';

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,9 @@ export function login(user: User) {
   const session = createSession(user);
   logger.info('logged in');
   return session;
+}
+export function logout(user: User) {
+  destroySession(user);
 }
diff --git a/src/util.ts b/src/util.ts
index 3333333..4444444 100644
--- a/src/util.ts
+++ b/src/util.ts
@@ -1,3 +1,4 @@
 export const VERSION = '1.0.0';
+export const BUILD = 'dev';
 export const NAME = 'demo';
`;

function f(over: Partial<Finding> = {}): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'high',
    title: 'Risk',
    rationale: 'unsafe',
    file: 'src/auth.ts',
    startLine: 13,
    confidence: 0.9,
    tags: [],
    ...over,
  } as Finding;
}

describe('commentableLines', () => {
  it('returns added and context lines per file', () => {
    const lines = commentableLines(DIFF);
    const auth = lines.get('src/auth.ts')!;
    // hunk starts at newStart=10; lines 10,11,12 are context, 13,14,15 added, 16 context
    expect(auth.has(13)).toBe(true);
    expect(auth.has(14)).toBe(true);
    expect(auth.has(15)).toBe(true);
    expect(auth.has(10)).toBe(true);
    expect(auth.has(99)).toBe(false);

    const util = lines.get('src/util.ts')!;
    expect(util.has(2)).toBe(true);
    expect(util.has(50)).toBe(false);
  });
});

describe('buildInlineComments', () => {
  it('anchors findings on lines present in the diff and drops the rest', () => {
    const findings = [
      f({ file: 'src/auth.ts', startLine: 13, title: 'session leak' }),
      f({ file: 'src/auth.ts', startLine: 99, title: 'off-diff' }),
      f({ file: 'src/util.ts', startLine: 2, severity: 'medium', title: 'magic string' }),
    ];
    const { anchored, unanchored } = buildInlineComments(findings, DIFF);
    expect(anchored.map((a) => `${a.path}:${a.line}`)).toEqual([
      'src/auth.ts:13',
      'src/util.ts:2',
    ]);
    expect(anchored[0].body).toContain('session leak');
    expect(anchored[0].body).toContain('High');
    expect(unanchored).toHaveLength(1);
    expect(unanchored[0].title).toBe('off-diff');
  });

  it('honors minSeverity', () => {
    const findings = [
      f({ severity: 'nit', startLine: 13 }),
      f({ severity: 'critical', startLine: 14 }),
    ];
    const { anchored } = buildInlineComments(findings, DIFF, { minSeverity: 'high' });
    expect(anchored).toHaveLength(1);
    expect(anchored[0].line).toBe(14);
  });

  it('caps output at max', () => {
    const findings = Array.from({ length: 10 }, (_, i) =>
      f({ startLine: 13 + (i % 3) }),
    );
    const { anchored } = buildInlineComments(findings, DIFF, { max: 3 });
    expect(anchored).toHaveLength(3);
  });

  it('skips deleted files', () => {
    const deletedDiff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const X = 1;
-export const Y = 2;
`;
    const lines = commentableLines(deletedDiff);
    expect(lines.size).toBe(0);
    const { anchored, unanchored } = buildInlineComments(
      [f({ file: 'old.ts', startLine: 1 })],
      deletedDiff,
    );
    expect(anchored).toHaveLength(0);
    expect(unanchored).toHaveLength(1);
  });

  it('renders suggested fix as a GitHub suggestion block', () => {
    const finding = f({
      startLine: 13,
      suggested: {
        description: 'guard the session',
        diff: 'if (!user) return;',
      } as Finding['suggested'],
    });
    const { anchored } = buildInlineComments([finding], DIFF);
    expect(anchored[0].body).toContain('```suggestion');
    expect(anchored[0].body).toContain('if (!user) return;');
  });
});
