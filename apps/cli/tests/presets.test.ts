import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPresetsDiff, runPresetsList, runPresetsResolve, runPresetsShow } from '../src/commands/presets.js';
import {
  filterPresetDelta,
  filterPresetDeltaExcluding,
  ONLY_FIELDS_EMPTY_ENTRY,
  parsePresetOnlyFields,
  parsePresetDiffMaxOutputBytes,
  enforcePresetDiffSizeCap,
  PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES,
  PRESET_DIFF_MAX_OUTPUT_BYTES_CEILING,
  resolvePresetDiffOutputPath,
  STDOUT_SENTINEL,
} from '../src/commands/presets.js';

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

async function runResolve(
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
    await runPresetsResolve({
      command: 'presets',
      positional: ['resolve', ...positional],
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

describe('clawreview presets resolve', () => {
  it('resolves a single built-in chain into a yaml body with header comments', async () => {
    const dir = await tmpDir();
    const r = await runResolve(dir, ['strict']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('# clawreview preset chain: strict');
    expect(r.stdout).toContain('# sources: strict=builtin');
    // The strict preset populates at least one well-known field; assert
    // it lands in the rendered body.
    expect(r.stdout).toMatch(/severity_threshold:/);
  });

  it('resolves a multi-preset chain left-to-right (last writer wins)', async () => {
    const dir = await tmpDir();
    const r = await runResolve(dir, ['strict,nit-friendly'], { format: 'json' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chain).toEqual(['strict', 'nit-friendly']);
    expect(parsed.sources).toEqual([
      { name: 'strict', source: 'builtin', shadowsBuiltin: false },
      { name: 'nit-friendly', source: 'builtin', shadowsBuiltin: false },
    ]);
    // Body is the merged extends. We don't assert exact values (they
    // depend on the built-in preset definitions); we just assert that
    // both presets contributed something so the merge actually ran.
    expect(parsed.fields.length).toBeGreaterThan(0);
    expect(typeof parsed.body).toBe('object');
  });

  it('attributes local presets in the sources block and resolves their extends', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/team-api.yml'),
      ['extends: [strict]', 'severity_threshold: high', ''].join('\n'),
      'utf8',
    );
    const r = await runResolve(dir, ['team-api'], { format: 'json' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.sources[0]).toEqual({
      name: 'team-api',
      source: 'local',
      shadowsBuiltin: false,
    });
    // The local file's `severity_threshold: high` wins over anything in
    // `strict` (last-write semantics).
    expect(parsed.body.severity_threshold).toBe('high');
  });

  it('flags shadowsBuiltin when a local preset overrides a built-in name in the chain', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/strict.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runResolve(dir, ['strict'], { format: 'json' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.sources[0]).toEqual({
      name: 'strict',
      source: 'local',
      shadowsBuiltin: true,
    });
    // Local body wins over the built-in default.
    expect(parsed.body.severity_threshold).toBe('low');
  });

  it('exits 2 with the chain in the error when a name is unknown', async () => {
    const dir = await tmpDir();
    const r = await runResolve(dir, ['strict,bogus-name'], { format: 'json' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown preset 'bogus-name'");
    // The chain appears in the error so the operator can find the bad alias.
    expect(r.stderr).toContain('chain: strict -> bogus-name');
  });

  it('exits 2 with the chain when a duplicate name introduces a cycle', async () => {
    const dir = await tmpDir();
    const r = await runResolve(dir, ['strict,strict'], { format: 'json' });
    expect(r.exitCode).toBe(2);
    // resolveExtendsChain emits "preset cycle detected at 'strict'".
    expect(r.stderr).toContain('cycle detected');
  });

  it('exits 2 when the chain contains an empty entry (stray comma)', async () => {
    const dir = await tmpDir();
    const r = await runResolve(dir, ['strict,,nit-friendly'], { format: 'json' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('empty entry');
  });

  it('exits 1 when no chain is provided (no positional, no --chain)', async () => {
    const dir = await tmpDir();
    // Use a hand-built run that omits the positional entirely.
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
      await runPresetsResolve({
        command: 'presets',
        positional: ['resolve'],
        flags: { 'no-color': true, root: dir },
      });
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('missing <chain>');
    process.exitCode = 0;
  });

  it('exits 2 when --format is invalid', async () => {
    const dir = await tmpDir();
    const r = await runResolve(dir, ['strict'], { format: 'xml' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--format must be yaml|json|text');
  });

  it('accepts --chain as an alternative to the positional', async () => {
    const dir = await tmpDir();
    const r = await runResolve(dir, [], { chain: 'strict', format: 'json' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chain).toEqual(['strict']);
  });

  it('trims whitespace around chain entries', async () => {
    const dir = await tmpDir();
    const r = await runResolve(dir, ['  strict , nit-friendly  '], { format: 'json' });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chain).toEqual(['strict', 'nit-friendly']);
  });

  it('text format renders the chain with source tags and the populated keys', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/local-only.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    const r = await runResolve(dir, ['strict,local-only'], { format: 'text' });
    expect(r.exitCode).toBe(0);
    // The text header annotates each chain entry with its source.
    expect(r.stdout).toMatch(/chain:\s*strict\s+\(built-in\)\s+->\s+local-only\s+\(local\)/);
    expect(r.stdout).toContain('body:');
    expect(r.stdout).toMatch(/severity_threshold:\s+high/);
  });
});

// ---------------------------------------------------------------------------
// Tick 10: `clawreview presets diff <a> <b>` -- field-level delta between
// two preset chains. The fourth sub-command in the presets family.
// ---------------------------------------------------------------------------

async function runDiff(
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
    await runPresetsDiff({
      command: 'presets',
      positional: ['diff', ...positional],
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

describe('clawreview presets diff', () => {
  it('exits 0 with "no differences" when both chains resolve to the same body', async () => {
    const dir = await tmpDir();
    // Mirror the strict preset locally so the two chains resolve to
    // byte-identical bodies. (We could just compare strict vs strict
    // but exercising one local + one built-in path is more useful.)
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/clone.yml'),
      'extends: [strict]\n',
      'utf8',
    );
    const r = await runDiff(dir, ['strict', 'clone'], { format: 'text' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('(no differences)');
  });

  it('exits 3 and reports field-level changes between two built-in presets', async () => {
    const dir = await tmpDir();
    const r = await runDiff(dir, ['strict', 'permissive'], { format: 'json' });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chainA).toEqual(['strict']);
    expect(parsed.chainB).toEqual(['permissive']);
    expect(parsed.hasChanges).toBe(true);
    // severity_threshold is the canonical difference between strict
    // and permissive in the built-in presets.
    const changedOrUnique =
      parsed.changed.severity_threshold !== undefined ||
      parsed.only_in_a.severity_threshold !== undefined ||
      parsed.only_in_b.severity_threshold !== undefined;
    expect(changedOrUnique).toBe(true);
  });

  it('classifies a key as only_in_a when b drops it', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/has-thresh.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/no-thresh.yml'),
      'min_confidence: 0.5\n',
      'utf8',
    );
    const r = await runDiff(dir, ['has-thresh', 'no-thresh'], { format: 'json' });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    // a has severity_threshold but b does not.
    expect(parsed.only_in_a.severity_threshold).toBe('high');
    // b has min_confidence but a does not.
    expect(parsed.only_in_b.min_confidence).toBe(0.5);
    // Neither side has changed keys.
    expect(parsed.changed).toEqual({});
  });

  it('classifies a key as changed when both sides set it differently', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], { format: 'json' });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.changed.severity_threshold).toEqual({ a: 'high', b: 'low' });
    expect(parsed.only_in_a).toEqual({});
    expect(parsed.only_in_b).toEqual({});
  });

  it('compares ad-hoc multi-preset chains (extends-flattened on each side)', async () => {
    const dir = await tmpDir();
    // a: strict + a tweak that adds min_confidence
    // b: strict alone
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/min-conf.yml'),
      'min_confidence: 0.8\n',
      'utf8',
    );
    const r = await runDiff(dir, ['strict,min-conf', 'strict'], { format: 'json' });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chainA).toEqual(['strict', 'min-conf']);
    expect(parsed.chainB).toEqual(['strict']);
    // The only delta is the added min_confidence on side a.
    expect(parsed.only_in_a.min_confidence).toBe(0.8);
    expect(parsed.changed).toEqual({});
  });

  it('exits 1 when either chain is missing', async () => {
    const dir = await tmpDir();
    const missingB = await runDiff(dir, ['strict']);
    expect(missingB.exitCode).toBe(1);
    expect(missingB.stderr).toMatch(/missing <a> or <b> chain/);
    const missingBoth = await runDiff(dir, []);
    expect(missingBoth.exitCode).toBe(1);
  });

  it('exits 2 when a chain name is unknown', async () => {
    const dir = await tmpDir();
    const r = await runDiff(dir, ['strict', 'does-not-exist']);
    expect(r.exitCode).toBe(2);
    // The error message attributes the failure to side <b>.
    expect(r.stderr).toMatch(/<b>/);
  });

  it('exits 2 when --format is invalid', async () => {
    const dir = await tmpDir();
    const r = await runDiff(dir, ['strict', 'permissive'], { format: 'sarif' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--format must be text\|yaml\|json/);
  });

  it('exits 2 when a chain has an empty intermediate entry (stray trailing comma)', async () => {
    const dir = await tmpDir();
    const r = await runDiff(dir, ['strict,', 'permissive']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/contains an empty entry/);
  });

  it('text output renders changed / only_in_a / only_in_b blocks', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      ['severity_threshold: high', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      ['severity_threshold: low', 'comment_style: inline', ''].join('\n'),
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], { format: 'text' });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toMatch(/chain a:\s*a/);
    expect(r.stdout).toMatch(/chain b:\s*b/);
    expect(r.stdout).toContain('changed');
    expect(r.stdout).toContain('severity_threshold');
    expect(r.stdout).toContain('only in a');
    expect(r.stdout).toContain('min_confidence');
    expect(r.stdout).toContain('only in b');
    expect(r.stdout).toContain('comment_style');
  });

  it('yaml output emits a single document with changed / only_in_a / only_in_b keys', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], { format: 'yaml' });
    expect(r.exitCode).toBe(3);
    // Header comments record the chains so a YAML consumer keeps the
    // provenance even after the JSON envelope is stripped.
    expect(r.stdout).toContain('# clawreview presets diff');
    expect(r.stdout).toContain('# a: a');
    expect(r.stdout).toContain('# b: b');
    expect(r.stdout).toContain('changed:');
    expect(r.stdout).toContain('severity_threshold');
  });

  it('accepts --a / --b flags as well as positional', async () => {
    const dir = await tmpDir();
    const r = await runDiff(dir, [], { a: 'strict', b: 'permissive', format: 'json' });
    expect([0, 3]).toContain(r.exitCode);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chainA).toEqual(['strict']);
    expect(parsed.chainB).toEqual(['permissive']);
  });
});

