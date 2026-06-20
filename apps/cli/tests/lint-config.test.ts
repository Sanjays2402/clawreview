import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runLintConfig } from '../src/commands/lint-config.js';
import { findConfigFiles } from '../src/commands/lint-config.js';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clawreview-lint-cfg-'));
}

/**
 * Capture stdout/stderr/exitCode for one runLintConfig invocation.
 * Runs the command with cwd switched to `dir` so the implementation's
 * default `--root .` lands on the temp tree.
 */
async function run(dir: string, flags: Record<string, string | boolean> = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
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
  const prevCwd = process.cwd();
  process.chdir(dir);
  process.exitCode = 0;
  try {
    await runLintConfig({
      command: 'lint-config',
      positional: [],
      flags: { 'no-color': true, ...flags },
    });
  } finally {
    process.chdir(prevCwd);
    writeStdout.mockRestore();
    writeStderr.mockRestore();
  }
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code };
}

beforeEach(() => {
  // Ensure stdout looks non-TTY so no-color path matches the default
  // we want.  Vitest already gives us non-TTY; just defensive.
});

afterEach(() => {
  process.exitCode = 0;
});

describe('findConfigFiles', () => {
  it('walks recursively and matches by basename', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, 'apps/web'), { recursive: true });
    await mkdir(join(dir, 'apps/api'), { recursive: true });
    await writeFile(join(dir, '.clawreview.yml'), 'agents: [security]\n', 'utf8');
    await writeFile(join(dir, 'apps/web/.clawreview.yml'), 'agents: [security]\n', 'utf8');
    await writeFile(join(dir, 'apps/api/.clawreview.yml'), 'agents: [security]\n', 'utf8');

    const files = await findConfigFiles(dir, ['.clawreview.yml']);
    expect(files).toHaveLength(3);
    expect(files.some((f) => f.endsWith('/.clawreview.yml'))).toBe(true);
    expect(files.some((f) => f.endsWith('apps/web/.clawreview.yml'))).toBe(true);
    expect(files.some((f) => f.endsWith('apps/api/.clawreview.yml'))).toBe(true);
  });

  it('skips node_modules, .git, dist, build, .next, .turbo', async () => {
    const dir = await tmpDir();
    for (const skip of ['node_modules', '.git', 'dist', 'build', '.next', '.turbo']) {
      await mkdir(join(dir, skip, 'deep'), { recursive: true });
      await writeFile(join(dir, skip, '.clawreview.yml'), 'agents: [security]\n', 'utf8');
      await writeFile(join(dir, skip, 'deep/.clawreview.yml'), 'agents: [security]\n', 'utf8');
    }
    await writeFile(join(dir, '.clawreview.yml'), 'agents: [security]\n', 'utf8');
    const files = await findConfigFiles(dir, ['.clawreview.yml']);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\/\.clawreview\.yml$/);
  });

  it('skips the .clawreview/presets subtree', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, '.clawreview/presets'), { recursive: true });
    await writeFile(join(dir, '.clawreview.yml'), 'agents: [security]\n', 'utf8');
    await writeFile(join(dir, '.clawreview/presets/.clawreview.yml'), 'agents: [security]\n', 'utf8');
    const files = await findConfigFiles(dir, ['.clawreview.yml']);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[^]*\/\.clawreview\.yml$/);
    expect(files[0]).not.toContain('.clawreview/presets');
  });

  it('matches multiple patterns from the patterns set', async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, '.clawreview.yml'), 'agents: [security]\n', 'utf8');
    await writeFile(join(dir, 'clawreview.config.yml'), 'agents: [security]\n', 'utf8');
    const files = await findConfigFiles(dir, ['.clawreview.yml', 'clawreview.config.yml']);
    expect(files).toHaveLength(2);
  });
});

