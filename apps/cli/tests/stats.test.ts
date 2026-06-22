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

  describe('--by file + --top-files', () => {
    const FILES_REPORT = {
      aggregated: {
        findings: [
          // 3 in a.ts, 2 in b.ts, 1 each in c-f.
          { agent: 'a', category: 'style', severity: 'medium', title: 't', rationale: 'r', file: 'src/a.ts', startLine: 10, confidence: 0.5, tags: [] },
          { agent: 'a', category: 'style', severity: 'medium', title: 't', rationale: 'r', file: 'src/a.ts', startLine: 20, confidence: 0.5, tags: [] },
          { agent: 'a', category: 'style', severity: 'medium', title: 't', rationale: 'r', file: 'src/a.ts', startLine: 30, confidence: 0.5, tags: [] },
          { agent: 'a', category: 'style', severity: 'medium', title: 't', rationale: 'r', file: 'src/b.ts', startLine: 10, confidence: 0.5, tags: [] },
          { agent: 'a', category: 'style', severity: 'medium', title: 't', rationale: 'r', file: 'src/b.ts', startLine: 20, confidence: 0.5, tags: [] },
          { agent: 'a', category: 'style', severity: 'medium', title: 't', rationale: 'r', file: 'src/c.ts', startLine: 10, confidence: 0.5, tags: [] },
          { agent: 'a', category: 'style', severity: 'medium', title: 't', rationale: 'r', file: 'src/d.ts', startLine: 10, confidence: 0.5, tags: [] },
          { agent: 'a', category: 'style', severity: 'medium', title: 't', rationale: 'r', file: 'src/e.ts', startLine: 10, confidence: 0.5, tags: [] },
          { agent: 'a', category: 'style', severity: 'medium', title: 't', rationale: 'r', file: 'src/f.ts', startLine: 10, confidence: 0.5, tags: [] },
        ],
      },
    };

    it('leads with the By file block when --by file', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILES_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'file', 'no-color': true },
      });
      const o = out();
      const idxByFile = o.indexOf('By file');
      const idxBySeverity = o.indexOf('Findings by severity:');
      expect(idxByFile).toBeGreaterThan(-1);
      expect(idxBySeverity).toBeGreaterThan(-1);
      expect(idxByFile).toBeLessThan(idxBySeverity);
      // Files sorted by descending count; a.ts (3) then b.ts (2) then the rest.
      expect(o).toMatch(/src\/a\.ts\s+3/);
      expect(o).toMatch(/src\/b\.ts\s+2/);
    });

    it('shows the "top N of M" suffix on the By file header when --top-files trims', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILES_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'file', 'top-files': 3, 'no-color': true },
      });
      const o = out();
      // 6 distinct files; --top-files 3 => header should mention "top 3 of 6".
      expect(o).toMatch(/By file \(top 3 of 6\):/);
      // Only the first three rows render (a, b, c).
      expect(o).toContain('src/a.ts');
      expect(o).toContain('src/b.ts');
      expect(o).toContain('src/c.ts');
      expect(o).not.toContain('src/d.ts');
      expect(o).not.toContain('src/e.ts');
      expect(o).not.toContain('src/f.ts');
    });

    it('skips the secondary Top files block when --by file is the primary', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILES_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'file', 'no-color': true },
      });
      const o = out();
      // The "Top files:" secondary heading must NOT appear -- the same
      // numbers already live in the "By file" primary block above.
      expect(o.includes('Top files:')).toBe(false);
    });

    it('keeps the secondary Top files block when --by is NOT file', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILES_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, 'no-color': true },
      });
      const o = out();
      expect(o).toContain('Top files:');
    });

    it('--top-files clamps to [1, 200] when given garbage', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILES_REPORT));

      // Zero collapses to 1.
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'top-files': 0, 'no-color': true },
      });
      let parsed = JSON.parse(out());
      expect(parsed.topFiles).toHaveLength(1);

      stdoutSpy.mockClear();
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'top-files': 10_000, 'no-color': true },
      });
      parsed = JSON.parse(out());
      // 6 distinct files, hard ceiling 200 => 6.
      expect(parsed.topFiles).toHaveLength(6);

      stdoutSpy.mockClear();
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'top-files': 'bogus', 'no-color': true },
      });
      parsed = JSON.parse(out());
      // Bad value falls back to default 5.
      expect(parsed.topFiles).toHaveLength(5);
    });

    it('rejects --by file when paired with an unknown axis sentinel', async () => {
      // Defensive: ensure VALID_GROUPINGS still rejects junk axes.
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILES_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'directory', 'no-color': true },
      });
      expect(process.exitCode).toBe(2);
      expect(err()).toContain('--by must be one of severity, agent, category, file');
    });

    it('--format json exposes byFile alongside the other digest shapes', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILES_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'top-files': 2, 'no-color': true },
      });
      const parsed = JSON.parse(out());
      expect(parsed.byFile['src/a.ts']).toBe(3);
      expect(parsed.byFile['src/b.ts']).toBe(2);
      // topFiles still honors the cap and reports only the top-2.
      expect(parsed.topFiles).toHaveLength(2);
      expect(parsed.topFiles[0]).toEqual({ file: 'src/a.ts', count: 3 });
      expect(parsed.topFiles[1]).toEqual({ file: 'src/b.ts', count: 2 });
    });
  });

  // Tick 10: --top-agents <n> + --top-categories <n> mirror --top-files
  // for the agent / category groupings. They cap BOTH the text render
  // of --by agent / --by category AND the json topAgents / topCategories
  // arrays.
  describe('--top-agents and --top-categories', () => {
    const MANY_AGENTS_REPORT = {
      aggregated: {
        findings: Array.from({ length: 25 }, (_, i) => ({
          agent: `agent-${String(i % 12).padStart(2, '0')}`,
          category: i % 2 === 0 ? 'security' : 'style',
          severity: 'medium' as const,
          title: `t${i}`,
          rationale: `r${i}`,
          file: `src/f${i % 4}.ts`,
          startLine: i,
          confidence: 0.5,
          tags: [],
        })),
      },
    };

    it('caps the rendered --by agent text block at --top-agents', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(MANY_AGENTS_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'agent', 'top-agents': 3, 'no-color': true },
      });
      const o = out();
      // 12 distinct agents -> header shows the trim.
      expect(o).toMatch(/By agent \(top 3 of 12\):/);
      // Only three agent rows render in the BY AGENT primary block.
      // (The header line is the only "By agent" occurrence in the
      // primary slot, so we count agent-* rows under it instead.)
      const rows = o.match(/^\s+agent-\d{2}\b/gm) ?? [];
      // Three primary-block rows + zero secondary (--by agent puts
      // the agent block first, no agent secondary).
      expect(rows.length).toBe(3);
    });

    it('caps the rendered --by category text block at --top-categories', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(MANY_AGENTS_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, by: 'category', 'top-categories': 1, 'no-color': true },
      });
      const o = out();
      // 2 distinct categories -> header shows the trim.
      expect(o).toMatch(/By category \(top 1 of 2\):/);
    });

    it('caps the secondary --by agent block in severity-default mode too', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(MANY_AGENTS_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, 'top-agents': 4, 'no-color': true },
      });
      const o = out();
      // Default severity-first render still honors the agent cap in
      // the secondary block so an operator setting --top-agents sees
      // the trim regardless of which --by primary they chose.
      expect(o).toMatch(/By agent \(top 4 of 12\):/);
    });

    it('--format json carries topAgents and topCategories arrays alongside the maps', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(MANY_AGENTS_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          format: 'json',
          'top-agents': 5,
          'top-categories': 1,
          'no-color': true,
        },
      });
      const parsed = JSON.parse(out());
      expect(parsed.topAgents).toHaveLength(5);
      // First entry is the highest-count agent; assert it has agent +
      // count shape (we don't assert the specific agent because the
      // sort order on ties is alphabetical).
      expect(typeof parsed.topAgents[0].agent).toBe('string');
      expect(typeof parsed.topAgents[0].count).toBe('number');
      // topCategories capped to 1.
      expect(parsed.topCategories).toHaveLength(1);
      // The full sparse byAgent / byCategory maps still contain
      // everything (the cap is only on the topAgents / topCategories
      // render slices).
      expect(Object.keys(parsed.byAgent).length).toBe(12);
      expect(Object.keys(parsed.byCategory).length).toBe(2);
    });

    it('--top-agents clamps to [1, 200] when given garbage', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(MANY_AGENTS_REPORT));

      // Zero collapses to 1.
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'top-agents': 0, 'no-color': true },
      });
      let parsed = JSON.parse(out());
      expect(parsed.topAgents).toHaveLength(1);

      stdoutSpy.mockClear();
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'top-agents': 'bogus', 'no-color': true },
      });
      parsed = JSON.parse(out());
      // Bad value falls back to default 10 (but only 12 agents exist,
      // so we get min(10, 12) == 10).
      expect(parsed.topAgents).toHaveLength(10);
    });

    it('defaults to 10 / 10 when neither flag is set', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(MANY_AGENTS_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'no-color': true },
      });
      const parsed = JSON.parse(out());
      // Default cap is 10 for both. 12 agents -> 10; 2 categories -> 2.
      expect(parsed.topAgents).toHaveLength(10);
      expect(parsed.topCategories).toHaveLength(2);
    });
  });

  // Tick 20: --min-confidence + --severity-threshold pre-bucket
  // filters. Both flags surface findingDigest()'s tick-19 / tick-20
  // pre-filter knobs so an operator can preview "what would my report
  // look like with a 0.6 floor / a 'medium' threshold?" without
  // editing config / re-running review.
  describe('--min-confidence and --severity-threshold (tick 20)', () => {
    // A small mixed report: 3 findings spanning confidence + severity
    // so the filter arms can be checked independently.
    const FILTER_REPORT = {
      aggregated: {
        findings: [
          { agent: 'A', category: 'security', severity: 'critical', title: 'C',
            rationale: '', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
          { agent: 'B', category: 'style', severity: 'medium', title: 'M',
            rationale: '', file: 'b.ts', startLine: 2, confidence: 0.3, tags: [] },
          { agent: 'C', category: 'style', severity: 'nit', title: 'N',
            rationale: '', file: 'c.ts', startLine: 3, confidence: 0.4, tags: [] },
        ],
      },
      summary: { agentExecutions: [], totalCostUsd: 0 },
    };

    it('--min-confidence floors the per-bucket totals BEFORE counting', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'min-confidence': '0.5', 'no-color': true },
      });
      const parsed = JSON.parse(out());
      // Only the 0.9 critical finding survives the 0.5 floor.
      expect(parsed.totals.critical).toBe(1);
      expect(parsed.totals.medium).toBe(0);
      expect(parsed.totals.nit).toBe(0);
      // Echoed filter is the resolved (clamped) numeric.
      expect(parsed.minConfidence).toBe(0.5);
      expect(parsed.severityThreshold).toBeNull();
    });

    it('--severity-threshold drops less-severe findings BEFORE counting', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          format: 'json',
          'severity-threshold': 'medium',
          'no-color': true,
        },
      });
      const parsed = JSON.parse(out());
      // critical + medium pass; nit dropped.
      expect(parsed.totals.critical).toBe(1);
      expect(parsed.totals.medium).toBe(1);
      expect(parsed.totals.nit).toBe(0);
      expect(parsed.severityThreshold).toBe('medium');
    });

    it('--min-confidence + --severity-threshold compose (AND semantics)', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          format: 'json',
          'min-confidence': '0.5',
          'severity-threshold': 'medium',
          'no-color': true,
        },
      });
      const parsed = JSON.parse(out());
      // Only critical (0.9 conf + critical sev) clears BOTH floors.
      expect(parsed.totals.critical).toBe(1);
      expect(parsed.totals.medium).toBe(0); // failed confidence
      expect(parsed.totals.nit).toBe(0); // failed both
      // Both filters echoed.
      expect(parsed.minConfidence).toBe(0.5);
      expect(parsed.severityThreshold).toBe('medium');
    });

    it('unknown / mis-cased --severity-threshold is treated as no filter (forgiving)', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          format: 'json',
          'severity-threshold': 'Critical', // wrong case
          'no-color': true,
        },
      });
      const parsed = JSON.parse(out());
      // All three findings counted (filter normalised to null inside digest).
      expect(parsed.totals.critical).toBe(1);
      expect(parsed.totals.medium).toBe(1);
      expect(parsed.totals.nit).toBe(1);
      // Echo carries the raw operator-supplied value so a CI gate
      // can detect the typo even though the filter silently no-op'd.
      expect(parsed.severityThreshold).toBe('Critical');
    });

    it('echoes null for both filters when neither flag is supplied (back-compat)', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, format: 'json', 'no-color': true },
      });
      const parsed = JSON.parse(out());
      expect(parsed.minConfidence).toBeNull();
      expect(parsed.severityThreshold).toBeNull();
      // And the totals reflect every finding (no filter).
      expect(parsed.totals.critical).toBe(1);
      expect(parsed.totals.medium).toBe(1);
      expect(parsed.totals.nit).toBe(1);
    });

    it('composes with --fail-on (filter runs first, gate runs on filtered totals)', async () => {
      // Drop nit/low + the 0.3 medium via the floor; only critical
      // remains. --fail-on high then sees 1 finding at-or-above high
      // and exits 1. Verifies the filter order: filter -> gate.
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          'min-confidence': '0.7',
          'fail-on': 'high',
          'no-color': true,
        },
      });
      // Critical survived the floor; gate fires (exit 1).
      expect(process.exitCode).toBe(1);
      expect(err()).toContain('1 finding(s) at or above');
    });
  });
});