describe('clawreview presets diff --only-fields (tick 11)', () => {
  // The --only-fields filter restricts the diff to a specific
  // allowlist of top-level keys, so an operator preparing a focused
  // migration ticket can scope a wide preset rebase to "only the
  // handful of fields I care about". Tests pin (a) the filter
  // semantics (keys outside the allowlist drop out of changed /
  // only_in_a / only_in_b), (b) the exit-code contract (delta hidden
  // by the filter exits 0 because the operator declared those
  // changes out of scope), (c) the rendered annotation paths
  // (text / yaml / json all surface the active filter), and
  // (d) error handling (empty intermediate entry rejects).

  it('restricts changed / only_in_a / only_in_b to keys in the allowlist (json)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      ['severity_threshold: high', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      ['severity_threshold: low', 'comment_style: inline', ''].join('\n'),
      'utf8',
    );
    // Without the filter the diff carries severity_threshold (changed),
    // min_confidence (only_in_a), comment_style (only_in_b).
    const unfiltered = await runDiff(dir, ['a', 'b'], { format: 'json' });
    expect(unfiltered.exitCode).toBe(3);
    const u = JSON.parse(unfiltered.stdout);
    expect(u.changed.severity_threshold).toBeDefined();
    expect(u.only_in_a.min_confidence).toBeDefined();
    expect(u.only_in_b.comment_style).toBeDefined();
    expect(u.onlyFields).toBeNull();

    // Scope down to severity_threshold; the other two fields drop out.
    const filtered = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      'only-fields': 'severity_threshold',
    });
    expect(filtered.exitCode).toBe(3);
    const f = JSON.parse(filtered.stdout);
    expect(f.changed.severity_threshold).toBeDefined();
    expect(f.only_in_a).toEqual({});
    expect(f.only_in_b).toEqual({});
    expect(f.hasChanges).toBe(true);
    expect(f.onlyFields).toEqual(['severity_threshold']);
  });

  it('exits 0 when the filter excludes every difference (CI gate ignores out-of-scope drift)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'min_confidence: 0.7\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'min_confidence: 0.5\n',
      'utf8',
    );
    // Filter to a key NEITHER preset uses -> the visible delta is
    // empty -> exit 0 (operator declared those changes out of scope).
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      'only-fields': 'severity_threshold',
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hasChanges).toBe(false);
    expect(parsed.changed).toEqual({});
    expect(parsed.onlyFields).toEqual(['severity_threshold']);
  });

  it('text renderer annotates the active filter on its own line', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      ['severity_threshold: high', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      ['severity_threshold: low', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'text',
      'only-fields': 'severity_threshold,min_confidence',
    });
    expect(r.exitCode).toBe(3);
    // The annotation surfaces ABOVE the diff body so a reviewer can
    // tell the diff was scoped before reading the rows.
    expect(r.stdout).toMatch(/only-fields: min_confidence, severity_threshold/);
    expect(r.stdout).toContain('severity_threshold');
    expect(r.stdout).toContain('changed');
  });

  it('text renderer surfaces a distinct "no differences in the filtered fields" hint', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: high\nmin_confidence: 0.5\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'text',
      'only-fields': 'severity_threshold',
    });
    expect(r.exitCode).toBe(0);
    // Distinct phrasing from the unfiltered "no differences" so an
    // operator who scoped down doesn't misread the silence.
    expect(r.stdout).toContain('(no differences in the filtered fields)');
  });

  it('yaml renderer adds an `# only-fields:` header comment when scoped', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'yaml',
      'only-fields': 'severity_threshold',
    });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('# only-fields: severity_threshold');
    expect(r.stdout).toContain('changed:');
  });

  it('exits 2 when --only-fields contains an empty intermediate entry', async () => {
    const dir = await tmpDir();
    const r = await runDiff(dir, ['strict', 'permissive'], {
      'only-fields': 'severity_threshold,,min_confidence',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--only-fields contains an empty entry/);
  });

  it('treats an empty / whitespace-only --only-fields value as "no filter"', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      'only-fields': '   ',
    });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    // Whitespace-only -> null filter -> the diff is rendered in full.
    expect(parsed.onlyFields).toBeNull();
    expect(parsed.changed.severity_threshold).toBeDefined();
  });

  it('de-dupes repeated names in --only-fields (a,a,b -> a,b)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      ['severity_threshold: high', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      ['severity_threshold: low', 'min_confidence: 0.5', ''].join('\n'),
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      'only-fields': 'severity_threshold,severity_threshold,min_confidence',
    });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    // De-dup: only two distinct names land in the surfaced filter.
    expect(parsed.onlyFields).toEqual(['min_confidence', 'severity_threshold']);
  });
});

