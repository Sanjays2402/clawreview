import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPresetsList, runPresetsShow } from '../src/commands/presets.js';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clawreview-presets-'));
}

async function run(dir: string, flags: Record<string, string | boolean> = {}): Promise<{
  stdout: string;
  exitCode: number;
}> {
  const stdout: string[] = [];
  const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation(
    ((chunk: unknown) => {
      stdout.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
      return true;
    }) as never,
  );
  process.exitCode = 0;
  try {
    await runPresetsList({
      command: 'presets',
      positional: ['list'],
      flags: { 'no-color': true, root: dir, ...flags },
    });
  } finally {
    writeStdout.mockRestore();
  }
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: stdout.join(''), exitCode: code };
}

afterEach(() => {
  process.exitCode = 0;
});

describe('clawreview presets list', () => {
  it('lists every built-in preset with no local presets present', async () => {
    const dir = await tmpDir();
    const r = await run(dir, { format: 'json' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    // Built-ins shipped today: strict, security-focused, accessibility-first,
    // permissive, nit-friendly. Keep the test loose so adding a preset
    // doesn't break it -- just assert >= 5 and that the known names are in
    // there.
    expect(parsed.builtinCount).toBeGreaterThanOrEqual(5);
    expect(parsed.localCount).toBe(0);
    const names = new Set(parsed.presets.map((p: { name: string }) => p.name));
    for (const n of ['strict', 'security-focused', 'permissive', 'nit-friendly']) {
      expect(names.has(n)).toBe(true);
    }
    for (const p of parsed.presets) {
      expect(p.source).toBe('builtin');
      expect(p.extends).toEqual([]);
    }
  });

  it('surfaces local presets and their declared extends chain', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/web-strict.yml'),
      ['extends: [strict, security-focused]', 'severity_threshold: high', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/team-internal.yml'),
      'severity_threshold: medium\n',
      'utf8',
    );

    const r = await run(dir, { format: 'json' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.localCount).toBe(2);
    const web = parsed.presets.find((p: { name: string }) => p.name === 'web-strict');
    expect(web.source).toBe('local');
    expect(web.extends).toEqual(['strict', 'security-focused']);
    expect(web.fields).toContain('severity_threshold');
    const team = parsed.presets.find((p: { name: string }) => p.name === 'team-internal');
    expect(team.source).toBe('local');
    expect(team.extends).toEqual([]);
    expect(team.shadowsBuiltin).toBe(false);
  });

  it('marks a local preset that shadows a built-in', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/strict.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    const r = await run(dir, { format: 'json' });
    const parsed = JSON.parse(r.stdout);
    const strict = parsed.presets.filter((p: { name: string }) => p.name === 'strict');
    expect(strict).toHaveLength(1); // built-in is hidden
    expect(strict[0].source).toBe('local');
    expect(strict[0].shadowsBuiltin).toBe(true);
  });

  it('text output renders each preset with a tag and the fields it populates', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/api-defaults.yml'),
      ['extends: permissive', 'severity_threshold: high', ''].join('\n'),
      'utf8',
    );
    const r = await run(dir);
    expect(r.exitCode).toBe(0);
    // Header mentions the counts.
    expect(r.stdout).toMatch(/ClawReview presets/);
    // Each built-in lands as `built-in`.
    expect(r.stdout).toMatch(/strict\s+built-in/);
    // The new local shows up with its tag, declared chain, and populated keys.
    expect(r.stdout).toMatch(/api-defaults\s+local\b/);
    expect(r.stdout).toMatch(/extends:\s+permissive/);
    expect(r.stdout).toMatch(/sets:\s+.*severity_threshold/);
  });

  it('accepts a single-string extends (not an array)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/single.yml'),
      ['extends: nit-friendly', 'max_findings_per_file: 4', ''].join('\n'),
      'utf8',
    );
    const r = await run(dir, { format: 'json' });
    const parsed = JSON.parse(r.stdout);
    const single = parsed.presets.find((p: { name: string }) => p.name === 'single');
    expect(single.extends).toEqual(['nit-friendly']);
  });

  it('sorts every preset by name in the output', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(join(dir, '.clawreview/presets/zeta.yml'), 'severity_threshold: low\n', 'utf8');
    await writeFile(join(dir, '.clawreview/presets/alpha.yml'), 'severity_threshold: low\n', 'utf8');
    const r = await run(dir, { format: 'json' });
    const parsed = JSON.parse(r.stdout);
    const names = parsed.presets.map((p: { name: string }) => p.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});

