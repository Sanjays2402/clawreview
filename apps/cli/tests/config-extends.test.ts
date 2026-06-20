import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, loadLocalPresets, mergeWithExtends } from '../src/config.js';

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

describe('loadLocalPresets', () => {
  it('returns {} when .clawreview/presets is absent', async () => {
    const dir = await tmpDir();
    const out = await loadLocalPresets(dir);
    expect(out).toEqual({});
  });

  it('discovers *.yml files and uses the basename as the preset name', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/team-strict.yml'),
      ['severity_threshold: critical', 'max_findings_per_file: 1', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/team-loose.yaml'),
      ['severity_threshold: high', ''].join('\n'),
      'utf8',
    );
    // Non-YAML files must be ignored.
    await writeFile(join(dir, '.clawreview/presets/README.md'), '# notes\n', 'utf8');
    const out = await loadLocalPresets(dir);
    expect(Object.keys(out).sort()).toEqual(['team-loose', 'team-strict']);
    expect(out['team-strict']!.severity_threshold).toBe('critical');
    expect(out['team-strict']!.max_findings_per_file).toBe(1);
    expect(out['team-loose']!.severity_threshold).toBe('high');
  });

  it('throws on malformed YAML inside a local preset, naming the file', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/broken.yml'),
      'severity_threshold: [unterminated\n',
      'utf8',
    );
    await expect(loadLocalPresets(dir)).rejects.toThrow(/invalid YAML in local preset 'broken'/);
  });

  it('rejects non-mapping YAML at the top level', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(join(dir, '.clawreview/presets/list.yml'), '- one\n- two\n', 'utf8');
    await expect(loadLocalPresets(dir)).rejects.toThrow(/must be a YAML mapping/);
  });

  it('treats an empty file as an empty preset (no error)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(join(dir, '.clawreview/presets/empty.yml'), '', 'utf8');
    const out = await loadLocalPresets(dir);
    expect(out.empty).toEqual({});
  });
});

describe('loadConfig with project-local presets', () => {
  it('extends:my-team resolves to the local preset under .clawreview/presets/my-team.yml', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/my-team.yml'),
      ['severity_threshold: high', 'max_findings_per_file: 2', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview.yml'),
      [
        'extends: my-team',
        'agents: [security]',
        '',
      ].join('\n'),
      'utf8',
    );
    const cfg = await loadConfig(undefined, dir);
    expect(cfg.severity_threshold).toBe('high');
    expect(cfg.max_findings_per_file).toBe(2);
    expect(cfg.agents).toEqual(['security']);
  });

  it('local presets shadow built-ins on name collision so teams can override', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    // The built-in `strict` preset uses severity_threshold=low; the local
    // override flips it to critical. Layered on top of the user file (no
    // overrides), the local value must win.
    await writeFile(
      join(dir, '.clawreview/presets/strict.yml'),
      ['severity_threshold: critical', 'max_findings_per_file: 7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview.yml'),
      ['extends: strict', ''].join('\n'),
      'utf8',
    );
    const cfg = await loadConfig(undefined, dir);
    expect(cfg.severity_threshold).toBe('critical');
    expect(cfg.max_findings_per_file).toBe(7);
  });

  it('mixed extends: [built-in, local] resolves both in order', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/agents-only.yml'),
      ['agents: [security]', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview.yml'),
      [
        'extends:',
        '  - strict',
        '  - agents-only',
        '',
      ].join('\n'),
      'utf8',
    );
    const cfg = await loadConfig(undefined, dir);
    // strict from built-in
    expect(cfg.severity_threshold).toBe('low');
    // local overrides agents (arrays REPLACE)
    expect(cfg.agents).toEqual(['security']);
  });
});