describe('filterPresetDelta + parsePresetOnlyFields (pure)', () => {
  // Pure-helper unit tests so the contract for the filter sits in
  // exactly one place. The CLI integration above exercises the
  // surface; these pin the helper shape so a refactor that collapses
  // the helper back into runPresetsDiff still has to satisfy the
  // contract.

  it('parsePresetOnlyFields: null on undefined / empty / whitespace', () => {
    expect(parsePresetOnlyFields(undefined)).toBeNull();
    expect(parsePresetOnlyFields(null)).toBeNull();
    expect(parsePresetOnlyFields('')).toBeNull();
    expect(parsePresetOnlyFields('   ')).toBeNull();
  });

  it('parsePresetOnlyFields: returns the EMPTY_ENTRY sentinel on a stray comma', () => {
    expect(parsePresetOnlyFields('a,,b')).toBe(ONLY_FIELDS_EMPTY_ENTRY);
    expect(parsePresetOnlyFields('a,')).toBe(ONLY_FIELDS_EMPTY_ENTRY);
    expect(parsePresetOnlyFields(',a')).toBe(ONLY_FIELDS_EMPTY_ENTRY);
    expect(parsePresetOnlyFields(' , ')).toBe(ONLY_FIELDS_EMPTY_ENTRY);
  });

  it('parsePresetOnlyFields: trims, de-dups, preserves intent on valid input', () => {
    const out = parsePresetOnlyFields(' severity_threshold , min_confidence , severity_threshold ');
    expect(out).toBeInstanceOf(Set);
    const set = out as Set<string>;
    expect(set.size).toBe(2);
    expect(set.has('severity_threshold')).toBe(true);
    expect(set.has('min_confidence')).toBe(true);
  });

  it('filterPresetDelta: returns the input unchanged when fields is null', () => {
    const delta = {
      changed: { x: { a: 1, b: 2 } },
      only_in_a: { y: 3 },
      only_in_b: { z: 4 },
    };
    const out = filterPresetDelta(delta, null);
    expect(out).toBe(delta);
  });

  it('filterPresetDelta: drops keys NOT in the allowlist from all three buckets', () => {
    const delta = {
      changed: { keep: { a: 1, b: 2 }, drop: { a: 3, b: 4 } },
      only_in_a: { keep: 'x', drop: 'y' },
      only_in_b: { drop: 'z' },
    };
    const out = filterPresetDelta(delta, new Set(['keep']));
    expect(out.changed).toEqual({ keep: { a: 1, b: 2 } });
    expect(out.only_in_a).toEqual({ keep: 'x' });
    expect(out.only_in_b).toEqual({});
    // Original delta must be unchanged (no mutation).
    expect(delta.changed).toHaveProperty('drop');
  });

  it('filterPresetDelta: empty allowlist yields an empty delta in all three buckets', () => {
    const delta = {
      changed: { a: { a: 1, b: 2 } },
      only_in_a: { b: 3 },
      only_in_b: { c: 4 },
    };
    const out = filterPresetDelta(delta, new Set());
    expect(out.changed).toEqual({});
    expect(out.only_in_a).toEqual({});
    expect(out.only_in_b).toEqual({});
  });
});

