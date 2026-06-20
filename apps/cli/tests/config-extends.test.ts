import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, mergeWithExtends } from '../src/config.js';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clawreview-cfg-'));
}

describe('mergeWithExtends', () => {
  it('returns the raw config untouched when no extends is set', () => {
    const input = { severity_threshold: 'medium', agents: ['security'] };
    const out = mergeWithExtends(input);
    expect(out).toEqual(input);
  });

  it('applies a single string preset then layers user fields on top', () => {
    const out = mergeWithExtends({
      extends: 'strict',
      max_findings_per_file: 99,
    });
    // strict sets max_findings_per_file=4; user override wins.
    expect(out.max_findings_per_file).toBe(99);
    // strict sets severity_threshold=low which survives.
    expect(out.severity_threshold).toBe('low');
    // extends key is stripped before schema parse.
    expect(out.extends).toBeUndefined();
  });

  it('applies multiple presets left-to-right, then layers user fields', () => {
    const out = mergeWithExtends({
      extends: ['security-focused', 'strict'],
      severity_threshold: 'critical',
    });
    // strict ran after security-focused -> max_findings_per_file=4.
    expect(out.max_findings_per_file).toBe(4);
    // strict.severity_threshold=low; user override wins -> critical.
    expect(out.severity_threshold).toBe('critical');
  });

  it('throws a helpful error for an unknown preset', () => {
    expect(() =>
      mergeWithExtends({ extends: ['not-a-real-preset'] }),
    ).toThrow(/unknown preset 'not-a-real-preset'/);
  });
});

describe('loadConfig with extends', () => {
  it('loads a YAML file whose extends pulls in a built-in preset', async () => {
    const dir = await tmpDir();
    await writeFile(
      join(dir, '.clawreview.yml'),
      [
        'extends: strict',
        'agents: [security, performance]',
        '',
      ].join('\n'),
      'utf8',
    );
    const cfg = await loadConfig(undefined, dir);
    // strict bumps inline comments on.
    expect(cfg.inline_comments.enabled).toBe(true);
    // user-supplied agents win over the preset's default.
    expect(cfg.agents).toEqual(['security', 'performance']);
  });

  it('layers user fields over multiple presets in chain order', async () => {
    const dir = await tmpDir();
    await writeFile(
      join(dir, '.clawreview.yml'),
      [
        'extends:',
        '  - security-focused',
        '  - nit-friendly',
        'budget:',
        '  monthly_usd: 200',
        '',
      ].join('\n'),
      'utf8',
    );
    const cfg = await loadConfig(undefined, dir);
    // nit-friendly drops threshold to nit (last preset wins).
    expect(cfg.severity_threshold).toBe('nit');
    // budget user override wins.
    expect(cfg.budget.monthly_usd).toBe(200);
  });

  it('still returns DEFAULT_CONFIG when the file does not exist', async () => {
    const dir = await tmpDir();
    const cfg = await loadConfig(undefined, dir);
    expect(cfg.severity_threshold).toBe('low');
    expect(cfg.agents).toContain('security');
  });
});
