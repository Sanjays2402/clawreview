import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IGNORE_FILENAME,
  loadClawreviewIgnore,
  mergeIgnorePatterns,
} from '../src/ignorefile.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'clawreview-ignorefile-'));
}

describe('loadClawreviewIgnore', () => {
  it('returns an empty result when the file does not exist', async () => {
    const dir = freshDir();
    const r = await loadClawreviewIgnore(dir);
    expect(r.source).toBeNull();
    expect(r.patterns).toEqual([]);
    expect(r.rules).toEqual([]);
  });

  it('parses a gitignore-style file into globs', async () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, DEFAULT_IGNORE_FILENAME),
      [
        '# generated bundles',
        'dist/',
        '*.snap.json',
        '!keep.snap.json',
        '/scripts/legacy.sh',
        '',
      ].join('\n'),
    );
    const r = await loadClawreviewIgnore(dir);
    expect(r.source).toContain(DEFAULT_IGNORE_FILENAME);
    expect(r.patterns).toEqual([
      'dist/**',
      '**/*.snap.json',
      '!**/keep.snap.json',
      'scripts/legacy.sh',
    ]);
    expect(r.rules).toHaveLength(4);
    expect(r.rules[2]).toEqual({ pattern: '**/keep.snap.json', negate: true });
  });

  it('honors a custom filename when specified', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, '.cr-ignore'), 'fixtures/**');
    const r = await loadClawreviewIgnore(dir, '.cr-ignore');
    expect(r.patterns).toEqual(['fixtures/**']);
  });

  it('treats blank lines and comments as no-ops', async () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, DEFAULT_IGNORE_FILENAME),
      ['', '# only a comment', '   ', '', '#another', ''].join('\n'),
    );
    const r = await loadClawreviewIgnore(dir);
    expect(r.patterns).toEqual([]);
  });

  it('propagates non-ENOENT errors', async () => {
    const dir = freshDir();
    // Create a directory at the file path so the read fails with EISDIR.
    mkdirSync(join(dir, DEFAULT_IGNORE_FILENAME));
    await expect(loadClawreviewIgnore(dir)).rejects.toBeDefined();
  });
});

describe('mergeIgnorePatterns', () => {
  it('preserves order with config patterns first', () => {
    const merged = mergeIgnorePatterns(['a', 'b'], ['c', 'd']);
    expect(merged).toEqual(['a', 'b', 'c', 'd']);
  });

  it('deduplicates exact string matches', () => {
    const merged = mergeIgnorePatterns(['a', 'b'], ['b', 'c']);
    expect(merged).toEqual(['a', 'b', 'c']);
  });

  it('keeps negations distinct from their positive counterpart', () => {
    const merged = mergeIgnorePatterns(['dist/**'], ['!dist/keep.json']);
    expect(merged).toEqual(['dist/**', '!dist/keep.json']);
  });

  it('returns a fresh array (does not mutate inputs)', () => {
    const cfg: readonly string[] = ['a'];
    const file: readonly string[] = ['b'];
    const merged = mergeIgnorePatterns(cfg, file);
    merged.push('c');
    expect(cfg).toEqual(['a']);
    expect(file).toEqual(['b']);
  });
});