// Tick 12: --exclude-fields is the mirror of --only-fields. Same
// parser, opposite set semantics (drop keys IN the set). The two are
// mutually exclusive at the CLI layer (combining them would
// double-filter and surprise the operator).
describe('clawreview presets diff --exclude-fields (tick 12)', () => {
  it('drops keys IN the exclude list from changed / only_in_a / only_in_b (json)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      ['severity_threshold: high', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      ['severity_threshold: low', 'comment_style: inline', ''].join('\n'),
      'utf8',
    );
    // Without the filter the diff carries severity_threshold (changed),
    // min_confidence (only_in_a), comment_style (only_in_b).
    // Exclude severity_threshold; the other two survive.
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      'exclude-fields': 'severity_threshold',
    });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    // severity_threshold is excluded -> no `changed.severity_threshold`.
    expect(parsed.changed).toEqual({});
    // The other two are surfaced normally.
    expect(parsed.only_in_a.min_confidence).toBeDefined();
    expect(parsed.only_in_b.comment_style).toBeDefined();
    expect(parsed.excludeFields).toEqual(['severity_threshold']);
    // onlyFields stays null (the mutex check would have rejected the
    // combination, but the JSON surface always carries both keys).
    expect(parsed.onlyFields).toBeNull();
  });

  it('exits 0 when --exclude-fields hides every visible difference', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    // The only difference is severity_threshold; excluding it leaves
    // no visible delta. The CI gate must NOT trip (exit 0).
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      'exclude-fields': 'severity_threshold',
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hasChanges).toBe(false);
    expect(parsed.excludeFields).toEqual(['severity_threshold']);
  });

  it('text renderer annotates the exclude filter + uses the "outside the excluded fields" hint', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'text',
      'exclude-fields': 'severity_threshold',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/exclude-fields: severity_threshold/);
    // Distinct phrasing from the unfiltered "no differences" so the
    // operator can tell drift was actually hidden by the filter.
    expect(r.stdout).toContain('(no differences outside the excluded fields)');
  });

  it('yaml renderer adds an `# exclude-fields:` header comment when scoped', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      ['severity_threshold: high', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      ['severity_threshold: low', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'yaml',
      'exclude-fields': 'min_confidence',
    });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('# exclude-fields: min_confidence');
    // The non-excluded field still surfaces in the body.
    expect(r.stdout).toContain('severity_threshold');
  });

  it('exits 2 when --exclude-fields contains an empty intermediate entry', async () => {
    const dir = await tmpDir();
    const r = await runDiff(dir, ['strict', 'permissive'], {
      'exclude-fields': 'a,,b',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--exclude-fields contains an empty entry/);
  });

  it('exits 2 when --only-fields and --exclude-fields are combined (mutex)', async () => {
    const dir = await tmpDir();
    const r = await runDiff(dir, ['strict', 'permissive'], {
      'only-fields': 'severity_threshold',
      'exclude-fields': 'min_confidence',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/mutually exclusive/);
  });

  it('de-dupes repeated names in --exclude-fields (a,a,b -> a,b)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      ['severity_threshold: high', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      ['severity_threshold: low', 'min_confidence: 0.5', ''].join('\n'),
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      'exclude-fields': 'severity_threshold,severity_threshold,min_confidence',
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    // De-dup: only two distinct names land in the surfaced filter.
    expect(parsed.excludeFields).toEqual(['min_confidence', 'severity_threshold']);
    expect(parsed.hasChanges).toBe(false);
  });
});

