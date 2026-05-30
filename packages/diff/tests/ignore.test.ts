import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IGNORE_PATTERNS,
  filterIgnored,
  isIgnored,
  parseIgnoreFile,
} from '../src/ignore.js';

describe('parseIgnoreFile', () => {
  it('skips blank lines and comments', () => {
    const rules = parseIgnoreFile(`
      # comment
      *.log

      docs/
    `);
    expect(rules.map((r) => r.pattern)).toEqual(['**/*.log', 'docs/**']);
    expect(rules.every((r) => !r.negate)).toBe(true);
  });

  it('parses negations and anchors', () => {
    const rules = parseIgnoreFile('!keep.md\n/root-only.txt\n');
    expect(rules[0]).toEqual({ pattern: '**/keep.md', negate: true });
    expect(rules[1]).toEqual({ pattern: 'root-only.txt', negate: false });
  });

  it('promotes directory patterns to recursive globs', () => {
    expect(parseIgnoreFile('build/')).toEqual([{ pattern: 'build/**', negate: false }]);
  });
});

describe('isIgnored', () => {
  it('lets later rules override earlier ones', () => {
    const rules = parseIgnoreFile('*.md\n!README.md\n');
    expect(isIgnored('docs/notes.md', rules)).toBe(true);
    expect(isIgnored('README.md', rules)).toBe(false);
  });

  it('returns false when nothing matches', () => {
    expect(isIgnored('src/foo.ts', parseIgnoreFile('*.py'))).toBe(false);
  });
});

describe('filterIgnored', () => {
  it('applies default patterns automatically', () => {
    const items = [
      { path: 'src/app.ts' },
      { path: 'node_modules/lodash/index.js' },
      { path: 'pnpm-lock.yaml' },
      { path: 'web/dist/main.js' },
      { path: 'docs/guide.md' },
    ];
    const kept = filterIgnored(items, []);
    expect(kept.map((i) => i.path)).toEqual(['src/app.ts', 'docs/guide.md']);
  });

  it('honors includeDefaults: false', () => {
    const items = [{ path: 'pnpm-lock.yaml' }, { path: 'src/app.ts' }];
    const kept = filterIgnored(items, [], { includeDefaults: false });
    expect(kept).toHaveLength(2);
  });

  it('supports IgnoreRule objects and string patterns side by side', () => {
    const items = [
      { path: 'docs/secret.md' },
      { path: 'docs/public.md' },
      { path: 'src/index.ts' },
    ];
    const rules = parseIgnoreFile('docs/\n!docs/public.md\n');
    const kept = filterIgnored(items, rules, { includeDefaults: false });
    expect(kept.map((i) => i.path)).toEqual(['docs/public.md', 'src/index.ts']);
  });

  it('default patterns cover common lockfiles and build artifacts', () => {
    for (const p of [
      'package-lock.json',
      'yarn.lock',
      'Cargo.lock',
      'web/dist/app.min.js',
      'web/dist/app.js.map',
      'coverage/index.html',
    ]) {
      expect(filterIgnored([{ path: p }], [])).toHaveLength(0);
    }
  });

  it('exposes the default list as a frozen array', () => {
    expect(Object.isFrozen(DEFAULT_IGNORE_PATTERNS)).toBe(true);
    expect(DEFAULT_IGNORE_PATTERNS.length).toBeGreaterThan(10);
  });
});
