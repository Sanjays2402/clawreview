import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPresetsList } from '../src/commands/presets.js';

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