describe('filterPresetDeltaExcluding (pure)', () => {
  it('returns the input unchanged when fields is null', () => {
    const delta = {
      changed: { x: { a: 1, b: 2 } },
      only_in_a: { y: 3 },
      only_in_b: { z: 4 },
    };
    const out = filterPresetDeltaExcluding(delta, null);
    expect(out).toBe(delta);
  });

  it('drops keys IN the exclude set from all three buckets', () => {
    const delta = {
      changed: { keep: { a: 1, b: 2 }, drop: { a: 3, b: 4 } },
      only_in_a: { keep: 'x', drop: 'y' },
      only_in_b: { drop: 'z', keep2: 'w' },
    };
    const out = filterPresetDeltaExcluding(delta, new Set(['drop']));
    expect(out.changed).toEqual({ keep: { a: 1, b: 2 } });
    expect(out.only_in_a).toEqual({ keep: 'x' });
    expect(out.only_in_b).toEqual({ keep2: 'w' });
    // Original delta must be unchanged (no mutation).
    expect(delta.changed).toHaveProperty('drop');
  });

  it('empty exclude set is a no-op (everything survives)', () => {
    const delta = {
      changed: { a: { a: 1, b: 2 } },
      only_in_a: { b: 3 },
      only_in_b: { c: 4 },
    };
    const out = filterPresetDeltaExcluding(delta, new Set());
    // Empty Set means "exclude nothing" -> the input shape survives.
    expect(out.changed).toEqual(delta.changed);
    expect(out.only_in_a).toEqual(delta.only_in_a);
    expect(out.only_in_b).toEqual(delta.only_in_b);
  });

  it('excluding every key yields an empty delta', () => {
    const delta = {
      changed: { a: { a: 1, b: 2 } },
      only_in_a: { b: 3 },
      only_in_b: { c: 4 },
    };
    const out = filterPresetDeltaExcluding(delta, new Set(['a', 'b', 'c']));
    expect(out.changed).toEqual({});
    expect(out.only_in_a).toEqual({});
    expect(out.only_in_b).toEqual({});
  });
});

// Tick 12: --output writes the JSON / YAML body to a file instead of
// stdout. For a migration-ticket flow where the diff body lands on
// disk for a follow-up commit. Requires JSON or YAML; text exits 2.
describe('clawreview presets diff --output (tick 12)', () => {
  // Tiny helper: read the freshly-written file back via the same
  // node:fs/promises API the CLI uses.
  async function readWritten(path: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    return readFile(path, 'utf8');
  }

  it('writes the JSON body to --output instead of stdout', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const outFile = join(dir, 'diff.json');
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: outFile,
    });
    // Exit code: still 3 because the diff is non-empty; --output
    // doesn't change the CI gate semantics.
    expect(r.exitCode).toBe(3);
    // stdout must be empty -- the body went to the file.
    expect(r.stdout).toBe('');
    // stderr surfaces a confirmation so the operator knows the file
    // landed (the byte count is a quick sanity check).
    expect(r.stderr).toMatch(/wrote \d+ bytes to /);
    expect(r.stderr).toContain(outFile);
    // The file contains the exact same body the stdout path would
    // have rendered.
    const written = await readWritten(outFile);
    const parsed = JSON.parse(written);
    expect(parsed.chainA).toEqual(['a']);
    expect(parsed.chainB).toEqual(['b']);
    expect(parsed.changed.severity_threshold).toBeDefined();
    expect(parsed.hasChanges).toBe(true);
  });

  it('writes the YAML body to --output instead of stdout', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const outFile = join(dir, 'diff.yml');
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'yaml',
      output: outFile,
    });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe('');
    const written = await readWritten(outFile);
    // YAML body retains the # header comments + the changed: section
    // exactly as the stdout path would produce.
    expect(written).toContain('# clawreview presets diff');
    expect(written).toContain('# a: a');
    expect(written).toContain('# b: b');
    expect(written).toContain('changed:');
    expect(written).toContain('severity_threshold:');
  });

  it('creates intermediate directories (mkdir -p semantics)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    // Nested directory that doesn't exist yet.
    const outFile = join(dir, 'reports/2026-06-21/diff.json');
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: outFile,
    });
    expect(r.exitCode).toBe(3);
    // The intermediate dirs got created and the file is readable.
    const written = await readWritten(outFile);
    expect(JSON.parse(written).chainA).toEqual(['a']);
  });

  it('exits 0 (no diff) when chains agree but still writes an empty-delta JSON body', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    const outFile = join(dir, 'empty-diff.json');
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: outFile,
    });
    // Empty diff -> exit 0; the file still lands so a CI archive
    // step picks up a consistent artifact path even on a no-change run.
    expect(r.exitCode).toBe(0);
    const written = await readWritten(outFile);
    const parsed = JSON.parse(written);
    expect(parsed.hasChanges).toBe(false);
    expect(parsed.changed).toEqual({});
  });

  it('exits 2 when --output is combined with --format text (text is not an artifact format)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'text',
      output: join(dir, 'diff.txt'),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--output requires --format json or --format yaml/);
  });

  it('honors --only-fields when writing to --output (scoped artifact)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      ['severity_threshold: high', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      ['severity_threshold: low', 'min_confidence: 0.5', ''].join('\n'),
      'utf8',
    );
    const outFile = join(dir, 'scoped.json');
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: outFile,
      'only-fields': 'severity_threshold',
    });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(await readWritten(outFile));
    // Scoped: only severity_threshold lands in `changed`.
    expect(parsed.changed.severity_threshold).toBeDefined();
    expect(parsed.changed.min_confidence).toBeUndefined();
    expect(parsed.onlyFields).toEqual(['severity_threshold']);
  });
});

describe('resolvePresetDiffOutputPath (pure)', () => {
  it('returns absolute paths unchanged', () => {
    // An absolute path is a contract: the operator picked it
    // deliberately. The helper must not re-anchor it under root.
    expect(resolvePresetDiffOutputPath('/tmp/diff.json', '/project')).toBe(
      '/tmp/diff.json',
    );
  });

  it('resolves relative paths against root', () => {
    // Relative path lands under the supplied root so a CI checkout
    // that pins --root sees a stable file path.
    expect(resolvePresetDiffOutputPath('diff.json', '/project')).toBe(
      '/project/diff.json',
    );
    expect(resolvePresetDiffOutputPath('reports/d.json', '/project')).toBe(
      '/project/reports/d.json',
    );
  });

  // Tick 13: `-` is the stdout sentinel. The resolver returns the
  // STDOUT_SENTINEL Symbol so a downstream consumer can identify the
  // pure-mode write target without comparing to a magic string (a
  // file literally named `-` would otherwise be ambiguous).
  it('returns STDOUT_SENTINEL for the literal `-` regardless of root', () => {
    // Sentinel must NOT be re-anchored under root. The whole point of
    // the sentinel is "skip the filesystem entirely".
    expect(resolvePresetDiffOutputPath('-', '/project')).toBe(STDOUT_SENTINEL);
    expect(resolvePresetDiffOutputPath('-', '/')).toBe(STDOUT_SENTINEL);
    expect(resolvePresetDiffOutputPath('-', '')).toBe(STDOUT_SENTINEL);
  });

  it('keeps STDOUT_SENTINEL as a Symbol distinct from any string path', () => {
    // The sentinel is a Symbol so it can never collide with a real
    // filesystem path. If a future refactor accidentally returned the
    // string `'-'` instead, this test fires.
    expect(typeof STDOUT_SENTINEL).toBe('symbol');
    expect(STDOUT_SENTINEL).not.toBe('-');
    // Same Symbol.for() key on every resolver call so a strict
    // equality check works for downstream consumers.
    expect(resolvePresetDiffOutputPath('-', '/p')).toBe(
      resolvePresetDiffOutputPath('-', '/other'),
    );
  });
});