describe('runLintConfig', () => {
  it('reports OK for a valid config and exits 0', async () => {
    const dir = await tmpDir();
    await writeFile(
      join(dir, '.clawreview.yml'),
      ['agents: [security]', 'severity_threshold: low', ''].join('\n'),
      'utf8',
    );
    const r = await run(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/OK\s+\.clawreview\.yml/);
    expect(r.stdout).toMatch(/1 file\(s\) -- 1 ok, 0 invalid/);
  });

  it('reports FAIL and exits 2 for a config whose schema validation fails', async () => {
    const dir = await tmpDir();
    await writeFile(
      join(dir, '.clawreview.yml'),
      ['severity_threshold: oops-not-a-severity', ''].join('\n'),
      'utf8',
    );
    const r = await run(dir);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/FAIL\s+\.clawreview\.yml/);
    expect(r.stdout).toMatch(/severity_threshold/);
    expect(r.stdout).toMatch(/0 ok, 1 invalid/);
  });

  it('reports FAIL on YAML parse errors with the file named', async () => {
    const dir = await tmpDir();
    await writeFile(
      join(dir, '.clawreview.yml'),
      'agents: [unterminated\n',
      'utf8',
    );
    const r = await run(dir);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/FAIL\s+\.clawreview\.yml/);
    expect(r.stdout).toMatch(/yaml parse/);
  });

  it('reports FAIL when an extends: name is not in the (built-in + local) namespace', async () => {
    const dir = await tmpDir();
    await writeFile(
      join(dir, '.clawreview.yml'),
      ['extends: not-a-preset', ''].join('\n'),
      'utf8',
    );
    const r = await run(dir);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/unknown preset 'not-a-preset'/);
  });

  it('scopes local preset resolution per file (monorepo-friendly)', async () => {
    const dir = await tmpDir();
    // apps/web has its own local presets including `web-strict`.
    await mkdir(join(dir, 'apps/web/.clawreview/presets'), { recursive: true });
    await writeFile(
      join(dir, 'apps/web/.clawreview/presets/web-strict.yml'),
      'severity_threshold: critical\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'apps/web/.clawreview.yml'),
      ['extends: web-strict', ''].join('\n'),
      'utf8',
    );
    // apps/api has NO web-strict preset; same extends should fail there.
    await mkdir(join(dir, 'apps/api'), { recursive: true });
    await writeFile(
      join(dir, 'apps/api/.clawreview.yml'),
      ['extends: web-strict', ''].join('\n'),
      'utf8',
    );
    const r = await run(dir, { format: 'json' });
    expect(r.exitCode).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(1);
    expect(parsed.invalid).toBe(1);
    const web = parsed.files.find((f: { file: string }) => f.file.includes('apps/web'));
    const api = parsed.files.find((f: { file: string }) => f.file.includes('apps/api'));
    expect(web.status).toBe('ok');
    expect(api.status).toBe('invalid');
    expect(api.errors.join(' ')).toMatch(/unknown preset 'web-strict'/);
  });

  it('exits 3 when no files match the patterns (helps catch typos)', async () => {
    const dir = await tmpDir();
    const r = await run(dir, { pattern: 'no-such-file.yml' });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toMatch(/no config files matched/);
  });

  it('emits JSON when --format json is set', async () => {
    const dir = await tmpDir();
    await writeFile(
      join(dir, '.clawreview.yml'),
      ['agents: [security]', ''].join('\n'),
      'utf8',
    );
    await mkdir(join(dir, 'apps/api'), { recursive: true });
    await writeFile(
      join(dir, 'apps/api/.clawreview.yml'),
      ['severity_threshold: bogus', ''].join('\n'),
      'utf8',
    );
    const r = await run(dir, { format: 'json' });
    expect(r.exitCode).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(1);
    expect(parsed.invalid).toBe(1);
    expect(parsed.files).toHaveLength(2);
    const failing = parsed.files.find((f: { status: string }) => f.status === 'invalid');
    expect(failing.errors[0]).toMatch(/severity_threshold/);
  });
});
