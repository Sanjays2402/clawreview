import { describe, expect, it } from 'vitest';

import { detectLanguage } from '../src/language.js';
import { minimatch } from '../src/minimatch.js';
import { filterIgnored } from '../src/ignore.js';

describe('detectLanguage', () => {
  it('handles common extensions', () => {
    expect(detectLanguage('a/b/c.ts')).toBe('typescript');
    expect(detectLanguage('snake.py')).toBe('python');
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
  });

  it('returns undefined for unknown extensions', () => {
    expect(detectLanguage('something.xyz')).toBeUndefined();
  });
});

describe('minimatch + filterIgnored', () => {
  it('matches double-star globs', () => {
    expect(minimatch('a/b/c/d.snap', '**/*.snap')).toBe(true);
    expect(minimatch('a/vendor/x.ts', '**/vendor/**')).toBe(true);
    expect(minimatch('src/index.ts', '**/vendor/**')).toBe(false);
  });

  it('filters items by patterns', () => {
    const items = [{ path: 'src/a.ts' }, { path: 'src/__snapshots__/x.snap' }];
    const out = filterIgnored(items, ['**/*.snap']);
    expect(out).toHaveLength(1);
  });
});