// Tick 13: `--output -` writes the JSON / YAML body to stdout in
// pure mode (no kleur headers, no `wrote N bytes` stderr banner).
// For a CI pipeline that wants the artifact-shaped body without
// allocating a temp file. Composes with the existing --output
// plumbing: same format restrictions, same --only-fields scope.
describe('clawreview presets diff --output - (tick 13 stdout sentinel)', () => {
  it('writes the JSON body to stdout in pure mode (no stderr banner)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: '-',
    });
    // Exit code: still 3 because the diff is non-empty; the sentinel
    // doesn't change the CI gate semantics.
    expect(r.exitCode).toBe(3);
    // stdout carries the JSON body; the text-mode `chain a: ...`
    // header is NOT in the output (pure mode means just the body).
    // The body is valid JSON that parses cleanly.
    expect(r.stdout).not.toMatch(/^chain a:/m);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chainA).toEqual(['a']);
    expect(parsed.chainB).toEqual(['b']);
    expect(parsed.changed.severity_threshold).toBeDefined();
    expect(parsed.hasChanges).toBe(true);
    // The `wrote N bytes to ...` banner that fires for real files
    // must NOT fire for the sentinel -- the operator piped the
    // output into something else and doesn't want stderr noise.
    expect(r.stderr).toBe('');
  });

  it('writes the YAML body to stdout in pure mode (header comments only, no banner)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'yaml',
      output: '-',
    });
    expect(r.exitCode).toBe(3);
    // YAML body retains the # header comments (those are part of
    // the artifact shape, not the kleur preamble) + the changed:
    // section. Same body the file-write path would have left on disk.
    expect(r.stdout).toContain('# clawreview presets diff');
    expect(r.stdout).toContain('# a: a');
    expect(r.stdout).toContain('# b: b');
    expect(r.stdout).toContain('changed:');
    expect(r.stdout).toContain('severity_threshold:');
    // No stderr banner for the sentinel path.
    expect(r.stderr).toBe('');
  });

  it('exits 2 when --output - is combined with --format text (same as a real path)', async () => {
    // The sentinel must observe the same format restrictions as a
    // real path -- text isn't artifact-shaped, period.
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'text',
      output: '-',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--output requires --format json or --format yaml/);
  });

  it('exits 0 on an empty diff but still writes the empty-delta JSON body', async () => {
    // Same semantics as the file-write path: a no-change run still
    // emits the body so a downstream pipeline can pin on it.
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: '-',
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hasChanges).toBe(false);
    expect(parsed.changed).toEqual({});
    expect(r.stderr).toBe('');
  });

  it('honors --only-fields when writing to stdout via the sentinel (scoped artifact, pure mode)', async () => {
    // Sentinel composes with --only-fields exactly like a real
    // path. The scope filter applies BEFORE the body is rendered,
    // so the bytes a pipeline sees are identical to the file-write
    // path's bytes.
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      ['severity_threshold: high', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      ['severity_threshold: low', 'min_confidence: 0.5', ''].join('\n'),
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: '-',
      'only-fields': 'severity_threshold',
    });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.changed.severity_threshold).toBeDefined();
    expect(parsed.changed.min_confidence).toBeUndefined();
    expect(parsed.onlyFields).toEqual(['severity_threshold']);
    expect(r.stderr).toBe('');
  });

  it('produces byte-identical body to a real file (sentinel is just the same write path minus the filesystem)', async () => {
    // The contract is "same bytes a `--output diff.json` would
    // have left on disk", so a side-by-side comparison pins it.
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    // First: write to a real file via --output <path>
    const fileTarget = join(dir, 'diff.json');
    const fileRun = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: fileTarget,
    });
    expect(fileRun.exitCode).toBe(3);
    const { readFile } = await import('node:fs/promises');
    const fileBody = await readFile(fileTarget, 'utf8');
    // Second: write to stdout via --output -
    const stdoutRun = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: '-',
    });
    expect(stdoutRun.exitCode).toBe(3);
    // The two must be byte-identical -- that's the entire contract.
    expect(stdoutRun.stdout).toBe(fileBody);
  });
});

