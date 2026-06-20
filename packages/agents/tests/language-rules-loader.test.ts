import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  __setLanguageRulesDir,
  formatLanguageRulesBlock,
  loadLanguageRules,
} from '../src/language-rules-loader.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'clawreview-lang-rules-'));
}

describe('loadLanguageRules', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
    __setLanguageRulesDir(dir);
  });
  afterEach(() => {
    __setLanguageRulesDir(null);
  });

  it('returns null when no language is provided', async () => {
    expect(await loadLanguageRules(undefined)).toBeNull();
    expect(await loadLanguageRules('')).toBeNull();
  });

  it('returns null when the rule sheet is missing', async () => {
    expect(await loadLanguageRules('nonexistent')).toBeNull();
  });

  it('reads and trims a matching <language>.md file', async () => {
    writeFileSync(join(dir, 'python.md'), '   # Python notes\n\nflag eval.\n   ');
    expect(await loadLanguageRules('python')).toBe('# Python notes\n\nflag eval.');
  });

  it('matches case-insensitively', async () => {
    writeFileSync(join(dir, 'go.md'), '# Go');
    expect(await loadLanguageRules('Go')).toBe('# Go');
    expect(await loadLanguageRules('GO')).toBe('# Go');
  });

  it('treats javascript as an alias for typescript', async () => {
    writeFileSync(join(dir, 'typescript.md'), '# TS');
    expect(await loadLanguageRules('javascript')).toBe('# TS');
  });

  it('caches reads — second call does not re-read the disk', async () => {
    writeFileSync(join(dir, 'rust.md'), '# Rust v1');
    expect(await loadLanguageRules('rust')).toBe('# Rust v1');
    writeFileSync(join(dir, 'rust.md'), '# Rust v2 - WOULD BE NEW');
    expect(await loadLanguageRules('rust')).toBe('# Rust v1');
  });

  it('propagates non-ENOENT errors (e.g. EISDIR)', async () => {
    mkdirSync(join(dir, 'sql.md'));
    await expect(loadLanguageRules('sql')).rejects.toBeDefined();
  });
});

describe('formatLanguageRulesBlock', () => {
  it('renders a fenced header for the model', () => {
    const block = formatLanguageRulesBlock('# python\n- no eval');
    expect(block).toBe(
      '\n\nLanguage-specific rules (apply these in addition to your agent goal):\n# python\n- no eval',
    );
  });
});
