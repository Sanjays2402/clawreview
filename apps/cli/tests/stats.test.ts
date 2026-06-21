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

  describe('--by grouping', () => {
    it('groups findings by agent and leads the output with that block when --by agent', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(SAMPLE_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'agent', 'no-color': true },
      });
      const o = out();
      // The agent block leads the output: ClawReview report header, then By agent:.
      const idxByAgent = o.indexOf('By agent:');
      const idxBySeverity = o.indexOf('Findings by severity:');
      expect(idxByAgent).toBeGreaterThan(-1);
      expect(idxBySeverity).toBeGreaterThan(-1);
      expect(idxByAgent).toBeLessThan(idxBySeverity);
      // 1 security finding, 2 style findings -> style 2, security 1.
      expect(o).toMatch(/style\s+2/);
      expect(o).toMatch(/security\s+1/);
    });

    it('groups findings by category when --by category', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(SAMPLE_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'category', 'no-color': true },
      });
      const o = out();
      const idxByCategory = o.indexOf('By category:');
      const idxBySeverity = o.indexOf('Findings by severity:');
      expect(idxByCategory).toBeGreaterThan(-1);
      expect(idxByCategory).toBeLessThan(idxBySeverity);
      // 1 security + 2 style findings -> style 2, security 1.
      expect(o).toMatch(/style\s+2/);
      expect(o).toMatch(/security\s+1/);
    });

    it('keeps severity as the default --by axis when omitted', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(SAMPLE_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, 'no-color': true },
      });
      const o = out();
      // Severity leads, then secondary by-agent/by-category blocks.
      const idxSeverity = o.indexOf('Findings by severity:');
      const idxAgent = o.indexOf('By agent:');
      expect(idxSeverity).toBeGreaterThan(-1);
      expect(idxAgent).toBeGreaterThan(idxSeverity);
    });

    it('rejects an unknown --by value with exit 2', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(SAMPLE_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'bogus', 'no-color': true },
      });
      expect(process.exitCode).toBe(2);
      expect(err()).toContain('--by must be one of severity, agent, category');
    });

    it('keeps --fail-on keying on severity regardless of --by axis', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(SAMPLE_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'agent', 'fail-on': 'high', 'no-color': true },
      });
      // SAMPLE_REPORT has 1 critical finding, --fail-on high should exit 1.
      expect(process.exitCode).toBe(1);
      expect(err()).toContain('at or above');
    });

    it('sorts grouping entries by descending count then by key', async () => {
      const file = join(dir, 'r.json');
      await writeFile(
        file,
        JSON.stringify({
          aggregated: {
            findings: [
              { agent: 'b', category: 'security', severity: 'medium', title: 'x', rationale: 'r', file: 'a', startLine: 1, confidence: 0.5, tags: [] },
              { agent: 'a', category: 'security', severity: 'medium', title: 'x', rationale: 'r', file: 'b', startLine: 1, confidence: 0.5, tags: [] },
              { agent: 'a', category: 'security', severity: 'medium', title: 'x', rationale: 'r', file: 'c', startLine: 1, confidence: 0.5, tags: [] },
            ],
          },
        }),
      );
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'agent', 'no-color': true },
      });
      const o = out();
      // `a` (2) must appear before `b` (1) in the By agent block.
      const idxA = o.indexOf('a       ');
      const idxB = o.indexOf('b       ');
      expect(idxA).toBeGreaterThan(-1);
      expect(idxB).toBeGreaterThan(-1);
      expect(idxA).toBeLessThan(idxB);
    });
  });

  describe('--format json', () => {
    it('emits totals, byAgent, byCategory, topFiles, and totalCostUsd', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(SAMPLE_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'no-color': true },
      });
      const parsed = JSON.parse(out());
      expect(parsed.totals.critical).toBe(1);
      expect(parsed.totals.medium).toBe(1);
      expect(parsed.totals.nit).toBe(1);
      expect(parsed.byAgent.style).toBe(2);
      expect(parsed.byAgent.security).toBe(1);
      expect(parsed.byCategory.style).toBe(2);
      expect(parsed.byCategory.security).toBe(1);
      expect(parsed.totalCostUsd).toBe(0.0123);
      // topFiles is sorted by descending count.
      expect(parsed.topFiles[0].file).toBe('src/a.ts');
      expect(parsed.topFiles[0].count).toBe(2);
      expect(parsed.groupBy).toBe('severity');
    });

    it('reflects --by in the JSON groupBy field', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(SAMPLE_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', by: 'agent', 'no-color': true },
      });
      const parsed = JSON.parse(out());
      expect(parsed.groupBy).toBe('agent');
    });

    it('still gates on --fail-on with --format json', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(SAMPLE_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'fail-on': 'critical', 'no-color': true },
      });
      // JSON still emitted (the CI artifact stays useful), but exit 1 fires.
      const parsed = JSON.parse(out());
      expect(parsed.totals.critical).toBe(1);
      expect(process.exitCode).toBe(1);
    });

    it('rejects an unknown --format value with exit 2', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(SAMPLE_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'csv', 'no-color': true },
      });
      expect(process.exitCode).toBe(2);
      expect(err()).toContain('--format must be text|json');
    });
  });
});