// Tick 13: --base <a> --target <b> is the named-flag form, an
// alternative to positional + --a/--b. Use case: shell aliases like
// `alias prdiff='clawreview presets diff --base $BASE --target $TARGET'`
// where the wrapper doesn't have to special-case positional ordering.
// Three forms now coexist; positional wins back-compat.
describe('clawreview presets diff --base / --target (tick 13 named flags)', () => {
  it('accepts --base + --target as the chain pair (no positional args)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, [], {
      format: 'json',
      base: 'a',
      target: 'b',
    });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chainA).toEqual(['a']);
    expect(parsed.chainB).toEqual(['b']);
    expect(parsed.changed.severity_threshold).toBeDefined();
  });

  it('accepts a comma-separated chain via --base / --target (matches positional / --a/--b semantics)', async () => {
    // The named-flag form must use the same chain parser so a
    // multi-name chain (`strict,security-focused`) flattens
    // identically. Without this the named form would silently
    // diverge from the positional form on chains.
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/web-strict.yml'),
      'extends: [strict]\nseverity_threshold: high\n',
      'utf8',
    );
    const r = await runDiff(dir, [], {
      format: 'json',
      base: 'strict,security-focused',
      target: 'web-strict',
    });
    expect(r.exitCode === 0 || r.exitCode === 3).toBe(true);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chainA).toEqual(['strict', 'security-focused']);
    expect(parsed.chainB).toEqual(['web-strict']);
  });

  it('positional wins when both positional and --base are supplied (back-compat)', async () => {
    // A regression guard: an existing CI command that pasted both
    // for safety must keep getting the positional form's behaviour,
    // not silently switch to the named-flag form.
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/posA.yml'),
      'severity_threshold: critical\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/posB.yml'),
      'severity_threshold: nit\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/named.yml'),
      'severity_threshold: medium\n',
      'utf8',
    );
    const r = await runDiff(dir, ['posA', 'posB'], {
      format: 'json',
      base: 'named',
      target: 'named',
    });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    // Positional won; the named flags were ignored.
    expect(parsed.chainA).toEqual(['posA']);
    expect(parsed.chainB).toEqual(['posB']);
  });

  it('short flags --a / --b win over --base / --target when both forms are passed (priority: positional > short > named)', async () => {
    // The form priority must be deterministic: positional > short > named.
    // A wrapper that pinned --a/--b and a caller overrode the alias
    // with --base/--target must still see the wrapper's --a/--b win.
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/shortA.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/shortB.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/named.yml'),
      'severity_threshold: medium\n',
      'utf8',
    );
    const r = await runDiff(dir, [], {
      format: 'json',
      a: 'shortA',
      b: 'shortB',
      base: 'named',
      target: 'named',
    });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chainA).toEqual(['shortA']);
    expect(parsed.chainB).toEqual(['shortB']);
  });

  it('mixes positional <a> with --target <b> (a common shell-alias shape)', async () => {
    // A pragmatic use case: the operator types the base preset
    // positionally and overrides the target via --target. Both
    // slots resolve independently so this is allowed and natural.
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/posA.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/namedB.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['posA'], {
      format: 'json',
      target: 'namedB',
    });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chainA).toEqual(['posA']);
    expect(parsed.chainB).toEqual(['namedB']);
  });

  it('rejects when --base is supplied but --target is missing (exit 1, named-form usage hint)', async () => {
    // The error message must surface the named-flag usage so an
    // operator who tried `--base` but forgot `--target` sees the
    // right shape, not just the positional form's hint.
    const dir = await tmpDir();
    const r = await runDiff(dir, [], {
      base: 'strict',
      // target intentionally absent
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/missing <a> or <b> chain/);
    expect(r.stderr).toMatch(/--base <a> --target <b>/);
  });

  it('rejects when --target is supplied but --base is missing (mirror of base-only)', async () => {
    const dir = await tmpDir();
    const r = await runDiff(dir, [], {
      target: 'strict',
      // base intentionally absent
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/missing <a> or <b> chain/);
  });

  it('composes cleanly with --format json --output - and --only-fields (the alias-friendly shape)', async () => {
    // End-to-end sanity: the named flags must work in the same
    // command line as every other tick-12/13 flag. This is the
    // canonical alias shape an operator would ship in their dotfiles.
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      ['severity_threshold: high', 'min_confidence: 0.7', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      ['severity_threshold: low', 'min_confidence: 0.5', ''].join('\n'),
      'utf8',
    );
    const r = await runDiff(dir, [], {
      format: 'json',
      base: 'a',
      target: 'b',
      output: '-',
      'only-fields': 'severity_threshold',
    });
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chainA).toEqual(['a']);
    expect(parsed.chainB).toEqual(['b']);
    expect(parsed.changed.severity_threshold).toBeDefined();
    expect(parsed.changed.min_confidence).toBeUndefined();
    expect(parsed.onlyFields).toEqual(['severity_threshold']);
    expect(r.stderr).toBe('');
  });
});