async function runShow(
  dir: string,
  positional: string[],
  flags: Record<string, string | boolean> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation(
    ((chunk: unknown) => {
      stdout.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
      return true;
    }) as never,
  );
  const writeStderr = vi.spyOn(process.stderr, 'write').mockImplementation(
    ((chunk: unknown) => {
      stderr.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
      return true;
    }) as never,
  );
  process.exitCode = 0;
  try {
    await runPresetsShow({
      command: 'presets',
      positional: ['show', ...positional],
      flags: { 'no-color': true, root: dir, ...flags },
    });
  } finally {
    writeStdout.mockRestore();
    writeStderr.mockRestore();
  }
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code };
}

describe('clawreview presets show', () => {
  it('prints a built-in preset body as YAML by default with a header comment', async () => {
    const dir = await tmpDir();
    const r = await runShow(dir, ['strict']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('# clawreview preset: strict');
    expect(r.stdout).toContain('# source: builtin');
    // Body should contain at least one populated field from the strict preset.
    expect(r.stdout).toMatch(/severity_threshold:/);
  });

  it('prints a local preset with its resolved extends chain in JSON', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/web-strict.yml'),
      ['extends: [strict, security-focused]', 'severity_threshold: high', ''].join('\n'),
      'utf8',
    );
    const r = await runShow(dir, ['web-strict'], { format: 'json' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.name).toBe('web-strict');
    expect(parsed.source).toBe('local');
    expect(parsed.extends).toEqual(['strict', 'security-focused']);
    expect(parsed.shadowsBuiltin).toBe(false);
    // The body must be the merged extends chain + the file's own field.
    // The local file's `severity_threshold: high` should win over any
    // built-in default in the chain (last-write wins via mergePresets).
    expect(parsed.body.severity_threshold).toBe('high');
    expect(parsed.fields).toContain('severity_threshold');
  });

  it('flags shadowsBuiltin when a local preset overrides a built-in name', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/strict.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runShow(dir, ['strict'], { format: 'json' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.source).toBe('local');
    expect(parsed.shadowsBuiltin).toBe(true);
    // Local body should win over the built-in's default.
    expect(parsed.body.severity_threshold).toBe('low');
  });

  it('exits 1 with a helpful list when the preset name is unknown', async () => {
    const dir = await tmpDir();
    const r = await runShow(dir, ['bogus'], { format: 'json' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown preset 'bogus'");
    // The list of available names should include built-ins.
    expect(r.stderr).toContain('strict');
  });

  it('exits 2 when --format is invalid', async () => {
    const dir = await tmpDir();
    const r = await runShow(dir, ['strict'], { format: 'xml' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--format must be yaml|json|text');
  });

  it('exits 2 when <name> is omitted', async () => {
    const dir = await tmpDir();
    // Force a positional length of zero by passing only ['show'] sentinel,
    // which runShow will turn into ['show'] (no further arg).
    const stdout: string[] = [];
    const stderr: string[] = [];
    const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation(
      ((chunk: unknown) => {
        stdout.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
        return true;
      }) as never,
    );
    const writeStderr = vi.spyOn(process.stderr, 'write').mockImplementation(
      ((chunk: unknown) => {
        stderr.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
        return true;
      }) as never,
    );
    process.exitCode = 0;
    try {
      await runPresetsShow({
        command: 'presets',
        positional: ['show'],
        flags: { 'no-color': true, root: dir },
      });
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('missing <name>');
  });

  it('renders text format with key: value lines for scalar fields', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/scalar-only.yml'),
      ['severity_threshold: high', 'max_findings_per_file: 5', ''].join('\n'),
      'utf8',
    );
    const r = await runShow(dir, ['scalar-only'], { format: 'text' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/scalar-only\s+local/);
    expect(r.stdout).toMatch(/severity_threshold:\s+high/);
    expect(r.stdout).toMatch(/max_findings_per_file:\s+5/);
  });

  it('json output includes fields list and body together for tooling consumption', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/composed.yml'),
      ['extends: nit-friendly', 'severity_threshold: high', 'max_findings_per_file: 12', ''].join('\n'),
      'utf8',
    );
    const r = await runShow(dir, ['composed'], { format: 'json' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.fields).toContain('severity_threshold');
    expect(parsed.fields).toContain('max_findings_per_file');
    expect(parsed.body.severity_threshold).toBe('high');
    expect(parsed.body.max_findings_per_file).toBe(12);
    expect(parsed.extends).toEqual(['nit-friendly']);
  });
});
