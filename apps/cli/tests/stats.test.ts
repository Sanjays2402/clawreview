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

  // Tick 21: --filter-summary opts the operator into a one-line
  // header in text-mode output showing which filter(s) applied and
  // how many findings were dropped. Default OFF for back-compat;
  // JSON mode is unaffected (existing tick-20 echo serves that use
  // case).
  describe('--filter-summary text-mode header (tick 21)', () => {
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

    it('absent flag: no Showing-line in text output (back-compat)', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, 'no-color': true },
      });
      expect(out()).not.toContain('Showing');
    });

    it('--filter-summary with no filters prints "no filters applied" line', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: { input: file, 'filter-summary': true, 'no-color': true },
      });
      // 3 findings, none dropped, no filter -> uniform line.
      expect(out()).toContain('Showing 3 findings (filtered 0 of 3; no filters applied)');
    });

    it('--filter-summary + --min-confidence shows the floor and dropped count', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          'min-confidence': '0.5',
          'filter-summary': true,
          'no-color': true,
        },
      });
      // 1 finding survives the 0.5 floor; 2 dropped.
      expect(out()).toContain('Showing 1 finding (filtered 2 of 3 by min_confidence >= 0.5)');
    });

    it('--filter-summary + --severity-threshold shows the threshold and dropped count', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          'severity-threshold': 'medium',
          'filter-summary': true,
          'no-color': true,
        },
      });
      // critical + medium survive; nit dropped.
      expect(out()).toContain('Showing 2 findings (filtered 1 of 3 by severity_threshold >= medium)');
    });

    it('--filter-summary + both filters joins them with +', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          'min-confidence': '0.5',
          'severity-threshold': 'medium',
          'filter-summary': true,
          'no-color': true,
        },
      });
      // Both filters applied: critical alone passes both.
      expect(out()).toContain('Showing 1 finding (filtered 2 of 3 by min_confidence >= 0.5 + severity_threshold >= medium)');
    });

    it('--filter-summary with clamped --min-confidence 1.5 shows >= 1 (normalised)', async () => {
      // Headline use case from the roadmap: the line shows the
      // CLAMPED value, not the raw 1.5 -- matches the server's
      // ?normalisedEcho contract so an operator reading either
      // surface sees the same number.
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          'min-confidence': '1.5',
          'filter-summary': true,
          'no-color': true,
        },
      });
      expect(out()).toContain('min_confidence >= 1');
    });

    it('--filter-summary with mis-cased --severity-threshold falls under "no filters applied"', async () => {
      // A typo normalises to null inside the digest -> applied=false
      // -> the line collapses to "no filters applied" (the typo
      // didn't make the filter run; the JSON echo still surfaces
      // the raw value so a CI gate can detect it).
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          'severity-threshold': 'Critical', // wrong case
          'filter-summary': true,
          'no-color': true,
        },
      });
      expect(out()).toContain('no filters applied');
    });

    it('--filter-summary does not affect JSON output (tick-20 echo is the JSON surface)', async () => {
      const file = join(dir, 'r.json');
      await writeFile(file, JSON.stringify(FILTER_REPORT));
      await runStats({
        command: 'stats',
        positional: [],
        flags: {
          input: file,
          'min-confidence': '0.5',
          'filter-summary': true,
          format: 'json',
          'no-color': true,
        },
      });
      // JSON shape unchanged: the tick-20 echoes are present, no
      // new "Showing" string anywhere in the body.
      const parsed = JSON.parse(out());
      expect(parsed.minConfidence).toBe(0.5);
      expect(out()).not.toContain('Showing');
    });

    // Tick 22: --json-header opts the JSON mode into emitting a
    // one-line JSON envelope BEFORE the multi-line report body so
    // a CI pipeline can `head -1 | jq` to short-circuit without
    // parsing the whole report. Requires --filter-summary so the
    // flag composes the existing opt-in. Default OFF for back-
    // compat -- existing JSON consumers see no diff.
    describe('--json-header JSON envelope (tick 22)', () => {
      it('absent flag: JSON output shape unchanged (back-compat)', async () => {
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'min-confidence': '0.5',
            'filter-summary': true,
            format: 'json',
            'no-color': true,
          },
        });
        // No header line: the whole stdout MUST parse as a single
        // JSON object (no leading envelope to break consumers that
        // do `JSON.parse(stdout)` directly).
        const parsed = JSON.parse(out());
        expect(parsed.totals).toBeDefined();
        expect(parsed.minConfidence).toBe(0.5);
      });

      it('--filter-summary + --json-header + json: emits envelope first, then report body', async () => {
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'min-confidence': '0.5',
            'filter-summary': true,
            'json-header': true,
            format: 'json',
            'no-color': true,
          },
        });
        // First line: one-line JSON envelope.
        const stdout = out();
        const lines = stdout.trim().split('\n');
        const header = JSON.parse(lines[0]!);
        expect(header.kind).toBe('filterSummary');
        expect(header.showing).toBe(1);
        expect(header.inputTotal).toBe(3);
        expect(header.droppedTotal).toBe(2);
        expect(header.minConfidence.normalised).toBe(0.5);
        expect(header.minConfidence.applied).toBe(true);
        expect(header.severityThreshold.applied).toBe(false);
        expect(header.any).toBe(true);
        // Remaining lines: the existing JSON report body (parses
        // independently of the header).
        const body = JSON.parse(lines.slice(1).join('\n'));
        expect(body.totals).toBeDefined();
        expect(body.minConfidence).toBe(0.5);
      });

      it('--json-header with NO filters echoes a no-filter envelope (kind still filterSummary)', async () => {
        // A CI gate that always reads the first line expects the
        // discriminator to be stable regardless of whether a filter
        // ran. Pin that here.
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'filter-summary': true,
            'json-header': true,
            format: 'json',
            'no-color': true,
          },
        });
        const lines = out().trim().split('\n');
        const header = JSON.parse(lines[0]!);
        expect(header.kind).toBe('filterSummary');
        expect(header.showing).toBe(3);
        expect(header.droppedTotal).toBe(0);
        expect(header.any).toBe(false);
        expect(header.minConfidence.applied).toBe(false);
        expect(header.severityThreshold.applied).toBe(false);
      });

      it('--json-header WITHOUT --filter-summary is a no-op (composition requires both)', async () => {
        // The flag has no meaning without --filter-summary because
        // there's no summary to emit. We intentionally don't 400 --
        // a CI pipeline that pre-bakes a fleet of flags can pass
        // both unconditionally; the header only fires when the
        // summary opt-in is set.
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'min-confidence': '0.5',
            'json-header': true, // <-- without filter-summary
            format: 'json',
            'no-color': true,
          },
        });
        // No header on stdout: the whole output is a single JSON
        // object (the report body).
        const parsed = JSON.parse(out());
        expect(parsed.minConfidence).toBe(0.5);
      });

      it('--json-header in text mode is a no-op (text already prints the summary line)', async () => {
        // The flag is JSON-mode specific. In text mode we don't
        // want a duplicate header AND the existing "Showing N"
        // line; we leave the text output alone.
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'min-confidence': '0.5',
            'filter-summary': true,
            'json-header': true,
            // format: 'text' (default)
            'no-color': true,
          },
        });
        // Text output unchanged: still has the "Showing 1 finding"
        // line (the text summary), no JSON envelope.
        const stdout = out();
        expect(stdout).toContain('Showing 1 finding');
        expect(stdout).not.toContain('"kind":"filterSummary"');
      });

      it('renderFilterSummaryJson pure helper builds the envelope shape', async () => {
        const { renderFilterSummaryJson } = await import('../src/commands/stats.js');
        const { findingDigestWithFilterReport } = await import('@clawreview/aggregator');
        const findings = FILTER_REPORT.aggregated.findings;
        const report = findingDigestWithFilterReport(findings as never, { minConfidence: 0.5 });
        const env = renderFilterSummaryJson(report);
        expect(env.kind).toBe('filterSummary');
        expect(env.showing).toBe(1);
        expect(env.inputTotal).toBe(3);
        expect(env.droppedTotal).toBe(2);
        expect(env.minConfidence.raw).toBe(0.5);
        expect(env.minConfidence.normalised).toBe(0.5);
        expect(env.minConfidence.applied).toBe(true);
        expect(env.severityThreshold.raw).toBeUndefined();
        expect(env.severityThreshold.applied).toBe(false);
        expect(env.any).toBe(true);
      });
    });

    // Tick 23: --jsonl streams the report as line-delimited JSON
    // (header + per-severity + footer) so a log-aggregator pipeline
    // can ingest each line independently. Requires the full opt-in
    // chain (--filter-summary + --json-header + --jsonl) so existing
    // JSON consumers see no diff.
    describe('--jsonl line-delimited stream (tick 23)', () => {
      it('emits header + 5 severity buckets + footer when the full opt-in chain is set', async () => {
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'min-confidence': '0.5',
            'filter-summary': true,
            'json-header': true,
            jsonl: true,
            format: 'json',
            'no-color': true,
          },
        });
        const stdout = out();
        const lines = stdout.trim().split('\n');
        // 1 header + 5 severity + 1 footer = 7 lines exactly.
        expect(lines).toHaveLength(7);
        // Header still has kind=filterSummary.
        const header = JSON.parse(lines[0]!);
        expect(header.kind).toBe('filterSummary');
        expect(header.showing).toBe(1);
        expect(header.droppedTotal).toBe(2);
        // Lines 2-6: one per severity, canonical order.
        const expectedOrder = ['critical', 'high', 'medium', 'low', 'nit'];
        for (let i = 0; i < 5; i += 1) {
          const bucket = JSON.parse(lines[1 + i]!);
          expect(bucket.kind).toBe('severityBucket');
          expect(bucket.severity).toBe(expectedOrder[i]);
        }
        // The 0.5 floor leaves only the 0.9 critical finding.
        const critical = JSON.parse(lines[1]!);
        expect(critical.severity).toBe('critical');
        expect(critical.count).toBe(1);
        const medium = JSON.parse(lines[3]!);
        expect(medium.severity).toBe('medium');
        expect(medium.count).toBe(0);
        // Footer line: kind=reportFooter carries the rest of the
        // payload (byAgent / byCategory / topFiles / etc).
        const footer = JSON.parse(lines[6]!);
        expect(footer.kind).toBe('reportFooter');
        expect(footer.minConfidence).toBe(0.5);
        expect(footer.groupBy).toBe('severity');
        expect(footer.byAgent).toBeDefined();
        expect(footer.topFiles).toBeDefined();
      });

      it('falls back to the pretty-printed body when --jsonl is set but --json-header is not', async () => {
        // --jsonl is a no-op without --json-header. We don't 400 the
        // composition because a CI pipeline pre-baking flags should
        // be able to pass both unconditionally; the JSONL stream
        // only fires when the full chain is set.
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'min-confidence': '0.5',
            'filter-summary': true,
            jsonl: true, // --json-header missing
            format: 'json',
            'no-color': true,
          },
        });
        // Output parses as a single JSON object (legacy body),
        // NOT as line-delimited JSON.
        const parsed = JSON.parse(out());
        expect(parsed.totals).toBeDefined();
        expect(parsed.minConfidence).toBe(0.5);
        // No severityBucket kind in the output.
        expect(out()).not.toContain('"kind":"severityBucket"');
      });

      it('--jsonl in text mode is a silent no-op (no JSONL stream, text body unchanged)', async () => {
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'min-confidence': '0.5',
            'filter-summary': true,
            'json-header': true,
            jsonl: true,
            // format: text (default)
            'no-color': true,
          },
        });
        const stdout = out();
        // Text output unchanged: still has the Showing line + the
        // severity block, NOT the JSON envelope.
        expect(stdout).toContain('Showing 1 finding');
        expect(stdout).not.toContain('"kind":"severityBucket"');
        expect(stdout).not.toContain('"kind":"filterSummary"');
      });

      it('--jsonl with NO filter still emits the 5 severity lines + a no-filter header', async () => {
        // The shape stays consistent: a downstream consumer always
        // sees header (kind=filterSummary, any=false) + 5 buckets
        // + footer, regardless of whether a filter actually ran.
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'filter-summary': true,
            'json-header': true,
            jsonl: true,
            format: 'json',
            'no-color': true,
          },
        });
        const lines = out().trim().split('\n');
        expect(lines).toHaveLength(7);
        const header = JSON.parse(lines[0]!);
        expect(header.any).toBe(false);
        expect(header.droppedTotal).toBe(0);
        // All 5 buckets land at their unfiltered counts.
        const critical = JSON.parse(lines[1]!);
        expect(critical.count).toBe(1);
        const nit = JSON.parse(lines[5]!);
        expect(nit.count).toBe(1);
      });

      it('--jsonl honours --fail-on (CI gate exits non-zero when bucket lands at or above threshold)', async () => {
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'filter-summary': true,
            'json-header': true,
            jsonl: true,
            'fail-on': 'high',
            format: 'json',
            'no-color': true,
          },
        });
        // The unfiltered FILTER_REPORT has 1 critical -> fail-on high triggers.
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
        // But the JSONL stream is STILL fully emitted so a consumer
        // can inspect the report even on a fail.
        const lines = out().trim().split('\n');
        expect(lines).toHaveLength(7);
      });

      it('renderSeverityBucketLine pure helper builds the bucket shape', async () => {
        const { renderSeverityBucketLine } = await import('../src/commands/stats.js');
        const line = renderSeverityBucketLine('critical', 5);
        expect(line).toEqual({ kind: 'severityBucket', severity: 'critical', count: 5 });
        // Zero count is preserved (fixed-shape histogram contract).
        const zero = renderSeverityBucketLine('nit', 0);
        expect(zero.count).toBe(0);
        expect(zero.kind).toBe('severityBucket');
      });
    });

    // Tick 25: --no-footer suppresses the JSONL footer line so a
    // consumer that only wants the header + per-severity buckets
    // gets exactly that. Default OFF for back-compat with the
    // tick-23 7-line stream contract.
    describe('--jsonl --no-footer (tick 25)', () => {
      it('emits header + 5 severity buckets (6 lines total, no footer)', async () => {
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'min-confidence': '0.5',
            'filter-summary': true,
            'json-header': true,
            jsonl: true,
            'no-footer': true,
            format: 'json',
            'no-color': true,
          },
        });
        const lines = out().trim().split('\n');
        // 1 header + 5 severity = 6 lines (footer suppressed).
        expect(lines).toHaveLength(6);
        // Header still has kind=filterSummary.
        expect(JSON.parse(lines[0]!).kind).toBe('filterSummary');
        // Lines 2-6 are the severity buckets in canonical order.
        const order = ['critical', 'high', 'medium', 'low', 'nit'];
        for (let i = 0; i < 5; i += 1) {
          const bucket = JSON.parse(lines[1 + i]!);
          expect(bucket.kind).toBe('severityBucket');
          expect(bucket.severity).toBe(order[i]);
        }
        // No reportFooter line.
        expect(out()).not.toContain('"kind":"reportFooter"');
      });

      it('--no-footer is a no-op when --jsonl is not set (legacy body still has footer fields)', async () => {
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'min-confidence': '0.5',
            'filter-summary': true,
            'json-header': true,
            // --jsonl is missing -- --no-footer should have no effect.
            'no-footer': true,
            format: 'json',
            'no-color': true,
          },
        });
        // Output is the legacy single-object JSON body; --no-footer
        // didn't strip the byAgent / topFiles fields from it.
        const stdout = out().trim();
        // One header line then the pretty JSON body. Strip the header.
        const newlineIdx = stdout.indexOf('\n');
        const body = JSON.parse(stdout.slice(newlineIdx + 1));
        expect(body.byAgent).toBeDefined();
        expect(body.topFiles).toBeDefined();
      });

      it('--no-footer is a no-op in text mode (text output unchanged)', async () => {
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'min-confidence': '0.5',
            'filter-summary': true,
            'json-header': true,
            jsonl: true,
            'no-footer': true,
            // format: text (default)
            'no-color': true,
          },
        });
        const stdout = out();
        // Same text body --jsonl produces (text-mode is silent no-op
        // for the JSONL chain; --no-footer is also silent here).
        expect(stdout).toContain('Showing 1 finding');
        expect(stdout).not.toContain('"kind":"severityBucket"');
      });

      it('--no-footer + --fail-on: gate still fires (CI consumer keeps its exit code contract)', async () => {
        const file = join(dir, 'r.json');
        await writeFile(file, JSON.stringify(FILTER_REPORT));
        await runStats({
          command: 'stats',
          positional: [],
          flags: {
            input: file,
            'filter-summary': true,
            'json-header': true,
            jsonl: true,
            'no-footer': true,
            'fail-on': 'high',
            format: 'json',
            'no-color': true,
          },
        });
        // Unfiltered FILTER_REPORT has 1 critical -> fail-on high fires.
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
        // Stream is 6 lines: header + 5 buckets, no footer.
        const lines = out().trim().split('\n');
        expect(lines).toHaveLength(6);
      });
    });
  });
});