describe('parsePresetDiffMaxOutputBytes (tick 14 size cap parser)', () => {
  it('defaults to PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES on undefined', () => {
    expect(parsePresetDiffMaxOutputBytes(undefined)).toBe(PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('defaults on bare --max-output-bytes (true) without a value', () => {
    expect(parsePresetDiffMaxOutputBytes(true)).toBe(PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('defaults on null and empty string', () => {
    expect(parsePresetDiffMaxOutputBytes(null)).toBe(PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES);
    expect(parsePresetDiffMaxOutputBytes('')).toBe(PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES);
    expect(parsePresetDiffMaxOutputBytes('   ')).toBe(PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('accepts a string integer', () => {
    expect(parsePresetDiffMaxOutputBytes('1024')).toBe(1024);
  });

  it('accepts a number directly', () => {
    expect(parsePresetDiffMaxOutputBytes(2048)).toBe(2048);
  });

  it('accepts 0 as the explicit "no cap" sentinel', () => {
    expect(parsePresetDiffMaxOutputBytes('0')).toBe(0);
    expect(parsePresetDiffMaxOutputBytes(0)).toBe(0);
  });

  it('clamps to PRESET_DIFF_MAX_OUTPUT_BYTES_CEILING for absurdly large values', () => {
    expect(parsePresetDiffMaxOutputBytes('999999999999')).toBe(PRESET_DIFF_MAX_OUTPUT_BYTES_CEILING);
  });

  it('rejects negative numbers as "invalid"', () => {
    expect(parsePresetDiffMaxOutputBytes('-100')).toBe('invalid');
    expect(parsePresetDiffMaxOutputBytes(-100)).toBe('invalid');
  });

  it('rejects non-integer numerics ("1.5", "1e3", "0x10")', () => {
    expect(parsePresetDiffMaxOutputBytes('1.5')).toBe('invalid');
    expect(parsePresetDiffMaxOutputBytes('1e3')).toBe('invalid');
    expect(parsePresetDiffMaxOutputBytes('0x10')).toBe('invalid');
  });

  it('rejects garbage strings', () => {
    expect(parsePresetDiffMaxOutputBytes('big')).toBe('invalid');
    expect(parsePresetDiffMaxOutputBytes('100K')).toBe('invalid');
  });

  it('rejects non-string non-number values', () => {
    expect(parsePresetDiffMaxOutputBytes({ value: 1 })).toBe('invalid');
    expect(parsePresetDiffMaxOutputBytes([1024])).toBe('invalid');
  });
});

describe('enforcePresetDiffSizeCap (tick 14 size cap enforcer)', () => {
  it('returns "ok" when the body is within the cap', () => {
    expect(enforcePresetDiffSizeCap('/tmp/x.json', 'hello', 100)).toBe('ok');
  });

  it('returns "ok" when the cap is 0 (disabled)', () => {
    // Even a multi-MB body passes when the cap is explicitly disabled.
    const giantBody = 'x'.repeat(2 * 1024 * 1024);
    expect(enforcePresetDiffSizeCap('/tmp/x.json', giantBody, 0)).toBe('ok');
  });

  it('returns a stderr-ready error when the body exceeds the cap (file path)', () => {
    const body = 'x'.repeat(1024);
    const r = enforcePresetDiffSizeCap('/tmp/x.json', body, 100);
    expect(r).not.toBe('ok');
    const s = r as string;
    expect(s).toContain('refusing to write 1024 bytes');
    expect(s).toContain("'/tmp/x.json'");
    expect(s).toContain('--max-output-bytes 100');
    // File-path hint mentions raising the cap.
    expect(s).toContain('raise --max-output-bytes');
  });

  it('returns a stderr-ready error with a stdout-specific hint when the target is the STDOUT sentinel', () => {
    const body = 'x'.repeat(1024);
    const r = enforcePresetDiffSizeCap(STDOUT_SENTINEL, body, 100);
    expect(r).not.toBe('ok');
    const s = r as string;
    expect(s).toContain('to stdout');
    expect(s).toContain('--output <path> instead');
  });

  it('counts UTF-8 bytes, not character code points', () => {
    // 'é' is 2 bytes in UTF-8 (0xC3 0xA9). A 10-char string is 20
    // bytes when packed with this character. The cap MUST fire on
    // bytes, not characters, so a unicode-heavy body cannot sneak
    // past via a low character count.
    const body = 'é'.repeat(10);
    expect(body.length).toBe(10);
    expect(enforcePresetDiffSizeCap('/tmp/x.json', body, 15)).not.toBe('ok');
    expect(enforcePresetDiffSizeCap('/tmp/x.json', body, 100)).toBe('ok');
  });

  it('is pure: never touches the filesystem or process state', () => {
    // Smoke test: calling it many times with the same args returns the same value.
    const body = 'x'.repeat(200);
    expect(enforcePresetDiffSizeCap(STDOUT_SENTINEL, body, 100))
      .toBe(enforcePresetDiffSizeCap(STDOUT_SENTINEL, body, 100));
  });
});

describe('clawreview presets diff --max-output-bytes', () => {
  it('refuses to write when the rendered body exceeds the cap (stdout sentinel)', async () => {
    const dir = await tmpDir();
    // Build a local preset stack that produces a substantial body.
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    // A YAML preset with many fields produces a few KB of diff output.
    await writeFile(
      join(dir, '.clawreview/presets/heavy.yml'),
      [
        'severity_threshold: high',
        'min_confidence: 0.7',
        'inline_comments:',
        '  enabled: true',
        '  min_severity: medium',
        '  max: 20',
        'hotspots:',
        '  enabled: true',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/empty.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    // Cap at 10 bytes -- the diff body is comfortably larger.
    const r = await runDiff(dir, ['heavy', 'empty'], {
      format: 'json',
      output: '-',
      'max-output-bytes': '10',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('refusing to write');
    expect(r.stderr).toContain('exceeds --max-output-bytes 10');
    // Nothing landed on stdout (the cap fired BEFORE the write).
    expect(r.stdout).toBe('');
  });

  it('refuses to write when the body exceeds the cap (named file path)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\nmin_confidence: 0.9\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\nmin_confidence: 0.1\n',
      'utf8',
    );
    const outPath = join(dir, 'out.json');
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: outPath,
      'max-output-bytes': '50',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('refusing to write');
    expect(r.stderr).toContain(`'${outPath}'`);
    expect(r.stderr).toContain('raise --max-output-bytes');
  });

  it('writes the body when the cap is 0 (cap disabled)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: '-',
      'max-output-bytes': '0',
    });
    // No size cap -> writes succeed; exit 3 because there IS drift.
    expect(r.exitCode).toBe(3);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stderr).toBe('');
  });

  it('writes the body when it fits comfortably under the cap', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    // A few-hundred-byte body easily fits in 100 KiB (the default).
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: '-',
    });
    expect(r.exitCode).toBe(3);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('rejects an invalid --max-output-bytes value with exit 2', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, '.clawreview/presets/a.yml'),
      'severity_threshold: high\n',
      'utf8',
    );
    await writeFile(
      join(dir, '.clawreview/presets/b.yml'),
      'severity_threshold: low\n',
      'utf8',
    );
    const r = await runDiff(dir, ['a', 'b'], {
      format: 'json',
      output: '-',
      'max-output-bytes': 'big',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--max-output-bytes must be a non-negative integer');
  });
});
