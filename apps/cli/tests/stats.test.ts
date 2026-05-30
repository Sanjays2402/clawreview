import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runStats } from '../src/commands/stats.js';

const SAMPLE_REPORT = {
  aggregated: {
    findings: [
      {
        agent: 'security',
        category: 'security',
        severity: 'critical',
        title: 'rce',
        rationale: 'eval()',
        file: 'src/a.ts',
        startLine: 10,
        confidence: 0.9,
        tags: [],
      },
      {
        agent: 'style',
        category: 'style',
        severity: 'medium',
        title: 'name',
        rationale: 'bad name',
        file: 'src/a.ts',
        startLine: 20,
        confidence: 0.6,
        tags: [],
      },
      {
        agent: 'style',
        category: 'style',
        severity: 'nit',
        title: 'spacing',
        rationale: 'fmt',
        file: 'src/b.ts',
        startLine: 1,
        confidence: 0.4,
        tags: [],
      },
    ],
  },
  summary: {
    agentExecutions: [
      { agent: 'security', status: 'ok', durationMs: 1234, findings: [{}] },
      { agent: 'style', status: 'ok', durationMs: 567, findings: [{}, {}] },
    ],
    totalCostUsd: 0.0123,
  },
};

describe('runStats', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let dir: string;

  beforeEach(async () => {
    process.exitCode = 0;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    dir = await mkdtemp(join(tmpdir(), 'clawreview-stats-'));
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = 0;
  });

  function out(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
  }
  function err(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  it('prints totals, per-agent breakdown, top files, and LLM cost', async () => {
    const file = join(dir, 'r.json');
    await writeFile(file, JSON.stringify(SAMPLE_REPORT));
    await runStats({ command: 'stats', positional: [], flags: { input: file, 'no-color': true } });
    const o = out();
    expect(o).toContain('ClawReview report');
    expect(o).toContain('Critical');
    expect(o).toMatch(/Critical\s+1/);
    expect(o).toMatch(/Medium\s+1/);
    expect(o).toMatch(/Nit\s+1/);
    expect(o).toContain('By agent:');
    expect(o).toContain('security');
    expect(o).toContain('Top files:');
    expect(o).toContain('src/a.ts');
    expect(o).toContain('Total LLM cost:  $0.0123');
    expect(process.exitCode || 0).toBe(0);
  });

  it('exits with code 1 when findings meet --fail-on threshold', async () => {
    const file = join(dir, 'r.json');
    await writeFile(file, JSON.stringify(SAMPLE_REPORT));
    await runStats({
      command: 'stats',
      positional: [],
      flags: { input: file, 'fail-on': 'high', 'no-color': true },
    });
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('1 finding(s) at or above');
    expect(err()).toContain('critical');
  });

  it('exits 0 when no finding meets --fail-on threshold', async () => {
    const file = join(dir, 'r.json');
    await writeFile(
      file,
      JSON.stringify({
        aggregated: {
          findings: [
            {
              agent: 'style',
              category: 'style',
              severity: 'nit',
              title: 't',
              rationale: 'r',
              file: 'x',
              startLine: 1,
              confidence: 0.5,
              tags: [],
            },
          ],
        },
      }),
    );
    await runStats({
      command: 'stats',
      positional: [],
      flags: { input: file, 'fail-on': 'high', 'no-color': true },
    });
    expect(process.exitCode || 0).toBe(0);
  });

  it('reports invalid JSON with exit code 2', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(file, '{not json');
    await runStats({ command: 'stats', positional: [], flags: { input: file, 'no-color': true } });
    expect(process.exitCode).toBe(2);
    expect(err()).toContain('invalid JSON');
  });

  it('rejects an unknown severity passed to --fail-on', async () => {
    const file = join(dir, 'r.json');
    await writeFile(file, JSON.stringify({ aggregated: { findings: [] } }));
    await runStats({
      command: 'stats',
      positional: [],
      flags: { input: file, 'fail-on': 'enormous', 'no-color': true },
    });
    expect(process.exitCode).toBe(2);
    expect(err()).toContain("unknown severity 'enormous'");
  });

  it('prefers reported totals when present, even if they differ from the findings array', async () => {
    const file = join(dir, 'r.json');
    await writeFile(
      file,
      JSON.stringify({
        aggregated: {
          findings: [],
          totals: { critical: 0, high: 3, medium: 0, low: 0, nit: 0 },
        },
      }),
    );
    await runStats({
      command: 'stats',
      positional: [],
      flags: { input: file, 'fail-on': 'high', 'no-color': true },
    });
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('3 finding(s) at or above');
  });
});
