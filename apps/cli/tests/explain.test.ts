import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fingerprint } from '@clawreview/aggregator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runExplain } from '../src/commands/explain.js';

function f(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: 'security',
    category: 'security',
    severity: 'high',
    title: 'Tainted SQL in user lookup',
    rationale: 'User input concatenated into raw query.',
    file: 'src/users.ts',
    startLine: 17,
    confidence: 0.85,
    tags: [],
    ...over,
  };
}

describe('runExplain', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let dir: string;

  beforeEach(() => {
    process.exitCode = 0;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    dir = mkdtempSync(join(tmpdir(), 'clawreview-explain-'));
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = 0;
  });

  function out(): string { return stdoutSpy.mock.calls.map((c) => String(c[0])).join(''); }
  function err(): string { return stderrSpy.mock.calls.map((c) => String(c[0])).join(''); }

  function writeReport(findings: unknown[]): string {
    const path = join(dir, 'r.json');
    writeFileSync(path, JSON.stringify({ aggregated: { findings } }));
    return path;
  }

  it('prints the finding when the fingerprint matches exactly', async () => {
    const finding = f();
    const fp = fingerprint(finding as never);
    const input = writeReport([finding]);
    await runExplain({ command: 'explain', positional: [fp], flags: { input, 'no-color': true } });
    const o = out();
    expect(o).toContain(`Finding ${fp}`);
    expect(o).toContain('src/users.ts:17');
    expect(o).toContain('Tainted SQL in user lookup');
    expect(o).toContain('User input concatenated into raw query.');
    expect(process.exitCode || 0).toBe(0);
  });

  it('matches by prefix when the prefix is unambiguous', async () => {
    const finding = f();
    const fp = fingerprint(finding as never);
    const input = writeReport([finding, f({ title: 'Different title', startLine: 100 })]);
    const prefix = fp.slice(0, 8);
    await runExplain({ command: 'explain', positional: [prefix], flags: { input, 'no-color': true } });
    expect(out()).toContain(`Finding ${fp}`);
    expect(process.exitCode || 0).toBe(0);
  });

  it('renders Suggested change block when present', async () => {
    const finding = f({
      suggested: { description: 'Use parameterised statement', diff: '- bad\n+ good' },
    });
    const fp = fingerprint(finding as never);
    const input = writeReport([finding]);
    await runExplain({ command: 'explain', positional: [fp], flags: { input, 'no-color': true } });
    const o = out();
    expect(o).toContain('Suggested change');
    expect(o).toContain('Use parameterised statement');
    expect(o).toContain('+ good');
  });

  it('renders CWE and tags when present', async () => {
    const finding = f({ cwe: 'CWE-89', tags: ['security', 'sqli'] });
    const fp = fingerprint(finding as never);
    const input = writeReport([finding]);
    await runExplain({ command: 'explain', positional: [fp], flags: { input, 'no-color': true } });
    const o = out();
    expect(o).toContain('CWE:');
    expect(o).toContain('CWE-89');
    expect(o).toContain('security, sqli');
  });

  it('exits 1 with a helpful error when no finding matches', async () => {
    const input = writeReport([f()]);
    await runExplain({ command: 'explain', positional: ['deadbeef'], flags: { input, 'no-color': true } });
    expect(process.exitCode).toBe(1);
    expect(err()).toContain("no finding matches fingerprint 'deadbeef'");
  });

  it('exits 2 listing candidates when a prefix is ambiguous', async () => {
    // Two findings whose fingerprints share a common prefix? Vanishingly
    // unlikely. Use the empty-prefix '0' workaround: every fingerprint
    // starts with at least one hex digit, so we craft inputs whose
    // fingerprints both start with the same first character by trying a
    // few until we hit. Simpler: pass an empty prefix is rejected; pass
    // a single char that matches multiple by enumerating both fingerprints.
    const a = f({ startLine: 17 });
    const b = f({ startLine: 30, title: 'Another sqli' });
    const fpA = fingerprint(a as never);
    const fpB = fingerprint(b as never);
    // Find a shared prefix; first hex char is enough most of the time.
    // We deliberately scan to keep the test robust to fingerprint changes.
    let shared = '';
    for (let i = 1; i <= Math.min(fpA.length, fpB.length); i += 1) {
      if (fpA.slice(0, i) === fpB.slice(0, i)) shared = fpA.slice(0, i);
      else break;
    }
    if (!shared) {
      // Construct a guaranteed ambiguous prefix by reusing one fingerprint
      // as the prefix and adding a second copy of the same finding.
      shared = fpA.slice(0, 4);
      const input = writeReport([a, { ...a }]);
      await runExplain({ command: 'explain', positional: [shared], flags: { input, 'no-color': true } });
    } else {
      const input = writeReport([a, b]);
      await runExplain({ command: 'explain', positional: [shared], flags: { input, 'no-color': true } });
    }
    expect(process.exitCode).toBe(2);
    expect(err()).toContain('is ambiguous');
  });

  it('exits 2 when fingerprint argument is missing', async () => {
    const input = writeReport([f()]);
    await runExplain({ command: 'explain', positional: [], flags: { input, 'no-color': true } });
    expect(process.exitCode).toBe(2);
    expect(err()).toContain('missing fingerprint argument');
  });

  it('exits 2 when fingerprint argument has non-hex characters', async () => {
    const input = writeReport([f()]);
    await runExplain({ command: 'explain', positional: ['xyz!'], flags: { input, 'no-color': true } });
    expect(process.exitCode).toBe(2);
    expect(err()).toContain('not a valid fingerprint');
  });

  it('exits 2 on invalid JSON input', async () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{not json');
    await runExplain({ command: 'explain', positional: ['abcd'], flags: { input: path, 'no-color': true } });
    expect(process.exitCode).toBe(2);
    expect(err()).toContain('invalid JSON');
  });

  it('exits 1 when the report has no findings array', async () => {
    const path = join(dir, 'empty.json');
    writeFileSync(path, JSON.stringify({ aggregated: { findings: [] } }));
    await runExplain({ command: 'explain', positional: ['abcd'], flags: { input: path, 'no-color': true } });
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('report contains no findings');
  });

  it('accepts top-level findings: [] shape as well as aggregated.findings', async () => {
    const finding = f();
    const fp = fingerprint(finding as never);
    const path = join(dir, 'flat.json');
    writeFileSync(path, JSON.stringify({ findings: [finding] }));
    await runExplain({ command: 'explain', positional: [fp], flags: { input: path, 'no-color': true } });
    expect(out()).toContain(`Finding ${fp}`);
    expect(process.exitCode || 0).toBe(0);
  });

  it('lowercases the fingerprint argument before matching', async () => {
    const finding = f();
    const fp = fingerprint(finding as never);
    const input = writeReport([finding]);
    await runExplain({
      command: 'explain',
      positional: [fp.toUpperCase()],
      flags: { input, 'no-color': true },
    });
    expect(out()).toContain(`Finding ${fp}`);
    expect(process.exitCode || 0).toBe(0);
  });
});
