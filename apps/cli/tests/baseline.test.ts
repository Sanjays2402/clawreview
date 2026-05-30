import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBaseline } from '../src/commands/baseline.js';

let stdoutBuf = '';
let stderrBuf = '';

function makeReport(findings: unknown[]): string {
  return JSON.stringify({ aggregated: { findings } });
}

const sampleFinding = (over: Record<string, unknown> = {}) => ({
  agent: 'security',
  category: 'security',
  severity: 'high',
  title: 'SQLi',
  rationale: 'unsanitized',
  file: 'src/a.ts',
  startLine: 10,
  confidence: 0.9,
  tags: [],
  ...over,
});

describe('clawreview baseline', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clawreview-baseline-'));
    stdoutBuf = '';
    stderrBuf = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    });
    process.exitCode = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('prints usage when no subcommand is given', async () => {
    await runBaseline({ command: 'baseline', positional: [], flags: {} });
    expect(stderrBuf).toContain('expected subcommand');
    expect(process.exitCode).toBe(2);
  });

  it('save writes a baseline file with fingerprints', async () => {
    const input = join(dir, 'report.json');
    writeFileSync(input, makeReport([sampleFinding()]));
    const output = join(dir, 'baseline.json');
    await runBaseline({ command: 'baseline', positional: ['save'], flags: { input, output } });
    expect(existsSync(output)).toBe(true);
    const parsed = JSON.parse(readFileSync(output, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(stdoutBuf).toContain('Saved 1 findings');
  });

  it('diff reports added/removed/unchanged buckets', async () => {
    const baselinePath = join(dir, 'baseline.json');
    const baselineFile = {
      version: 1,
      createdAt: 'x',
      findings: [
        { fingerprint: 'ignored', finding: sampleFinding({ title: 'Old issue' }) },
        { fingerprint: 'ignored', finding: sampleFinding({ title: 'Will go away', file: 'src/gone.ts' }) },
      ],
    };
    writeFileSync(baselinePath, JSON.stringify(baselineFile));
    const input = join(dir, 'report.json');
    writeFileSync(
      input,
      makeReport([
        sampleFinding({ title: 'Old issue' }),
        sampleFinding({ title: 'Brand new', file: 'src/new.ts' }),
      ]),
    );
    await runBaseline({
      command: 'baseline',
      positional: ['diff'],
      flags: { input, baseline: baselinePath, 'no-color': true },
    });
    expect(stdoutBuf).toContain('New:        1');
    expect(stdoutBuf).toContain('Resolved:   1');
    expect(stdoutBuf).toContain('Unchanged:  1');
    expect(stdoutBuf).toContain('Brand new');
    expect(stdoutBuf).toContain('Will go away');
    expect(process.exitCode).toBe(0);
  });

  it('diff with --fail-on-new sets a non-zero exit code when new findings exist', async () => {
    const baselinePath = join(dir, 'baseline.json');
    writeFileSync(baselinePath, JSON.stringify({ version: 1, createdAt: 'x', findings: [] }));
    const input = join(dir, 'report.json');
    writeFileSync(input, makeReport([sampleFinding()]));
    await runBaseline({
      command: 'baseline',
      positional: ['diff'],
      flags: { input, baseline: baselinePath, 'fail-on-new': true, 'no-color': true },
    });
    expect(process.exitCode).toBe(1);
  });

  it('diff exits cleanly when there are no new findings, even with --fail-on-new', async () => {
    const baselinePath = join(dir, 'baseline.json');
    const f = sampleFinding();
    writeFileSync(
      baselinePath,
      JSON.stringify({ version: 1, createdAt: 'x', findings: [{ fingerprint: 'x', finding: f }] }),
    );
    const input = join(dir, 'report.json');
    writeFileSync(input, makeReport([f]));
    await runBaseline({
      command: 'baseline',
      positional: ['diff'],
      flags: { input, baseline: baselinePath, 'fail-on-new': true, 'no-color': true },
    });
    expect(process.exitCode).toBe(0);
  });

  it('diff reports a friendly error when the baseline file is missing', async () => {
    const input = join(dir, 'report.json');
    writeFileSync(input, makeReport([sampleFinding()]));
    await runBaseline({
      command: 'baseline',
      positional: ['diff'],
      flags: { input, baseline: join(dir, 'nope.json'), 'no-color': true },
    });
    expect(stderrBuf).toContain('cannot read');
    expect(process.exitCode).toBe(2);
  });
});
