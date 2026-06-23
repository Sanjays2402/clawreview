import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { findingDigest } from '@clawreview/aggregator';

import { runReviewDrift } from '../src/commands/review.js';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clawreview-review-drift-'));
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(
  positional: string[],
  flags: Record<string, string | boolean> = {},
): Promise<RunResult> {
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
    await runReviewDrift({
      command: 'review',
      positional: ['drift', ...positional],
      flags: { 'no-color': true, ...flags },
    });
  } finally {
    writeStdout.mockRestore();
    writeStderr.mockRestore();
  }
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code };
}

afterEach(() => {
  process.exitCode = 0;
});

const f = (over: Partial<{ agent: string; category: string; severity: string; file: string; tags: string[] }> = {}) => ({
  agent: 'security',
  category: 'security',
  severity: 'high',
  title: 'X',
  rationale: 'r',
  file: 'src/a.ts',
  startLine: 1,
  confidence: 0.8,
  tags: [],
  ...over,
});

describe('clawreview review drift', () => {
  it('exits 0 with "no drift" text when persisted matches fresh', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'review.json');
    const findings = [f({ severity: 'high' }), f({ severity: 'medium', file: 'src/b.ts' })];
    const digest = findingDigest(findings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    await writeFile(path, JSON.stringify({ findings, digest }));
    const r = await run([], { input: path });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('persisted');
    expect(r.stdout).toContain('fresh');
    expect(r.stdout).toContain('(no drift)');
  });

  it('exits 3 with per-bucket text when drift is present', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'review.json');
    // Persisted built from 2 findings, fresh recomputed from only 1.
    const persistedFindings = [f({ severity: 'high' }), f({ severity: 'medium', file: 'src/b.ts' })];
    const liveFindings = [f({ severity: 'high' })];
    const digest = findingDigest(persistedFindings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    // shape = /api/reviews/:id body (findings + digest)
    await writeFile(path, JSON.stringify({ findings: liveFindings, digest }));
    const r = await run([], { input: path });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('-1');
    expect(r.stdout).toContain('severity');
    expect(r.stdout).toContain('medium');
  });

  it('consumes a tick-14 /digest body (persisted + fresh + drift) directly', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'digest.json');
    const persistedFindings = [f({ severity: 'high' }), f({ severity: 'medium' })];
    const freshFindings = [f({ severity: 'high' })];
    const persisted = findingDigest(persistedFindings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    const fresh = findingDigest(freshFindings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    // No `drift` field; the CLI computes it locally.
    await writeFile(path, JSON.stringify({ reviewId: 'rv_abc', persisted, fresh }));
    const r = await run([], { input: path });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('rv_abc');
    expect(r.stdout).toContain('-1');
  });

  it('honours a pre-computed drift in the /digest body (no recompute)', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'digest.json');
    const persistedFindings = [f({ severity: 'high' })];
    const freshFindings = [f({ severity: 'high' })];
    const persisted = findingDigest(persistedFindings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    const fresh = findingDigest(freshFindings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    // Synthetic drift that DISAGREES with the live recompute on purpose,
    // so we can assert the CLI consumed it verbatim rather than
    // recomputing. (In production the server is the source of truth.)
    const drift = {
      totalDelta: -42,
      bySeverityDelta: { critical: 0, high: -42, medium: 0, low: 0, nit: 0 },
      byAgentDelta: { security: -42 },
      byCategoryDelta: { security: -42 },
      byFileDelta: { 'src/a.ts': -42 },
      byTagDelta: {},
      hasDrift: true,
    };
    await writeFile(path, JSON.stringify({ reviewId: 'rv_xyz', persisted, fresh, drift }));
    const r = await run([], { input: path, format: 'json' });
    expect(r.exitCode).toBe(3);
    const out = JSON.parse(r.stdout);
    expect(out.drift.totalDelta).toBe(-42); // not recomputed
  });

  it('emits the same JSON shape the /digest endpoint returns', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'review.json');
    const findings = [f({ severity: 'high' })];
    const digest = findingDigest(findings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    await writeFile(path, JSON.stringify({ findings, digest }));
    const r = await run([], { input: path, format: 'json' });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toHaveProperty('reviewId');
    expect(out).toHaveProperty('persisted');
    expect(out).toHaveProperty('fresh');
    expect(out).toHaveProperty('drift');
    expect(out.fresh.total).toBe(1);
    expect(out.drift.hasDrift).toBe(false);
  });

  it('renders persisted=null for a legacy /reviews/:id body that pre-dates tick 12', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'review.json');
    const findings = [f({ severity: 'high' })];
    // No `digest` field at all -> persisted is null.
    await writeFile(path, JSON.stringify({ findings }));
    const r = await run([], { input: path });
    expect(r.exitCode).toBe(3); // every fresh bucket is positive
    expect(r.stdout).toContain('(legacy: no persisted digest)');
    expect(r.stdout).toContain('+1');
  });

  it('rejects an empty input with exit 1', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'empty.json');
    await writeFile(path, '');
    const r = await run([], { input: path });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('empty input');
  });

  it('rejects invalid JSON with exit 2', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'bad.json');
    await writeFile(path, '{not json');
    const r = await run([], { input: path });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('invalid JSON');
  });

  it('rejects a body that lacks both fresh and findings with exit 2', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'wrong.json');
    await writeFile(path, JSON.stringify({ reviewId: 'rv_1' }));
    const r = await run([], { input: path });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('expected an /api/reviews/:id');
  });

  it('rejects an invalid --format with exit 2', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'review.json');
    await writeFile(path, JSON.stringify({ findings: [] }));
    const r = await run([], { input: path, format: 'xml' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('invalid --format');
  });

  it('reports a missing --input file with exit 2', async () => {
    const r = await run([], { input: '/nonexistent/path.json' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('cannot read --input');
  });

  it('surfaces byTagDelta in the text render when tags drifted (tick 14 byTag bucket)', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'review.json');
    const persistedFindings = [f({ tags: ['owasp:a01'] }), f({ tags: ['owasp:a01'] })];
    const liveFindings = [f({ tags: ['owasp:a01'] }), f({ tags: ['owasp:a07'] })];
    const digest = findingDigest(persistedFindings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    await writeFile(path, JSON.stringify({ findings: liveFindings, digest }));
    const r = await run([], { input: path });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('tag');
    expect(r.stdout).toContain('owasp:a01');
    expect(r.stdout).toContain('owasp:a07');
  });

  // Tick 20: --min-confidence + --severity-threshold filters on the
  // single-shot review drift command. Same contract as the server's
  // /digest ?minConfidence= / ?severityThreshold= knobs and the CLI's
  // `stats --min-confidence` flag -- all four consumers share one
  // filter contract via findingDigest.
  describe('--min-confidence + --severity-threshold (tick 20)', () => {
    // Mixed findings: 4 total spanning confidence x severity so each
    // filter arm can be exercised independently.
    const mixed = () => [
      { agent: 'A', category: 'security', severity: 'critical', title: 'A',
        rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.9, tags: [] },
      { agent: 'B', category: 'security', severity: 'medium', title: 'B',
        rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.3, tags: [] },
      { agent: 'C', category: 'style', severity: 'low', title: 'C',
        rationale: 'r', file: 'c.ts', startLine: 3, confidence: 0.9, tags: [] },
      { agent: 'D', category: 'style', severity: 'nit', title: 'D',
        rationale: 'r', file: 'd.ts', startLine: 4, confidence: 0.2, tags: [] },
    ];

    it('--min-confidence floors fresh recompute and reflects in drift', async () => {
      const dir = await tmpDir();
      const path = join(dir, 'review.json');
      const findings = mixed();
      // Persisted: unfiltered (4 findings).
      const digest = findingDigest(findings as never, { topAgents: 8, topCategories: 8, hotspots: true });
      await writeFile(path, JSON.stringify({ reviewId: 'rv_filter', findings, digest }));
      const r = await run([], { input: path, 'min-confidence': '0.5', format: 'json' });
      // Persisted counted all 4; filtered fresh keeps only critical + low (confidence 0.9).
      const out = JSON.parse(r.stdout);
      expect(out.persisted.total).toBe(4);
      expect(out.fresh.total).toBe(2);
      expect(out.fresh.totalsBySeverity.critical).toBe(1);
      expect(out.fresh.totalsBySeverity.low).toBe(1);
      expect(out.fresh.totalsBySeverity.medium).toBe(0);
      expect(out.fresh.totalsBySeverity.nit).toBe(0);
      // Echoed filter is the resolved numeric.
      expect(out.minConfidence).toBe(0.5);
      expect(out.severityThreshold).toBeNull();
      // Drift surfaces the gap (-2 from filter).
      expect(out.drift.hasDrift).toBe(true);
      expect(out.drift.totalDelta).toBe(-2);
      // Exit 3 on drift.
      expect(r.exitCode).toBe(3);
    });

    it('--severity-threshold drops less-severe findings from fresh', async () => {
      const dir = await tmpDir();
      const path = join(dir, 'review.json');
      const findings = mixed();
      const digest = findingDigest(findings as never, { topAgents: 8, topCategories: 8, hotspots: true });
      await writeFile(path, JSON.stringify({ findings, digest }));
      const r = await run([], { input: path, 'severity-threshold': 'medium', format: 'json' });
      const out = JSON.parse(r.stdout);
      // critical + medium pass; low + nit dropped.
      expect(out.fresh.total).toBe(2);
      expect(out.fresh.totalsBySeverity.critical).toBe(1);
      expect(out.fresh.totalsBySeverity.medium).toBe(1);
      expect(out.fresh.totalsBySeverity.low).toBe(0);
      expect(out.fresh.totalsBySeverity.nit).toBe(0);
      expect(out.severityThreshold).toBe('medium');
      expect(out.minConfidence).toBeNull();
    });

    it('--min-confidence + --severity-threshold compose (AND)', async () => {
      const dir = await tmpDir();
      const path = join(dir, 'review.json');
      const findings = mixed();
      const digest = findingDigest(findings as never, { topAgents: 8, topCategories: 8, hotspots: true });
      await writeFile(path, JSON.stringify({ findings, digest }));
      const r = await run([], {
        input: path,
        'min-confidence': '0.5',
        'severity-threshold': 'high',
        format: 'json',
      });
      const out = JSON.parse(r.stdout);
      // Only critical@0.9 clears BOTH floors.
      expect(out.fresh.total).toBe(1);
      expect(out.fresh.totalsBySeverity.critical).toBe(1);
      // Echoes both.
      expect(out.minConfidence).toBe(0.5);
      expect(out.severityThreshold).toBe('high');
    });

    it('echoes null for both filters when neither flag is supplied (back-compat)', async () => {
      const dir = await tmpDir();
      const path = join(dir, 'review.json');
      const findings = mixed();
      const digest = findingDigest(findings as never, { topAgents: 8, topCategories: 8, hotspots: true });
      await writeFile(path, JSON.stringify({ findings, digest }));
      const r = await run([], { input: path, format: 'json' });
      const out = JSON.parse(r.stdout);
      expect(out.minConfidence).toBeNull();
      expect(out.severityThreshold).toBeNull();
      // All four findings counted on fresh (no filter).
      expect(out.fresh.total).toBe(4);
    });

    it('filter requested on /digest input shape (no findings) emits a warning and is ignored', async () => {
      const dir = await tmpDir();
      const path = join(dir, 'digest.json');
      // /digest body: persisted + fresh + no findings.
      const persistedFindings = mixed();
      const freshFindings = mixed().slice(0, 2);
      const persisted = findingDigest(persistedFindings as never, { topAgents: 8, topCategories: 8, hotspots: true });
      const fresh = findingDigest(freshFindings as never, { topAgents: 8, topCategories: 8, hotspots: true });
      await writeFile(path, JSON.stringify({ reviewId: 'rv_digest', persisted, fresh }));
      const r = await run([], { input: path, 'min-confidence': '0.7', format: 'json' });
      // Warning surfaces on stderr.
      expect(r.stderr).toContain('--min-confidence / --severity-threshold');
      expect(r.stderr).toContain('requires the /api/reviews/:id input shape');
      // Fresh is unfiltered (the original 2).
      const out = JSON.parse(r.stdout);
      expect(out.fresh.total).toBe(2);
      // Echo carries the raw operator value (so a CI gate can detect
      // that they meant to pass it but couldn't).
      expect(out.minConfidence).toBe(0.7);
    });
  });
});

describe('clawreview review drift --watch (tick 15)', () => {
  /**
   * Drives the watch loop with a stub fetcher + sleeper so the test
   * doesn't depend on the network and doesn't wait for real intervals.
   * Returns the captured stdout/stderr and the resolved exit code.
   */
  async function runWatch(
    reviewId: string,
    flags: Record<string, string | boolean>,
    bodies: Array<string | { ok: boolean; status: number; body: string }>,
  ): Promise<RunResult & { fetchCalls: string[] }> {
    const { runReviewDriftWatch } = await import('../src/commands/review.js');
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
    const fetchCalls: string[] = [];
    let bodyIdx = 0;
    const fetcher = async (url: string) => {
      fetchCalls.push(url);
      const entry = bodies[bodyIdx] ?? bodies[bodies.length - 1]!;
      bodyIdx += 1;
      if (typeof entry === 'string') {
        return { ok: true, status: 200, text: async () => entry };
      }
      return { ok: entry.ok, status: entry.status, text: async () => entry.body };
    };
    // No-op sleeper so the loop doesn't wait between samples.
    const sleeper = async () => undefined;
    process.exitCode = 0;
    try {
      await runReviewDriftWatch(
        {
          command: 'review',
          positional: ['drift'],
          flags: { 'no-color': true, watch: reviewId, ...flags },
        },
        reviewId,
        { fetcher, sleeper },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code, fetchCalls };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects when --server is missing', async () => {
    const r = await runWatch('abc123', {}, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--server');
    expect(r.stderr).toContain('--watch');
    // Never tried to fetch anything.
    expect(r.fetchCalls).toEqual([]);
  });

  it('rejects an invalid --interval (below WATCH_MIN_INTERVAL_MS)', async () => {
    const r = await runWatch('abc123', {
      server: 'https://test.local',
      interval: '50',
    }, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--interval');
    expect(r.stderr).toMatch(/>= 250/);
  });

  it('rejects an invalid --max-polls (negative integer)', async () => {
    const r = await runWatch('abc123', {
      server: 'https://test.local',
      'max-polls': '-1',
    }, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--max-polls');
  });

  it('rejects an invalid --format (only text/json accepted)', async () => {
    const r = await runWatch('abc123', {
      server: 'https://test.local',
      format: 'sarif',
    }, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--format');
  });

  it('polls --max-polls times then exits with exit-3 when last sample has drift', async () => {
    const dummyFresh = findingDigest([{
      agent: 'security', category: 'security', severity: 'high', title: 'X',
      rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: [],
    } as never], { topAgents: 8, topCategories: 8, hotspots: true });
    // No-drift body for first 2 polls, drift body for the 3rd.
    const sameAsFresh = JSON.stringify({
      reviewId: 'abc', persisted: dummyFresh, fresh: dummyFresh,
      drift: { totalDelta: 0, bySeverityDelta: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
        byAgentDelta: {}, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {}, hasDrift: false },
    });
    const drifted = JSON.stringify({
      reviewId: 'abc', persisted: dummyFresh, fresh: dummyFresh,
      drift: { totalDelta: 1, bySeverityDelta: { critical: 0, high: 1, medium: 0, low: 0, nit: 0 },
        byAgentDelta: { security: 1 }, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {}, hasDrift: true },
    });
    const r = await runWatch('abc', {
      server: 'https://test.local',
      'max-polls': '3',
      format: 'json',
    }, [sameAsFresh, sameAsFresh, drifted]);
    // Exit code reflects the FINAL sample (drift -> exit 3).
    expect(r.exitCode).toBe(3);
    expect(r.fetchCalls).toHaveLength(3);
    expect(r.fetchCalls[0]).toBe('https://test.local/api/reviews/abc/digest');
    // JSONL: three newline-delimited JSON objects.
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
    const last = JSON.parse(lines[2]!);
    expect(last.poll).toBe(3);
    expect(last.drift.hasDrift).toBe(true);
  });

  it('exits 0 when --max-polls reached and last sample has no drift', async () => {
    const dummyFresh = findingDigest([], { hotspots: false });
    const noDrift = JSON.stringify({
      reviewId: 'abc', persisted: dummyFresh, fresh: dummyFresh,
      drift: { totalDelta: 0, bySeverityDelta: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
        byAgentDelta: {}, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {}, hasDrift: false },
    });
    const r = await runWatch('abc', {
      server: 'https://test.local',
      'max-polls': '2',
      format: 'json',
    }, [noDrift, noDrift]);
    expect(r.exitCode).toBe(0);
    expect(r.fetchCalls).toHaveLength(2);
  });

  it('aborts with exit 2 on HTTP error response', async () => {
    const r = await runWatch('abc', {
      server: 'https://test.local',
      'max-polls': '5',
    }, [{ ok: false, status: 503, body: 'service unavailable' }]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('HTTP 503');
    // Only one fetch attempted; loop aborted on first failure.
    expect(r.fetchCalls).toHaveLength(1);
  });

  it('aborts with exit 2 on invalid JSON body', async () => {
    const r = await runWatch('abc', {
      server: 'https://test.local',
      'max-polls': '5',
    }, ['not-json']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('failed:');
  });

  it('normalises trailing slashes on --server', async () => {
    const dummyFresh = findingDigest([], { hotspots: false });
    const body = JSON.stringify({
      reviewId: 'abc', persisted: dummyFresh, fresh: dummyFresh,
      drift: { totalDelta: 0, bySeverityDelta: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
        byAgentDelta: {}, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {}, hasDrift: false },
    });
    const r = await runWatch('abc', {
      server: 'https://test.local///',
      'max-polls': '1',
      format: 'json',
    }, [body]);
    expect(r.exitCode).toBe(0);
    // Trailing slashes stripped; one clean slash separator.
    expect(r.fetchCalls[0]).toBe('https://test.local/api/reviews/abc/digest');
  });

  it('text mode prints poll header between samples', async () => {
    const dummyFresh = findingDigest([], { hotspots: false });
    const body = JSON.stringify({
      reviewId: 'abc', persisted: dummyFresh, fresh: dummyFresh,
      drift: { totalDelta: 0, bySeverityDelta: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
        byAgentDelta: {}, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {}, hasDrift: false },
    });
    const r = await runWatch('abc', {
      server: 'https://test.local',
      'max-polls': '2',
      format: 'text',
    }, [body, body]);
    expect(r.exitCode).toBe(0);
    // Two `--- poll N at <iso> ---` separator headers.
    const matches = r.stdout.match(/--- poll \d+ at /g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
    expect(r.stdout).toContain('--- poll 1 at ');
    expect(r.stdout).toContain('--- poll 2 at ');
  });

  it('parseWatchConfig: defaults + validation contract', async () => {
    // Pure unit-test surface so the parser shapes are independently
    // pinned; the integration tests above exercise the loop.
    const { parseWatchConfig, WATCH_DEFAULT_INTERVAL_MS } = await import('../src/commands/review.js');

    // Happy path: all defaults except server.
    const ok = parseWatchConfig({ server: 'https://test.local' });
    expect(ok.kind).toBe('ok');
    if (ok.kind === 'ok') {
      expect(ok.serverUrl).toBe('https://test.local');
      expect(ok.intervalMs).toBe(WATCH_DEFAULT_INTERVAL_MS);
      expect(ok.maxPolls).toBe(0);
      expect(ok.format).toBe('text');
      // Tick 16: new defaults for the on-drift hook fields.
      expect(ok.onDrift).toBeNull();
      expect(ok.onDriftOnce).toBe(false);
    }

    // Missing server.
    expect(parseWatchConfig({}).kind).toBe('missing-server');
    expect(parseWatchConfig({ server: '   ' }).kind).toBe('missing-server');

    // Invalid interval / max-polls / format sentinels.
    expect(parseWatchConfig({ server: 'x', interval: '100' }).kind).toBe('invalid-interval');
    expect(parseWatchConfig({ server: 'x', interval: 'abc' }).kind).toBe('invalid-interval');
    expect(parseWatchConfig({ server: 'x', 'max-polls': '-1' }).kind).toBe('invalid-max-polls');
    expect(parseWatchConfig({ server: 'x', 'max-polls': '1.5' }).kind).toBe('invalid-max-polls');
    expect(parseWatchConfig({ server: 'x', format: 'sarif' }).kind).toBe('invalid-format');
  });
});

describe('clawreview review drift --watch --on-drift (tick 16)', () => {
  /**
   * Like `runWatch` but also injects an on-drift hook executor stub
   * that records (cmd, payload) pairs so a test can assert on the
   * hook's invocation pattern without spawning a real subprocess.
   */
  async function runWatchWithHook(
    reviewId: string,
    flags: Record<string, string | boolean>,
    bodies: Array<string | { ok: boolean; status: number; body: string }>,
    hookOutcome: { exitCode: number | null; stderr: string } = { exitCode: 0, stderr: '' },
  ): Promise<RunResult & { fetchCalls: string[]; hookCalls: Array<{ cmd: string; payload: string }> }> {
    const { runReviewDriftWatch } = await import('../src/commands/review.js');
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
    const fetchCalls: string[] = [];
    const hookCalls: Array<{ cmd: string; payload: string }> = [];
    let bodyIdx = 0;
    const fetcher = async (url: string) => {
      fetchCalls.push(url);
      const entry = bodies[bodyIdx] ?? bodies[bodies.length - 1]!;
      bodyIdx += 1;
      if (typeof entry === 'string') {
        return { ok: true, status: 200, text: async () => entry };
      }
      return { ok: entry.ok, status: entry.status, text: async () => entry.body };
    };
    const sleeper = async () => undefined;
    const onDriftExecer = async (cmd: string, payload: string) => {
      hookCalls.push({ cmd, payload });
      return hookOutcome;
    };
    process.exitCode = 0;
    try {
      await runReviewDriftWatch(
        {
          command: 'review',
          positional: ['drift'],
          flags: { 'no-color': true, watch: reviewId, ...flags },
        },
        reviewId,
        { fetcher, sleeper, onDriftExecer },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code, fetchCalls, hookCalls };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDriftedBody() {
    const dummy = findingDigest([{
      agent: 'security', category: 'security', severity: 'high', title: 'X',
      rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: [],
    } as never], { topAgents: 8, topCategories: 8, hotspots: true });
    return JSON.stringify({
      reviewId: 'abc', persisted: dummy, fresh: dummy,
      drift: { totalDelta: 1, bySeverityDelta: { critical: 0, high: 1, medium: 0, low: 0, nit: 0 },
        byAgentDelta: { security: 1 }, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {}, hasDrift: true },
    });
  }

  function makeCleanBody() {
    const dummy = findingDigest([], { hotspots: false });
    return JSON.stringify({
      reviewId: 'abc', persisted: dummy, fresh: dummy,
      drift: { totalDelta: 0, bySeverityDelta: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
        byAgentDelta: {}, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {}, hasDrift: false },
    });
  }

  it('fires the hook on every drift sample by default', async () => {
    const drift = makeDriftedBody();
    const r = await runWatchWithHook('abc', {
      server: 'https://test.local',
      'max-polls': '3',
      format: 'json',
      'on-drift': 'echo hi',
    }, [drift, drift, drift]);
    expect(r.exitCode).toBe(3);
    expect(r.hookCalls).toHaveLength(3);
    expect(r.hookCalls[0]!.cmd).toBe('echo hi');
    // Payload is the same JSONL shape the --format json output emits.
    const parsed = JSON.parse(r.hookCalls[0]!.payload);
    expect(parsed.reviewId).toBe('abc');
    expect(parsed.poll).toBe(1);
    expect(parsed.drift.hasDrift).toBe(true);
  });

  it('does NOT fire the hook on no-drift samples', async () => {
    const clean = makeCleanBody();
    const r = await runWatchWithHook('abc', {
      server: 'https://test.local',
      'max-polls': '2',
      format: 'json',
      'on-drift': 'curl -X POST https://alerts',
    }, [clean, clean]);
    expect(r.exitCode).toBe(0);
    expect(r.hookCalls).toHaveLength(0);
  });

  it('--on-drift-once fires only on the first drift sample', async () => {
    const drift = makeDriftedBody();
    const clean = makeCleanBody();
    // Sequence: drift, drift, clean, drift -- only the first drift
    // should fire the hook even though three samples drifted.
    const r = await runWatchWithHook('abc', {
      server: 'https://test.local',
      'max-polls': '4',
      format: 'json',
      'on-drift': 'echo alert',
      'on-drift-once': true,
    }, [drift, drift, clean, drift]);
    expect(r.exitCode).toBe(3); // final sample drifted
    expect(r.hookCalls).toHaveLength(1);
    expect(r.hookCalls[0]!.cmd).toBe('echo alert');
    // The first fire is on poll 1 (the first drift sample).
    const parsed = JSON.parse(r.hookCalls[0]!.payload);
    expect(parsed.poll).toBe(1);
  });

  it('--on-drift-once still fires once even if the first sample is clean', async () => {
    const drift = makeDriftedBody();
    const clean = makeCleanBody();
    const r = await runWatchWithHook('abc', {
      server: 'https://test.local',
      'max-polls': '3',
      format: 'json',
      'on-drift': 'echo first-drift',
      'on-drift-once': true,
    }, [clean, drift, drift]);
    expect(r.exitCode).toBe(3);
    expect(r.hookCalls).toHaveLength(1);
    // The fire is on poll 2 (the FIRST drift sample, not poll 1 which was clean).
    const parsed = JSON.parse(r.hookCalls[0]!.payload);
    expect(parsed.poll).toBe(2);
  });

  it('surfaces hook failure on stderr but keeps polling', async () => {
    const drift = makeDriftedBody();
    const r = await runWatchWithHook('abc', {
      server: 'https://test.local',
      'max-polls': '2',
      format: 'json',
      'on-drift': 'false',
    }, [drift, drift], { exitCode: 1, stderr: 'boom' });
    // Watch loop still completes both polls -- hook failures don't
    // abort the loop (the polls themselves are still useful).
    expect(r.exitCode).toBe(3);
    expect(r.hookCalls).toHaveLength(2);
    // Stderr surfaces both failures inline so an operator sees them
    // rather than discovering hours later that no alerts went out.
    expect(r.stderr).toContain('on-drift hook exited 1');
    expect(r.stderr).toContain('boom');
  });

  it('rejects an empty --on-drift (typo guard)', async () => {
    const r = await runWatchWithHook('abc', {
      server: 'https://test.local',
      'on-drift': '   ',
    }, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--on-drift');
    // Never tried to fetch -- failed in config parse.
    expect(r.fetchCalls).toEqual([]);
  });

  it('parseWatchConfig surfaces invalid-on-drift sentinel for whitespace', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({ server: 'https://test.local', 'on-drift': '   ' });
    expect(r.kind).toBe('invalid-on-drift');
  });

  it('parseWatchConfig accepts a non-empty --on-drift and sets onDriftOnce default false', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({
      server: 'https://test.local',
      'on-drift': 'curl https://x',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.onDrift).toBe('curl https://x');
      expect(r.onDriftOnce).toBe(false);
    }
  });
});

describe('clawreview review drift --watch metrics (tick 17)', () => {
  /**
   * Spin up a real metrics bundle from @clawreview/telemetry (it's a
   * lightweight Prometheus client; the registry is per-bundle and we
   * pass defaultMetrics=false to keep the scrape body small). Each
   * test gets a fresh bundle via resetMetricsForTests so the counter
   * starts at zero.
   *
   * The watch loop's `injected.metrics` seam accepts any MetricsBundle
   * -- we pass the real one and scrape the registry text to assert
   * the closed-set {ok, drift, error} labels actually fired.
   */
  async function runWatchWithMetrics(
    reviewId: string,
    flags: Record<string, string | boolean>,
    bodies: Array<string | { ok: boolean; status: number; body: string }>,
  ): Promise<{ exitCode: number; metricsText: string }> {
    const { runReviewDriftWatch } = await import('../src/commands/review.js');
    const { getMetrics, resetMetricsForTests } = await import('@clawreview/telemetry');
    resetMetricsForTests();
    const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
    // Silence stdout/stderr -- they're not under test in this group.
    const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation(((_: unknown) => true) as never);
    const writeStderr = vi.spyOn(process.stderr, 'write').mockImplementation(((_: unknown) => true) as never);
    let bodyIdx = 0;
    const fetcher = async (_url: string) => {
      const entry = bodies[bodyIdx] ?? bodies[bodies.length - 1]!;
      bodyIdx += 1;
      if (typeof entry === 'string') return { ok: true, status: 200, text: async () => entry };
      return { ok: entry.ok, status: entry.status, text: async () => entry.body };
    };
    const sleeper = async () => undefined;
    process.exitCode = 0;
    try {
      await runReviewDriftWatch(
        {
          command: 'review',
          positional: ['drift'],
          flags: { 'no-color': true, watch: reviewId, ...flags },
        },
        reviewId,
        { fetcher, sleeper, metrics },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    const metricsText = await metrics.registry.metrics();
    return { exitCode, metricsText };
  }

  function makeCleanBody() {
    const findings = [{
      agent: 'security', category: 'security', severity: 'high', title: 'X',
      rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: [],
    }];
    const digest = findingDigest(findings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    return JSON.stringify({ findings, digest });
  }

  function makeDriftedBody() {
    const persistedFindings = [
      { agent: 'security', category: 'security', severity: 'high', title: 'X', rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: [] },
      { agent: 'security', category: 'security', severity: 'medium', title: 'Y', rationale: 'r', file: 'b.ts', startLine: 2, confidence: 0.8, tags: [] },
    ];
    const liveFindings = [persistedFindings[0]!];
    const digest = findingDigest(persistedFindings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    return JSON.stringify({ findings: liveFindings, digest });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires the ok label on a clean poll (drift.hasDrift=false)', async () => {
    const r = await runWatchWithMetrics('rv1', { 'max-polls': '1', server: 'https://t' }, [makeCleanBody()]);
    expect(r.exitCode).toBe(0);
    expect(r.metricsText).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="ok"[^}]*\}\s*1/);
  });

  it('fires the drift label on a polled drift sample', async () => {
    const r = await runWatchWithMetrics('rv2', { 'max-polls': '1', server: 'https://t' }, [makeDriftedBody()]);
    // Drifted last sample -> exit 3 (single-shot contract carries up).
    expect(r.exitCode).toBe(3);
    expect(r.metricsText).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="drift"[^}]*\}\s*1/);
  });

  it('fires the error label on an HTTP non-2xx response', async () => {
    const r = await runWatchWithMetrics(
      'rv3',
      { 'max-polls': '5', server: 'https://t' },
      [{ ok: false, status: 503, body: '{"error":"down"}' }],
    );
    // HTTP error path exits 2 immediately after the counter fires.
    expect(r.exitCode).toBe(2);
    expect(r.metricsText).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="error"[^}]*\}\s*1/);
  });

  it('fires the error label on a JSON parse failure', async () => {
    const r = await runWatchWithMetrics(
      'rv4',
      { 'max-polls': '5', server: 'https://t' },
      ['this is not JSON {'],
    );
    expect(r.exitCode).toBe(2);
    expect(r.metricsText).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="error"[^}]*\}\s*1/);
  });

  it('fires the error label on a body missing both fresh and findings', async () => {
    const r = await runWatchWithMetrics(
      'rv5',
      { 'max-polls': '5', server: 'https://t' },
      ['{}'],
    );
    expect(r.exitCode).toBe(2);
    expect(r.metricsText).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="error"[^}]*\}\s*1/);
  });

  it('counts each poll separately across a mixed multi-poll watch', async () => {
    // Two clean samples followed by a drifted sample. We expect 2 ok
    // + 1 drift on the counter; no spillover to error.
    const r = await runWatchWithMetrics(
      'rv6',
      { 'max-polls': '3', server: 'https://t' },
      [makeCleanBody(), makeCleanBody(), makeDriftedBody()],
    );
    expect(r.exitCode).toBe(3);
    expect(r.metricsText).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="ok"[^}]*\}\s*2/);
    expect(r.metricsText).toMatch(/clawreview_review_drift_watch_polls_total\{[^}]*result="drift"[^}]*\}\s*1/);
  });

  it('omits the counter entirely when metrics is not injected (default surface)', async () => {
    // The metric is opt-in; without an injected bundle the loop must
    // run cleanly without throwing. We assert via the exit code alone
    // because there's no bundle to scrape.
    const { runReviewDriftWatch } = await import('../src/commands/review.js');
    const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation(((_: unknown) => true) as never);
    const writeStderr = vi.spyOn(process.stderr, 'write').mockImplementation(((_: unknown) => true) as never);
    process.exitCode = 0;
    try {
      await runReviewDriftWatch(
        {
          command: 'review',
          positional: ['drift'],
          flags: { 'no-color': true, watch: 'rv7', server: 'https://t', 'max-polls': '1' },
        },
        'rv7',
        {
          fetcher: async () => ({ ok: true, status: 200, text: async () => makeCleanBody() }),
          sleeper: async () => undefined,
        },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    expect(exitCode).toBe(0);
  });
});

describe('expandOnDriftTemplate (tick 17)', () => {
  it('expands slack to a curl command targeting SLACK_WEBHOOK_URL', async () => {
    const { expandOnDriftTemplate } = await import('../src/commands/review.js');
    const r = expandOnDriftTemplate('slack', { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.command).toContain('curl');
      expect(r.command).toContain('POST');
      expect(r.command).toContain('https://hooks.slack.com/services/T/B/X');
      expect(r.command).toContain("Content-Type: application/json");
      // --data-binary @- forwards stdin verbatim, matching the
      // watch loop's existing pipe contract.
      expect(r.command).toContain('--data-binary @-');
    }
  });

  it('expands webhook to a curl command targeting WEBHOOK_URL', async () => {
    const { expandOnDriftTemplate } = await import('../src/commands/review.js');
    const r = expandOnDriftTemplate('webhook', { WEBHOOK_URL: 'https://example.com/hook' });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.command).toContain('https://example.com/hook');
    }
  });

  it('case-insensitive matching for the template name (Slack vs slack)', async () => {
    const { expandOnDriftTemplate } = await import('../src/commands/review.js');
    const a = expandOnDriftTemplate('SLACK', { SLACK_WEBHOOK_URL: 'https://a' });
    const b = expandOnDriftTemplate('Slack', { SLACK_WEBHOOK_URL: 'https://a' });
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    if (a.kind === 'ok' && b.kind === 'ok') {
      expect(a.command).toBe(b.command);
    }
  });

  it('rejects an unknown template with an enumerated valid list', async () => {
    const { expandOnDriftTemplate } = await import('../src/commands/review.js');
    const r = expandOnDriftTemplate('teams', { TEAMS_WEBHOOK_URL: 'https://x' });
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.message).toContain("'teams'");
      // Lists the canonical valid names so the operator can pick.
      expect(r.message).toContain('slack');
      expect(r.message).toContain('webhook');
    }
  });

  it('rejects when slack template is selected but SLACK_WEBHOOK_URL is unset', async () => {
    const { expandOnDriftTemplate } = await import('../src/commands/review.js');
    // Empty env: parse-time error so the watch loop never silently
    // misfires curl with $EMPTY_VAR.
    const r = expandOnDriftTemplate('slack', {});
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.message).toContain('SLACK_WEBHOOK_URL');
    }
  });

  it('rejects when SLACK_WEBHOOK_URL is set but whitespace-only', async () => {
    const { expandOnDriftTemplate } = await import('../src/commands/review.js');
    // Operators sometimes export an empty string via shell typos;
    // we should treat that identically to unset.
    const r = expandOnDriftTemplate('slack', { SLACK_WEBHOOK_URL: '   ' });
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.message).toContain('SLACK_WEBHOOK_URL');
    }
  });

  it('ON_DRIFT_TEMPLATES exports the closed two-name set', async () => {
    const { ON_DRIFT_TEMPLATES } = await import('../src/commands/review.js');
    expect([...ON_DRIFT_TEMPLATES]).toEqual(['slack', 'webhook']);
  });
});

describe('parseWatchConfig --on-drift-template (tick 17)', () => {
  it('expands --on-drift-template slack into the curl command when SLACK_WEBHOOK_URL is set', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const prev = process.env.SLACK_WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/x';
    try {
      const r = parseWatchConfig({
        server: 'https://t',
        'on-drift-template': 'slack',
      });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.onDrift).toContain('https://hooks.slack.com/x');
        expect(r.onDrift).toContain('curl');
      }
    } finally {
      if (prev === undefined) delete process.env.SLACK_WEBHOOK_URL;
      else process.env.SLACK_WEBHOOK_URL = prev;
    }
  });

  it('--on-drift-template and --on-drift together rejects (mutex)', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({
      server: 'https://t',
      'on-drift': 'curl https://x',
      'on-drift-template': 'slack',
    });
    expect(r.kind).toBe('invalid-on-drift');
    if (r.kind === 'invalid-on-drift') {
      expect(r.message).toContain('mutually exclusive');
    }
  });

  it('--on-drift-template with an empty value rejects with a clear message', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({
      server: 'https://t',
      'on-drift-template': '',
    });
    expect(r.kind).toBe('invalid-on-drift');
    if (r.kind === 'invalid-on-drift') {
      expect(r.message).toContain('requires a template name');
    }
  });

  it('--on-drift-template with an unknown name rejects with the valid list', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({
      server: 'https://t',
      'on-drift-template': 'teams',
    });
    expect(r.kind).toBe('invalid-on-drift');
    if (r.kind === 'invalid-on-drift') {
      expect(r.message).toContain("'teams'");
      expect(r.message).toContain('slack');
    }
  });

  it('--on-drift-template slack with missing env var surfaces at parse-time', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const prev = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      const r = parseWatchConfig({
        server: 'https://t',
        'on-drift-template': 'slack',
      });
      expect(r.kind).toBe('invalid-on-drift');
      if (r.kind === 'invalid-on-drift') {
        expect(r.message).toContain('SLACK_WEBHOOK_URL');
      }
    } finally {
      if (prev !== undefined) process.env.SLACK_WEBHOOK_URL = prev;
    }
  });

  it('--on-drift-template composes with --on-drift-once', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const prev = process.env.WEBHOOK_URL;
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    try {
      const r = parseWatchConfig({
        server: 'https://t',
        'on-drift-template': 'webhook',
        'on-drift-once': true,
      });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.onDrift).toContain('https://example.com/hook');
        expect(r.onDriftOnce).toBe(true);
      }
    } finally {
      if (prev === undefined) delete process.env.WEBHOOK_URL;
      else process.env.WEBHOOK_URL = prev;
    }
  });
});

describe('clawreview review drift --watch --on-recover (tick 18)', () => {
  /**
   * Like `runWatchWithHook` but the injected exec stub serves BOTH
   * --on-drift and --on-recover so a single test can assert on the
   * recover-edge contract: the hook fires on the FIRST clean sample
   * after a drift sample, not on subsequent clean samples.
   *
   * Each entry in `bodies` is fed sequentially to the fake fetcher;
   * the test asserts on the order of `cmd` (the hook command) so
   * --on-drift and --on-recover can be distinguished even though
   * both arms route through the same execer.
   */
  async function runWatchWithRecoverHook(
    reviewId: string,
    flags: Record<string, string | boolean>,
    bodies: Array<string>,
    hookOutcome: { exitCode: number | null; stderr: string } = { exitCode: 0, stderr: '' },
  ): Promise<RunResult & { hookCalls: Array<{ cmd: string; payload: string }> }> {
    const { runReviewDriftWatch } = await import('../src/commands/review.js');
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
    const hookCalls: Array<{ cmd: string; payload: string }> = [];
    let bodyIdx = 0;
    const fetcher = async (_url: string) => {
      const entry = bodies[bodyIdx] ?? bodies[bodies.length - 1]!;
      bodyIdx += 1;
      return { ok: true, status: 200, text: async () => entry };
    };
    const sleeper = async () => undefined;
    const onDriftExecer = async (cmd: string, payload: string) => {
      hookCalls.push({ cmd, payload });
      return hookOutcome;
    };
    process.exitCode = 0;
    try {
      await runReviewDriftWatch(
        {
          command: 'review',
          positional: ['drift'],
          flags: { 'no-color': true, watch: reviewId, ...flags },
        },
        reviewId,
        { fetcher, sleeper, onDriftExecer },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code, hookCalls };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDriftedBody() {
    const dummy = findingDigest([{
      agent: 'security', category: 'security', severity: 'high', title: 'X',
      rationale: 'r', file: 'a.ts', startLine: 1, confidence: 0.8, tags: [],
    } as never], { topAgents: 8, topCategories: 8, hotspots: true });
    return JSON.stringify({
      reviewId: 'abc', persisted: dummy, fresh: dummy,
      drift: { totalDelta: 1, bySeverityDelta: { critical: 0, high: 1, medium: 0, low: 0, nit: 0 },
        byAgentDelta: { security: 1 }, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {}, hasDrift: true },
    });
  }

  function makeCleanBody() {
    const dummy = findingDigest([], { hotspots: false });
    return JSON.stringify({
      reviewId: 'abc', persisted: dummy, fresh: dummy,
      drift: { totalDelta: 0, bySeverityDelta: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
        byAgentDelta: {}, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {}, hasDrift: false },
    });
  }

  it('fires --on-recover on the drift->clean transition', async () => {
    const drift = makeDriftedBody();
    const clean = makeCleanBody();
    // Sequence: drift, clean -- one recover edge at poll 2.
    const r = await runWatchWithRecoverHook('abc', {
      server: 'https://test.local',
      'max-polls': '2',
      format: 'json',
      'on-recover': 'echo cleared',
    }, [drift, clean]);
    expect(r.exitCode).toBe(0);
    expect(r.hookCalls).toHaveLength(1);
    expect(r.hookCalls[0]!.cmd).toBe('echo cleared');
    // The fire happens on poll 2 (the FIRST clean sample after drift).
    const parsed = JSON.parse(r.hookCalls[0]!.payload);
    expect(parsed.poll).toBe(2);
    expect(parsed.drift.hasDrift).toBe(false);
  });

  it('does NOT fire --on-recover on the first clean sample if there was no prior drift', async () => {
    const clean = makeCleanBody();
    // Sequence: clean, clean -- no drift at any point, so recover
    // semantics never apply.
    const r = await runWatchWithRecoverHook('abc', {
      server: 'https://test.local',
      'max-polls': '2',
      format: 'json',
      'on-recover': 'echo cleared',
    }, [clean, clean]);
    expect(r.exitCode).toBe(0);
    expect(r.hookCalls).toHaveLength(0);
  });

  it('does NOT re-fire --on-recover on subsequent clean samples (one fire per drift->clean edge)', async () => {
    const drift = makeDriftedBody();
    const clean = makeCleanBody();
    // Sequence: drift, clean, clean -- one recover edge at poll 2.
    // Poll 3 is also clean but the edge already fired; no re-fire.
    const r = await runWatchWithRecoverHook('abc', {
      server: 'https://test.local',
      'max-polls': '3',
      format: 'json',
      'on-recover': 'echo cleared',
    }, [drift, clean, clean]);
    expect(r.exitCode).toBe(0);
    expect(r.hookCalls).toHaveLength(1);
    const parsed = JSON.parse(r.hookCalls[0]!.payload);
    expect(parsed.poll).toBe(2);
  });

  it('re-fires --on-recover on each drift->clean transition (flapping)', async () => {
    const drift = makeDriftedBody();
    const clean = makeCleanBody();
    // Sequence: drift, clean, drift, clean -- TWO recover edges
    // (poll 2 and poll 4). Both should fire because each is an
    // independent drift->clean transition.
    const r = await runWatchWithRecoverHook('abc', {
      server: 'https://test.local',
      'max-polls': '4',
      format: 'json',
      'on-recover': 'echo cleared',
    }, [drift, clean, drift, clean]);
    expect(r.exitCode).toBe(0); // final sample is clean
    expect(r.hookCalls).toHaveLength(2);
    expect(JSON.parse(r.hookCalls[0]!.payload).poll).toBe(2);
    expect(JSON.parse(r.hookCalls[1]!.payload).poll).toBe(4);
  });

  it('--on-drift + --on-recover compose: both hooks fire on their respective edges', async () => {
    const drift = makeDriftedBody();
    const clean = makeCleanBody();
    // Sequence: clean, drift, clean -- one --on-drift fire at
    // poll 2, one --on-recover fire at poll 3.
    const r = await runWatchWithRecoverHook('abc', {
      server: 'https://test.local',
      'max-polls': '3',
      format: 'json',
      'on-drift': 'echo drifted',
      'on-recover': 'echo cleared',
    }, [clean, drift, clean]);
    expect(r.exitCode).toBe(0);
    expect(r.hookCalls).toHaveLength(2);
    // Order is: drift hook at poll 2, recover hook at poll 3.
    expect(r.hookCalls[0]!.cmd).toBe('echo drifted');
    expect(JSON.parse(r.hookCalls[0]!.payload).poll).toBe(2);
    expect(r.hookCalls[1]!.cmd).toBe('echo cleared');
    expect(JSON.parse(r.hookCalls[1]!.payload).poll).toBe(3);
  });

  it('surfaces --on-recover hook failure on stderr but keeps polling', async () => {
    const drift = makeDriftedBody();
    const clean = makeCleanBody();
    const r = await runWatchWithRecoverHook('abc', {
      server: 'https://test.local',
      'max-polls': '2',
      format: 'json',
      'on-recover': 'false',
    }, [drift, clean], { exitCode: 1, stderr: 'boom' });
    expect(r.exitCode).toBe(0);
    expect(r.hookCalls).toHaveLength(1);
    // Stderr surfaces the failure inline so an operator sees it.
    expect(r.stderr).toContain('on-recover hook exited 1');
    expect(r.stderr).toContain('boom');
  });

  it('rejects an empty --on-recover (typo guard)', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({
      server: 'https://test.local',
      'on-recover': '   ',
    });
    expect(r.kind).toBe('invalid-on-recover');
  });

  it('parseWatchConfig accepts a non-empty --on-recover and exposes it on `ok`', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({
      server: 'https://test.local',
      'on-recover': 'curl -X POST https://alerts/cleared',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.onRecover).toBe('curl -X POST https://alerts/cleared');
      // Defaults stay intact.
      expect(r.onDrift).toBeNull();
    }
  });

  it('parseWatchConfig default onRecover is null when --on-recover absent', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({ server: 'https://test.local' });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.onRecover).toBeNull();
    }
  });
});

describe('expandOnRecoverTemplate (tick 19)', () => {
  it('expands slack template to a curl POST against $SLACK_RECOVER_WEBHOOK_URL when set', async () => {
    const { expandOnRecoverTemplate } = await import('../src/commands/review.js');
    const r = expandOnRecoverTemplate('slack', {
      SLACK_RECOVER_WEBHOOK_URL: 'https://hooks.slack.com/recover',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.command).toContain('https://hooks.slack.com/recover');
      expect(r.command).toContain('curl');
      expect(r.command).toContain('-X POST');
      expect(r.command).toContain('Content-Type: application/json');
      expect(r.command).toContain('--data-binary @-');
    }
  });

  it('falls back to $SLACK_WEBHOOK_URL when the recover-specific var is unset', async () => {
    // Common case: operator has a single Slack channel for both
    // drift and recover. They only set SLACK_WEBHOOK_URL; the
    // recover template still resolves cleanly.
    const { expandOnRecoverTemplate } = await import('../src/commands/review.js');
    const r = expandOnRecoverTemplate('slack', {
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/shared',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.command).toContain('https://hooks.slack.com/shared');
    }
  });

  it('prefers the recover-specific var over the fallback when both are set', async () => {
    // Operator with TWO channels: one for drift, one for recover.
    // Both env vars set; the recover-specific one wins.
    const { expandOnRecoverTemplate } = await import('../src/commands/review.js');
    const r = expandOnRecoverTemplate('slack', {
      SLACK_RECOVER_WEBHOOK_URL: 'https://hooks.slack.com/recover',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/drift',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.command).toContain('https://hooks.slack.com/recover');
      expect(r.command).not.toContain('https://hooks.slack.com/drift');
    }
  });

  it('webhook template uses $WEBHOOK_RECOVER_URL with $WEBHOOK_URL fallback', async () => {
    const { expandOnRecoverTemplate } = await import('../src/commands/review.js');
    const recoverOnly = expandOnRecoverTemplate('webhook', {
      WEBHOOK_URL: 'https://example.com/hook',
    });
    expect(recoverOnly.kind).toBe('ok');
    if (recoverOnly.kind === 'ok') {
      expect(recoverOnly.command).toContain('https://example.com/hook');
    }
    const recoverSpecific = expandOnRecoverTemplate('webhook', {
      WEBHOOK_RECOVER_URL: 'https://example.com/recover',
      WEBHOOK_URL: 'https://example.com/drift',
    });
    if (recoverSpecific.kind === 'ok') {
      expect(recoverSpecific.command).toContain('https://example.com/recover');
    }
  });

  it('rejects unknown template name with the valid list', async () => {
    const { expandOnRecoverTemplate } = await import('../src/commands/review.js');
    const r = expandOnRecoverTemplate('teams', { WEBHOOK_URL: 'https://x' });
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.message).toContain("'teams'");
      expect(r.message).toContain('slack');
      expect(r.message).toContain('webhook');
    }
  });

  it('rejects when neither env var is set with both names in the error', async () => {
    const { expandOnRecoverTemplate } = await import('../src/commands/review.js');
    const r = expandOnRecoverTemplate('slack', {});
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.message).toContain('SLACK_RECOVER_WEBHOOK_URL');
      expect(r.message).toContain('SLACK_WEBHOOK_URL');
      expect(r.message).toContain('fallback');
    }
  });

  it('case-insensitive: SLACK / Slack / slack all resolve the same template', async () => {
    const { expandOnRecoverTemplate } = await import('../src/commands/review.js');
    const a = expandOnRecoverTemplate('SLACK', { SLACK_WEBHOOK_URL: 'https://a' });
    const b = expandOnRecoverTemplate('Slack', { SLACK_WEBHOOK_URL: 'https://a' });
    const c = expandOnRecoverTemplate('slack', { SLACK_WEBHOOK_URL: 'https://a' });
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    expect(c.kind).toBe('ok');
    if (a.kind === 'ok' && b.kind === 'ok' && c.kind === 'ok') {
      expect(a.command).toBe(b.command);
      expect(b.command).toBe(c.command);
    }
  });

  it('treats whitespace-only env vars as unset (falls back / errors as appropriate)', async () => {
    const { expandOnRecoverTemplate } = await import('../src/commands/review.js');
    // Whitespace-only recover var -> fall back to drift var.
    const fallback = expandOnRecoverTemplate('slack', {
      SLACK_RECOVER_WEBHOOK_URL: '   ',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x',
    });
    expect(fallback.kind).toBe('ok');
    if (fallback.kind === 'ok') {
      expect(fallback.command).toContain('https://hooks.slack.com/x');
    }
    // Both whitespace-only -> rejects.
    const reject = expandOnRecoverTemplate('slack', {
      SLACK_RECOVER_WEBHOOK_URL: '   ',
      SLACK_WEBHOOK_URL: '   ',
    });
    expect(reject.kind).toBe('invalid');
  });

  it('ON_RECOVER_TEMPLATES exports the closed two-name set', async () => {
    const { ON_RECOVER_TEMPLATES } = await import('../src/commands/review.js');
    expect([...ON_RECOVER_TEMPLATES]).toEqual(['slack', 'webhook']);
  });
});

describe('parseWatchConfig --on-recover-template (tick 19)', () => {
  it('expands --on-recover-template slack into the curl command when env var is set', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const prev = process.env.SLACK_WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/x';
    try {
      const r = parseWatchConfig({
        server: 'https://t',
        'on-recover-template': 'slack',
      });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.onRecover).toContain('https://hooks.slack.com/x');
        expect(r.onRecover).toContain('curl');
      }
    } finally {
      if (prev === undefined) delete process.env.SLACK_WEBHOOK_URL;
      else process.env.SLACK_WEBHOOK_URL = prev;
    }
  });

  it('--on-recover-template and --on-recover together rejects (mutex)', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({
      server: 'https://t',
      'on-recover': 'curl https://x',
      'on-recover-template': 'slack',
    });
    expect(r.kind).toBe('invalid-on-recover');
    if (r.kind === 'invalid-on-recover') {
      expect(r.message).toContain('mutually exclusive');
    }
  });

  it('--on-recover-template with an empty value rejects with a clear message', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({
      server: 'https://t',
      'on-recover-template': '',
    });
    expect(r.kind).toBe('invalid-on-recover');
    if (r.kind === 'invalid-on-recover') {
      expect(r.message).toContain('requires a template name');
    }
  });

  it('--on-recover-template with an unknown name rejects with the valid list', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const r = parseWatchConfig({
      server: 'https://t',
      'on-recover-template': 'teams',
    });
    expect(r.kind).toBe('invalid-on-recover');
    if (r.kind === 'invalid-on-recover') {
      expect(r.message).toContain("'teams'");
      expect(r.message).toContain('slack');
    }
  });

  it('--on-recover-template slack with no env var set surfaces at parse-time', async () => {
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const prevA = process.env.SLACK_RECOVER_WEBHOOK_URL;
    const prevB = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_RECOVER_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      const r = parseWatchConfig({
        server: 'https://t',
        'on-recover-template': 'slack',
      });
      expect(r.kind).toBe('invalid-on-recover');
      if (r.kind === 'invalid-on-recover') {
        expect(r.message).toContain('SLACK_RECOVER_WEBHOOK_URL');
        expect(r.message).toContain('SLACK_WEBHOOK_URL');
      }
    } finally {
      if (prevA !== undefined) process.env.SLACK_RECOVER_WEBHOOK_URL = prevA;
      if (prevB !== undefined) process.env.SLACK_WEBHOOK_URL = prevB;
    }
  });

  it('--on-recover-template composes with --on-drift (independent edges)', async () => {
    // Operator can wire BOTH edges via templates: drift template
    // fires on drift, recover template fires on recover. The two
    // env-var ladders are independent.
    const { parseWatchConfig } = await import('../src/commands/review.js');
    const prevA = process.env.SLACK_WEBHOOK_URL;
    const prevB = process.env.WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/d';
    process.env.WEBHOOK_URL = 'https://example.com/r';
    try {
      const r = parseWatchConfig({
        server: 'https://t',
        'on-drift-template': 'slack',
        'on-recover-template': 'webhook',
      });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.onDrift).toContain('https://hooks.slack.com/d');
        expect(r.onRecover).toContain('https://example.com/r');
      }
    } finally {
      if (prevA === undefined) delete process.env.SLACK_WEBHOOK_URL;
      else process.env.SLACK_WEBHOOK_URL = prevA;
      if (prevB === undefined) delete process.env.WEBHOOK_URL;
      else process.env.WEBHOOK_URL = prevB;
    }
  });
});

// Tick 22: --base / --target two-review compare. Fetches both
// /api/reviews/:id/digest bodies via injectable fetcher, computes
// drift between their `fresh` digests, exits 3 on drift (mirrors
// single-shot for CI gateability), 0 when they agree, 2 on
// fetch / config / shape failure.
describe('clawreview review drift --base / --target (tick 22)', () => {
  /**
   * Drive the compare command with a stub fetcher so the test
   * doesn't depend on the network. Returns captured stdout/stderr
   * plus the URLs the fetcher was asked to hit (lets us assert
   * the filter-flag forwarding contract).
   */
  async function runCompare(
    baseBody: string | { ok: boolean; status: number; body: string },
    targetBody: string | { ok: boolean; status: number; body: string },
    flags: Record<string, string | boolean> = {},
  ): Promise<RunResult & { fetchCalls: string[] }> {
    const { runReviewDriftCompare } = await import('../src/commands/review.js');
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
    const fetchCalls: string[] = [];
    const baseEntry =
      typeof baseBody === 'string' ? { ok: true, status: 200, body: baseBody } : baseBody;
    const targetEntry =
      typeof targetBody === 'string' ? { ok: true, status: 200, body: targetBody } : targetBody;
    const fetcher = async (url: string) => {
      fetchCalls.push(url);
      // Treat the second URL as the target by URL substring match
      // -- mirrors the real fetch order. The test IDs convention
      // uses 'rv_tgt' / 'rv_base' so we can route on that.
      const entry = url.includes('rv_tgt')
        ? targetEntry
        : baseEntry;
      return { ok: entry.ok, status: entry.status, text: async () => entry.body };
    };
    process.exitCode = 0;
    try {
      await runReviewDriftCompare(
        {
          command: 'review',
          positional: ['drift'],
          flags: { 'no-color': true, ...flags },
        },
        String(flags.base ?? ''),
        String(flags.target ?? ''),
        { fetcher },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return {
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exitCode: code,
      fetchCalls,
    };
  }

  function digestBody(reviewId: string, fresh: ReturnType<typeof findingDigest>) {
    return JSON.stringify({
      reviewId,
      persisted: fresh,
      fresh,
      drift: { hasDrift: false, totalDelta: 0, bySeverityDelta: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 }, byAgentDelta: {}, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {} },
      recompute: 'fresh',
    });
  }

  it('exits 0 + reports "no drift" when base.fresh equals target.fresh', async () => {
    const findings = [f({ severity: 'high', file: 'a.ts' }), f({ severity: 'low', file: 'b.ts' })];
    const dig = findingDigest(findings as never, { topAgents: 8, topCategories: 8, hotspots: true });
    const r = await runCompare(
      digestBody('rv_base', dig),
      digestBody('rv_tgt', dig),
      { server: 'http://localhost', base: 'rv_base', target: 'rv_tgt' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('(no drift: target matches base)');
    // Both URLs were hit (compare always fetches both reviews).
    expect(r.fetchCalls).toHaveLength(2);
    expect(r.fetchCalls[0]).toContain('/api/reviews/rv_base/digest');
    expect(r.fetchCalls[1]).toContain('/api/reviews/rv_tgt/digest');
  });

  it('exits 3 + reports per-severity delta when target has fewer findings (bug fix happy path)', async () => {
    const baseFindings = [
      f({ severity: 'high', file: 'a.ts' }),
      f({ severity: 'high', file: 'b.ts' }),
      f({ severity: 'medium', file: 'c.ts' }),
    ];
    const targetFindings = [
      // bug fix cleared both 'high' findings; medium still there.
      f({ severity: 'medium', file: 'c.ts' }),
    ];
    const baseDig = findingDigest(baseFindings as never, { topAgents: 8, topCategories: 8 });
    const targetDig = findingDigest(targetFindings as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompare(
      digestBody('rv_base', baseDig),
      digestBody('rv_tgt', targetDig),
      { server: 'http://localhost', base: 'rv_base', target: 'rv_tgt' },
    );
    expect(r.exitCode).toBe(3); // drift detected -> CI gate fails
    expect(r.stdout).toContain('base review');
    expect(r.stdout).toContain('target review');
    expect(r.stdout).toContain('high');
    // totalDelta = target - base = 1 - 3 = -2.
    expect(r.stdout).toContain('-2');
  });

  it('--format json emits the structured compare envelope (baseReviewId / targetReviewId / drift)', async () => {
    const baseFindings = [f({ severity: 'high' })];
    const targetFindings = [f({ severity: 'high' }), f({ severity: 'low' })];
    const baseDig = findingDigest(baseFindings as never, { topAgents: 8, topCategories: 8 });
    const targetDig = findingDigest(targetFindings as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompare(
      digestBody('rv_base', baseDig),
      digestBody('rv_tgt', targetDig),
      { server: 'http://localhost', base: 'rv_base', target: 'rv_tgt', format: 'json' },
    );
    expect(r.exitCode).toBe(3);
    const body = JSON.parse(r.stdout);
    expect(body.baseReviewId).toBe('rv_base');
    expect(body.targetReviewId).toBe('rv_tgt');
    expect(body.base.total).toBe(1);
    expect(body.target.total).toBe(2);
    expect(body.drift.hasDrift).toBe(true);
    expect(body.drift.totalDelta).toBe(1); // target +1
    // Filter echoes default to null when flags absent.
    expect(body.minConfidence).toBeNull();
    expect(body.severityThreshold).toBeNull();
  });

  it('forwards --min-confidence / --severity-threshold as query params on BOTH fetches', async () => {
    const findings = [f({ severity: 'high' })];
    const dig = findingDigest(findings as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompare(
      digestBody('rv_base', dig),
      digestBody('rv_tgt', dig),
      {
        server: 'http://localhost',
        base: 'rv_base',
        target: 'rv_tgt',
        'min-confidence': '0.5',
        'severity-threshold': 'medium',
        format: 'json',
      },
    );
    expect(r.exitCode).toBe(0);
    // Both URLs carry the same filter knobs (symmetric application).
    for (const url of r.fetchCalls) {
      expect(url).toContain('minConfidence=0.5');
      expect(url).toContain('severityThreshold=medium');
    }
    const body = JSON.parse(r.stdout);
    expect(body.minConfidence).toBe(0.5);
    expect(body.severityThreshold).toBe('medium');
  });

  it('exits 2 with stderr when --base is missing', async () => {
    const r = await runCompare(
      '{}',
      '{}',
      { server: 'http://localhost', target: 'rv_tgt' }, // no --base
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--base');
  });

  it('exits 2 with stderr when --target is missing', async () => {
    const r = await runCompare(
      '{}',
      '{}',
      { server: 'http://localhost', base: 'rv_base' }, // no --target
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--target');
  });

  it('exits 2 with stderr when --server is missing', async () => {
    const r = await runCompare(
      '{}',
      '{}',
      { base: 'rv_base', target: 'rv_tgt' }, // no --server
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--server');
  });

  it('exits 2 with stderr when base fetch returns non-2xx', async () => {
    const r = await runCompare(
      { ok: false, status: 404, body: '' },
      '{}',
      { server: 'http://localhost', base: 'rv_base', target: 'rv_tgt' },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('HTTP 404');
    expect(r.stderr).toContain('rv_base');
  });

  it('exits 2 with stderr when target body lacks both fresh and findings', async () => {
    const dig = findingDigest([f()], { topAgents: 8 });
    const r = await runCompare(
      digestBody('rv_base', dig),
      JSON.stringify({ reviewId: 'rv_tgt' }), // no fresh, no findings
      { server: 'http://localhost', base: 'rv_base', target: 'rv_tgt' },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--target');
    expect(r.stderr).toContain("lacks both 'fresh' and 'findings'");
  });

  it('accepts /api/reviews/:id body shape (findings) on either side', async () => {
    // Compare must accept the alternate input shape so an operator
    // who fetches /api/reviews/:id (not /digest) can still use it.
    const baseFindings = [f({ severity: 'high', file: 'a.ts' })];
    const r = await runCompare(
      JSON.stringify({ reviewId: 'rv_base', findings: baseFindings }),
      JSON.stringify({ reviewId: 'rv_tgt', findings: [] }),
      { server: 'http://localhost', base: 'rv_base', target: 'rv_tgt', format: 'json' },
    );
    expect(r.exitCode).toBe(3); // 1 vs 0 = drift
    const body = JSON.parse(r.stdout);
    expect(body.base.total).toBe(1);
    expect(body.target.total).toBe(0);
  });

  it('strips a trailing slash from --server so URL composition is unambiguous', async () => {
    const findings = [f()];
    const dig = findingDigest(findings, { topAgents: 8 });
    const r = await runCompare(
      digestBody('rv_base', dig),
      digestBody('rv_tgt', dig),
      { server: 'http://localhost///', base: 'rv_base', target: 'rv_tgt' },
    );
    expect(r.exitCode).toBe(0);
    for (const url of r.fetchCalls) {
      // Single slash between origin and path (no `http://localhost//api`).
      expect(url).toMatch(/^http:\/\/localhost\/api\//);
    }
  });

  describe('parseCompareConfig pure helper', () => {
    it('returns ok on the happy path with trailing-slash stripped', async () => {
      const { parseCompareConfig } = await import('../src/commands/review.js');
      const r = parseCompareConfig({
        base: 'rv_a',
        target: 'rv_b',
        server: 'http://localhost/',
        format: 'json',
      });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.serverUrl).toBe('http://localhost');
        expect(r.baseId).toBe('rv_a');
        expect(r.targetId).toBe('rv_b');
        expect(r.format).toBe('json');
      }
    });

    it('defaults format to text when absent', async () => {
      const { parseCompareConfig } = await import('../src/commands/review.js');
      const r = parseCompareConfig({
        base: 'a', target: 'b', server: 'http://x',
      });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') expect(r.format).toBe('text');
    });

    it('rejects empty / non-string --base', async () => {
      const { parseCompareConfig } = await import('../src/commands/review.js');
      expect(parseCompareConfig({ base: '', target: 'b', server: 'http://x' }).kind).toBe('missing-base');
      expect(parseCompareConfig({ base: '   ', target: 'b', server: 'http://x' }).kind).toBe('missing-base');
      expect(parseCompareConfig({ target: 'b', server: 'http://x' }).kind).toBe('missing-base');
      expect(parseCompareConfig({ base: 5 as unknown as string, target: 'b', server: 'http://x' }).kind).toBe('missing-base');
    });

    it('rejects empty --target / --server', async () => {
      const { parseCompareConfig } = await import('../src/commands/review.js');
      expect(parseCompareConfig({ base: 'a', target: '', server: 'http://x' }).kind).toBe('missing-target');
      expect(parseCompareConfig({ base: 'a', target: 'b', server: '' }).kind).toBe('missing-server');
    });

    it('rejects unknown --format with a precise sentinel', async () => {
      const { parseCompareConfig } = await import('../src/commands/review.js');
      const r = parseCompareConfig({ base: 'a', target: 'b', server: 'http://x', format: 'xml' });
      expect(r.kind).toBe('invalid-format');
      if (r.kind === 'invalid-format') {
        expect(r.message).toContain('xml');
      }
    });
  });
});

// Tick 23: `--on-regression <cmd>` hook on the compare command.
// Fires when target has MORE findings than base in at least one
// bucket (i.e. positive deltas anywhere = regression). Mirrors the
// watch-mode --on-drift hook contract: shell-exec with JSON payload
// piped to stdin.
describe('clawreview review drift --on-regression (tick 23)', () => {
  /**
   * Drive runReviewDriftCompare with stub fetcher + stub regression
   * executor so the suite doesn't shell out. Returns captured
   * stdout/stderr plus the captured hook invocations.
   */
  async function runCompareWithOnRegression(
    baseFresh: ReturnType<typeof findingDigest>,
    targetFresh: ReturnType<typeof findingDigest>,
    flags: Record<string, string | boolean> = {},
    execerOpts: { exitCode?: number; throwErr?: Error } = {},
  ): Promise<RunResult & { hookCalls: Array<{ cmd: string; payload: string }> }> {
    const { runReviewDriftCompare } = await import('../src/commands/review.js');
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
    const baseBody = JSON.stringify({
      reviewId: 'rv_base',
      persisted: baseFresh,
      fresh: baseFresh,
      drift: { hasDrift: false, totalDelta: 0, bySeverityDelta: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 }, byAgentDelta: {}, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {} },
      recompute: 'fresh',
    });
    const targetBody = JSON.stringify({
      reviewId: 'rv_tgt',
      persisted: targetFresh,
      fresh: targetFresh,
      drift: { hasDrift: false, totalDelta: 0, bySeverityDelta: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 }, byAgentDelta: {}, byCategoryDelta: {}, byFileDelta: {}, byTagDelta: {} },
      recompute: 'fresh',
    });
    const fetcher = async (url: string) => {
      const body = url.includes('rv_tgt') ? targetBody : baseBody;
      return { ok: true, status: 200, text: async () => body };
    };
    const hookCalls: Array<{ cmd: string; payload: string }> = [];
    const onRegressionExecer = async (cmd: string, payload: string) => {
      hookCalls.push({ cmd, payload });
      if (execerOpts.throwErr) throw execerOpts.throwErr;
      return { exitCode: execerOpts.exitCode ?? 0, stderr: '' };
    };
    process.exitCode = 0;
    try {
      await runReviewDriftCompare(
        {
          command: 'review',
          positional: ['drift'],
          flags: {
            'no-color': true,
            server: 'http://localhost',
            base: 'rv_base',
            target: 'rv_tgt',
            ...flags,
          },
        },
        'rv_base',
        'rv_tgt',
        { fetcher, onRegressionExecer },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return {
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exitCode: code,
      hookCalls,
    };
  }

  it('fires the hook with a regression payload when target has MORE findings than base in a bucket', async () => {
    // base: 1 high, 0 medium. target: 1 high, 2 medium (regression!).
    const baseFindings = [f({ severity: 'high', file: 'a.ts' })];
    const targetFindings = [
      f({ severity: 'high', file: 'a.ts' }),
      f({ severity: 'medium', file: 'b.ts' }),
      f({ severity: 'medium', file: 'c.ts' }),
    ];
    const baseDig = findingDigest(baseFindings as never, { topAgents: 8, topCategories: 8 });
    const targetDig = findingDigest(targetFindings as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompareWithOnRegression(baseDig, targetDig, {
      'on-regression': 'echo regressed',
    });
    expect(r.exitCode).toBe(3); // drift detected
    expect(r.hookCalls).toHaveLength(1);
    expect(r.hookCalls[0]!.cmd).toBe('echo regressed');
    // Payload describes the regression slice.
    const payload = JSON.parse(r.hookCalls[0]!.payload);
    expect(payload.kind).toBe('regression');
    expect(payload.baseReviewId).toBe('rv_base');
    expect(payload.targetReviewId).toBe('rv_tgt');
    // bySeverity: medium went from 0 -> 2, so the slice has medium=2.
    expect(payload.bySeverityRegression.medium).toBe(2);
    // No high delta (1 vs 1) so high is absent from the slice.
    expect(payload.bySeverityRegression.high).toBeUndefined();
    // byFile: b.ts and c.ts are new.
    expect(payload.byFileRegression['b.ts']).toBe(1);
    expect(payload.byFileRegression['c.ts']).toBe(1);
    // totalDelta sums the severity axis (2 new findings).
    expect(payload.totalDelta).toBe(2);
  });

  it('does NOT fire the hook when target has FEWER findings (bug fix - negative deltas only)', async () => {
    // base: 3 findings. target: 1 finding (bug fix cleared 2).
    const baseFindings = [
      f({ severity: 'high', file: 'a.ts' }),
      f({ severity: 'high', file: 'b.ts' }),
      f({ severity: 'medium', file: 'c.ts' }),
    ];
    const targetFindings = [f({ severity: 'medium', file: 'c.ts' })];
    const baseDig = findingDigest(baseFindings as never, { topAgents: 8, topCategories: 8 });
    const targetDig = findingDigest(targetFindings as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompareWithOnRegression(baseDig, targetDig, {
      'on-regression': 'echo would-fire-if-regressed',
    });
    expect(r.exitCode).toBe(3); // drift still detected
    // Hook NOT fired because every per-bucket delta is <= 0.
    expect(r.hookCalls).toHaveLength(0);
  });

  it('does NOT fire the hook when there is no drift at all', async () => {
    const findings = [f({ severity: 'high', file: 'a.ts' })];
    const dig = findingDigest(findings as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompareWithOnRegression(dig, dig, {
      'on-regression': 'echo would-fire',
    });
    expect(r.exitCode).toBe(0);
    expect(r.hookCalls).toHaveLength(0);
  });

  it('fires the hook even on mixed deltas (regression in one file + fix in another)', async () => {
    // base: 1 high in a.ts, 1 medium in b.ts.
    // target: 1 high in a.ts (unchanged), 0 medium in b.ts (fixed!), 1 NEW low in c.ts.
    // -> mixed: c.ts is a regression (positive delta), b.ts is a fix (negative).
    // Hook should fire because there IS a positive delta in the byFile axis.
    const baseFindings = [
      f({ severity: 'high', file: 'a.ts' }),
      f({ severity: 'medium', file: 'b.ts' }),
    ];
    const targetFindings = [
      f({ severity: 'high', file: 'a.ts' }),
      f({ severity: 'low', file: 'c.ts' }),
    ];
    const baseDig = findingDigest(baseFindings as never, { topAgents: 8, topCategories: 8 });
    const targetDig = findingDigest(targetFindings as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompareWithOnRegression(baseDig, targetDig, {
      'on-regression': 'echo regressed-on-mix',
    });
    expect(r.exitCode).toBe(3);
    expect(r.hookCalls).toHaveLength(1);
    const payload = JSON.parse(r.hookCalls[0]!.payload);
    // c.ts is the regression file; b.ts (-1) is omitted from the slice.
    expect(payload.byFileRegression['c.ts']).toBe(1);
    expect(payload.byFileRegression['b.ts']).toBeUndefined();
    // bySeverity: low went 0 -> 1 (regression); medium went 1 -> 0 (omitted).
    expect(payload.bySeverityRegression.low).toBe(1);
    expect(payload.bySeverityRegression.medium).toBeUndefined();
  });

  it('does NOT fire when --on-regression flag is absent (default back-compat)', async () => {
    const baseFindings = [f({ severity: 'high', file: 'a.ts' })];
    const targetFindings = [
      f({ severity: 'high', file: 'a.ts' }),
      f({ severity: 'medium', file: 'b.ts' }),
    ];
    const baseDig = findingDigest(baseFindings as never, { topAgents: 8, topCategories: 8 });
    const targetDig = findingDigest(targetFindings as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompareWithOnRegression(baseDig, targetDig, {
      // no --on-regression
    });
    expect(r.exitCode).toBe(3);
    expect(r.hookCalls).toHaveLength(0);
  });

  it('rejects empty --on-regression with exit 2 (typo guard)', async () => {
    const dig = findingDigest([f({ severity: 'high' })] as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompareWithOnRegression(dig, dig, {
      'on-regression': '',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--on-regression');
    expect(r.hookCalls).toHaveLength(0);
  });

  it('surfaces hook non-zero exit on stderr but does NOT change compare exit code', async () => {
    const baseFindings = [f({ severity: 'high', file: 'a.ts' })];
    const targetFindings = [
      f({ severity: 'high', file: 'a.ts' }),
      f({ severity: 'medium', file: 'b.ts' }),
    ];
    const baseDig = findingDigest(baseFindings as never, { topAgents: 8, topCategories: 8 });
    const targetDig = findingDigest(targetFindings as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompareWithOnRegression(
      baseDig, targetDig,
      { 'on-regression': 'broken-cmd' },
      { exitCode: 17 },
    );
    expect(r.exitCode).toBe(3); // drift exit code preserved
    expect(r.stderr).toContain('--on-regression hook exited 17');
    expect(r.hookCalls).toHaveLength(1);
  });

  it('surfaces hook throw on stderr but does NOT change compare exit code', async () => {
    const baseFindings = [f({ severity: 'high', file: 'a.ts' })];
    const targetFindings = [
      f({ severity: 'high', file: 'a.ts' }),
      f({ severity: 'medium', file: 'b.ts' }),
    ];
    const baseDig = findingDigest(baseFindings as never, { topAgents: 8, topCategories: 8 });
    const targetDig = findingDigest(targetFindings as never, { topAgents: 8, topCategories: 8 });
    const r = await runCompareWithOnRegression(
      baseDig, targetDig,
      { 'on-regression': 'broken-cmd' },
      { throwErr: new Error('ENOENT: cmd not found') },
    );
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('--on-regression hook threw');
    expect(r.stderr).toContain('ENOENT');
  });

  // Pure helper coverage so the regression slice predicate has a
  // regression pin independent of the wire / fetch / shell paths.
  describe('computeRegressionSlice (pure)', () => {
    it('returns null when no bucket has a positive delta', async () => {
      const { computeRegressionSlice } = await import('../src/commands/review.js');
      const drift = {
        totalDelta: -5, hasDrift: true,
        bySeverityDelta: { critical: 0, high: -2, medium: -3, low: 0, nit: 0 },
        byAgentDelta: { security: -5 },
        byCategoryDelta: { security: -5 },
        byFileDelta: { 'a.ts': -5 },
        byTagDelta: {},
      };
      expect(computeRegressionSlice(drift as never)).toBeNull();
    });

    it('returns a slice with positive bucket deltas only when at least one is > 0', async () => {
      const { computeRegressionSlice } = await import('../src/commands/review.js');
      const drift = {
        totalDelta: 3, hasDrift: true,
        bySeverityDelta: { critical: 1, high: 0, medium: 2, low: -1, nit: 0 },
        byAgentDelta: { security: 3, style: -1 },
        byCategoryDelta: { security: 3 },
        byFileDelta: { 'a.ts': 2, 'b.ts': -1, 'c.ts': 1 },
        byTagDelta: { 'owasp:a01': 2 },
      };
      const slice = computeRegressionSlice(drift as never);
      expect(slice).not.toBeNull();
      expect(slice!.totalDelta).toBe(3); // sum of severity axis (1 + 2)
      // Negative entries omitted; zeros omitted.
      expect(slice!.bySeverityRegression).toEqual({ critical: 1, medium: 2 });
      expect(slice!.byAgentRegression).toEqual({ security: 3 });
      expect(slice!.byFileRegression).toEqual({ 'a.ts': 2, 'c.ts': 1 });
      expect(slice!.byFileRegression['b.ts']).toBeUndefined();
      expect(slice!.byTagRegression).toEqual({ 'owasp:a01': 2 });
    });

    it('returns a slice when only one non-severity axis has a positive delta', async () => {
      // Edge case: a regression where a single new tag appeared but
      // severity counts net out. Slice should still trigger.
      const { computeRegressionSlice } = await import('../src/commands/review.js');
      const drift = {
        totalDelta: 0, hasDrift: true,
        bySeverityDelta: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
        byAgentDelta: {},
        byCategoryDelta: {},
        byFileDelta: {},
        byTagDelta: { 'new-tag': 1 },
      };
      const slice = computeRegressionSlice(drift as never);
      expect(slice).not.toBeNull();
      expect(slice!.totalDelta).toBe(0); // severity sum is 0 here
      expect(slice!.byTagRegression['new-tag']).toBe(1);
    });
  });

  // Tick 24: --on-regression-template slack|webhook expansion. Mirrors
  // tick-17's --on-drift-template / tick-19's --on-recover-template.
  describe('--on-regression-template (tick 24 template expansion)', () => {
    it('expands slack with $SLACK_REGRESSION_WEBHOOK_URL primary', async () => {
      const { expandOnRegressionTemplate } = await import('../src/commands/review.js');
      const r = expandOnRegressionTemplate('slack', {
        SLACK_REGRESSION_WEBHOOK_URL: 'https://hooks.slack.com/services/regression',
        SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/drift',
      });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        // Primary wins over fallback.
        expect(r.command).toContain('https://hooks.slack.com/services/regression');
        expect(r.command).toContain('curl -sS -X POST');
        expect(r.command).toContain('--data-binary @-');
      }
    });

    it('falls back to $SLACK_WEBHOOK_URL when primary is unset', async () => {
      const { expandOnRegressionTemplate } = await import('../src/commands/review.js');
      const r = expandOnRegressionTemplate('slack', {
        SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/shared',
      });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.command).toContain('https://hooks.slack.com/services/shared');
      }
    });

    it('expands webhook with $WEBHOOK_REGRESSION_URL primary, falls back to $WEBHOOK_URL', async () => {
      const { expandOnRegressionTemplate } = await import('../src/commands/review.js');
      const primary = expandOnRegressionTemplate('webhook', {
        WEBHOOK_REGRESSION_URL: 'https://hooks.example.com/regression',
      });
      if (primary.kind === 'ok') {
        expect(primary.command).toContain('https://hooks.example.com/regression');
      }
      const fallback = expandOnRegressionTemplate('webhook', {
        WEBHOOK_URL: 'https://hooks.example.com/shared',
      });
      if (fallback.kind === 'ok') {
        expect(fallback.command).toContain('https://hooks.example.com/shared');
      }
    });

    it('rejects unknown template name with the enumerated valid list', async () => {
      const { expandOnRegressionTemplate } = await import('../src/commands/review.js');
      const r = expandOnRegressionTemplate('discord', { WEBHOOK_URL: 'https://x' });
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') {
        expect(r.message).toContain('discord');
        expect(r.message).toContain('slack');
        expect(r.message).toContain('webhook');
      }
    });

    it('rejects when neither primary nor fallback env var is set (with the "set $X" hint)', async () => {
      const { expandOnRegressionTemplate } = await import('../src/commands/review.js');
      const r = expandOnRegressionTemplate('slack', {});
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') {
        expect(r.message).toContain('SLACK_REGRESSION_WEBHOOK_URL');
        expect(r.message).toContain('SLACK_WEBHOOK_URL');
      }
    });

    it('case-insensitive on the template name', async () => {
      const { expandOnRegressionTemplate } = await import('../src/commands/review.js');
      const r = expandOnRegressionTemplate('SLACK', {
        SLACK_WEBHOOK_URL: 'https://x',
      });
      expect(r.kind).toBe('ok');
    });

    it('ON_REGRESSION_TEMPLATES is the closed slack|webhook tuple', async () => {
      const { ON_REGRESSION_TEMPLATES } = await import('../src/commands/review.js');
      expect([...ON_REGRESSION_TEMPLATES]).toEqual(['slack', 'webhook']);
    });

    // parseOnRegressionFlags integration: each error arm + happy path.
    describe('parseOnRegressionFlags (pure)', () => {
      it('returns "none" when neither flag is set', async () => {
        const { parseOnRegressionFlags } = await import('../src/commands/review.js');
        const r = parseOnRegressionFlags({ env: {} });
        expect(r.kind).toBe('none');
      });

      it('resolves --on-regression alone', async () => {
        const { parseOnRegressionFlags } = await import('../src/commands/review.js');
        const r = parseOnRegressionFlags({ 'on-regression': 'echo x', env: {} });
        expect(r.kind).toBe('ok');
        if (r.kind === 'ok') expect(r.command).toBe('echo x');
      });

      it('resolves --on-regression-template alone (with env var set)', async () => {
        const { parseOnRegressionFlags } = await import('../src/commands/review.js');
        const r = parseOnRegressionFlags({
          'on-regression-template': 'slack',
          env: { SLACK_WEBHOOK_URL: 'https://x' },
        });
        expect(r.kind).toBe('ok');
        if (r.kind === 'ok') expect(r.command).toContain('https://x');
      });

      it('rejects --on-regression empty / non-string', async () => {
        const { parseOnRegressionFlags } = await import('../src/commands/review.js');
        const empty = parseOnRegressionFlags({ 'on-regression': '', env: {} });
        expect(empty.kind).toBe('invalid');
        const ws = parseOnRegressionFlags({ 'on-regression': '   ', env: {} });
        expect(ws.kind).toBe('invalid');
        const numeric = parseOnRegressionFlags({
          'on-regression': 5 as unknown as string,
          env: {},
        });
        expect(numeric.kind).toBe('invalid');
      });

      it('rejects both --on-regression AND --on-regression-template (mutex)', async () => {
        const { parseOnRegressionFlags } = await import('../src/commands/review.js');
        const r = parseOnRegressionFlags({
          'on-regression': 'echo x',
          'on-regression-template': 'slack',
          env: { SLACK_WEBHOOK_URL: 'https://x' },
        });
        expect(r.kind).toBe('invalid');
        if (r.kind === 'invalid') {
          expect(r.message).toContain('mutually exclusive');
        }
      });

      it('rejects --on-regression-template empty', async () => {
        const { parseOnRegressionFlags } = await import('../src/commands/review.js');
        const r = parseOnRegressionFlags({ 'on-regression-template': '', env: {} });
        expect(r.kind).toBe('invalid');
      });

      it('rejects --on-regression-template with unknown name', async () => {
        const { parseOnRegressionFlags } = await import('../src/commands/review.js');
        const r = parseOnRegressionFlags({
          'on-regression-template': 'discord',
          env: { WEBHOOK_URL: 'https://x' },
        });
        expect(r.kind).toBe('invalid');
      });

      it('rejects --on-regression-template with no env var set', async () => {
        const { parseOnRegressionFlags } = await import('../src/commands/review.js');
        const r = parseOnRegressionFlags({
          'on-regression-template': 'slack',
          env: {},
        });
        expect(r.kind).toBe('invalid');
        if (r.kind === 'invalid') {
          expect(r.message).toContain('SLACK_WEBHOOK_URL');
        }
      });
    });

    // Integration: --on-regression-template fires the same hook
    // executor as --on-regression with the expanded command line.
    it('fires the regression hook with the template-expanded curl command', async () => {
      // Save + restore env so the test doesn't leak the URL.
      const prev = process.env.SLACK_WEBHOOK_URL;
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/integration-test';
      try {
        const baseFindings = [f({ severity: 'high', file: 'a.ts' })];
        const targetFindings = [
          f({ severity: 'high', file: 'a.ts' }),
          f({ severity: 'medium', file: 'b.ts' }),
        ];
        const baseDig = findingDigest(baseFindings as never, { topAgents: 8, topCategories: 8 });
        const targetDig = findingDigest(targetFindings as never, { topAgents: 8, topCategories: 8 });
        const r = await runCompareWithOnRegression(baseDig, targetDig, {
          'on-regression-template': 'slack',
        });
        expect(r.exitCode).toBe(3);
        expect(r.hookCalls).toHaveLength(1);
        // Template expanded into a curl line targeting the env URL.
        expect(r.hookCalls[0]!.cmd).toContain('curl -sS -X POST');
        expect(r.hookCalls[0]!.cmd).toContain('hooks.slack.com/services/integration-test');
      } finally {
        if (prev === undefined) delete process.env.SLACK_WEBHOOK_URL;
        else process.env.SLACK_WEBHOOK_URL = prev;
      }
    });

    it('rejects with exit 2 when --on-regression-template AND --on-regression are both passed', async () => {
      const baseFindings = [f({ severity: 'high', file: 'a.ts' })];
      const targetFindings = [f({ severity: 'high', file: 'a.ts' })];
      const baseDig = findingDigest(baseFindings as never, { topAgents: 8, topCategories: 8 });
      const targetDig = findingDigest(targetFindings as never, { topAgents: 8, topCategories: 8 });
      const r = await runCompareWithOnRegression(baseDig, targetDig, {
        'on-regression': 'echo x',
        'on-regression-template': 'slack',
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('mutually exclusive');
      // Hook NEVER fires because parsing rejected.
      expect(r.hookCalls).toHaveLength(0);
    });
  });
});
// Tick 23: `clawreview review filter-report <reviewId> --server <url>`
// Single-shot CLI face of the new /api/reviews/:id/filter-report
// endpoint. Mirrors the runReviewDriftCompare test pattern: stub
// fetcher, capture stdout/stderr, assert exit code + body shape.
describe('clawreview review filter-report (tick 23)', () => {
  async function runFilterReport(
    body: string | { ok: boolean; status: number; body: string },
    positional: string[] = ['filter-report', 'rv_42_abc'],
    flags: Record<string, string | boolean> = { server: 'http://localhost' },
  ): Promise<RunResult & { fetchCalls: string[] }> {
    const { runReviewFilterReport } = await import('../src/commands/review.js');
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
    const fetchCalls: string[] = [];
    const entry = typeof body === 'string' ? { ok: true, status: 200, body } : body;
    const fetcher = async (url: string) => {
      fetchCalls.push(url);
      return { ok: entry.ok, status: entry.status, text: async () => entry.body };
    };
    process.exitCode = 0;
    try {
      await runReviewFilterReport(
        {
          command: 'review',
          positional,
          flags: { 'no-color': true, ...flags },
        },
        { fetcher },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return {
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exitCode: code,
      fetchCalls,
    };
  }

  function fullBody(extra: Partial<{ applied: boolean; droppedTotal: number }> = {}): string {
    return JSON.stringify({
      reviewId: 'rv_42_abc',
      inputTotal: 10,
      droppedTotal: extra.droppedTotal ?? 3,
      applied: extra.applied ?? true,
      slim: false,
      appliedFilters: {
        minConfidence: { raw: 0.5, normalised: 0.5, applied: true },
        severityThreshold: { raw: undefined, normalised: null, applied: false },
        any: extra.applied ?? true,
      },
    });
  }

  it('renders the full text banner on a successful fetch', async () => {
    const r = await runFilterReport(fullBody());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('review:');
    expect(r.stdout).toContain('rv_42_abc');
    expect(r.stdout).toContain('inputTotal');
    expect(r.stdout).toContain('droppedTotal');
    expect(r.stdout).toContain('applied');
    // Full mode surfaces per-axis appliedFilters.
    expect(r.stdout).toContain('appliedFilters');
    expect(r.stdout).toContain('min_confidence');
    expect(r.stdout).toContain('severity_threshold');
    // URL was hit without ?slim= (full mode is the default).
    expect(r.fetchCalls).toHaveLength(1);
    expect(r.fetchCalls[0]).toContain('/api/reviews/rv_42_abc/filter-report');
    expect(r.fetchCalls[0]).not.toContain('slim');
  });

  it('emits JSON verbatim with --format json', async () => {
    const r = await runFilterReport(fullBody(), ['filter-report', 'rv_42_abc'], {
      server: 'http://localhost',
      format: 'json',
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.reviewId).toBe('rv_42_abc');
    expect(parsed.inputTotal).toBe(10);
    expect(parsed.droppedTotal).toBe(3);
    expect(parsed.applied).toBe(true);
    expect(parsed.appliedFilters.minConfidence.normalised).toBe(0.5);
  });

  it('forwards --slim as ?slim=true on the wire and renders the slim banner', async () => {
    const slimBody = JSON.stringify({
      reviewId: 'rv_42_abc',
      inputTotal: 10,
      droppedTotal: 3,
      applied: true,
      slim: true,
    });
    const r = await runFilterReport(slimBody, ['filter-report', 'rv_42_abc'], {
      server: 'http://localhost',
      slim: true,
    });
    expect(r.exitCode).toBe(0);
    // URL carries ?slim=true so the server returns the slim shape.
    expect(r.fetchCalls[0]).toContain('?slim=true');
    // Slim text banner mentions the slim mode and omits per-axis lines.
    expect(r.stdout).toContain('slim mode');
    expect(r.stdout).not.toContain('appliedFilters');
  });

  it('rejects with exit 2 and a missing-review-id sentinel when no positional reviewId is given', async () => {
    const r = await runFilterReport(fullBody(), ['filter-report'], { server: 'http://localhost' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('reviewId');
    // Fetcher was never invoked because the parser short-circuited.
    expect(r.fetchCalls).toHaveLength(0);
  });

  it('rejects with exit 2 when --server is missing', async () => {
    const r = await runFilterReport(fullBody(), ['filter-report', 'rv_42_abc'], {});
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--server');
  });

  it('rejects with exit 2 and surfaces the body error sentinel on HTTP 404 NoFilterReport', async () => {
    const r = await runFilterReport(
      { ok: false, status: 404, body: JSON.stringify({ error: 'NoFilterReport', reviewId: 'rv_42_abc' }) },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('HTTP 404');
    expect(r.stderr).toContain('NoFilterReport');
  });

  it('rejects with exit 2 on network failure (fetcher rejects)', async () => {
    const { runReviewFilterReport } = await import('../src/commands/review.js');
    const stderr: string[] = [];
    const writeStderr = vi.spyOn(process.stderr, 'write').mockImplementation(
      ((chunk: unknown) => {
        stderr.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
        return true;
      }) as never,
    );
    const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as never);
    process.exitCode = 0;
    try {
      await runReviewFilterReport(
        {
          command: 'review',
          positional: ['filter-report', 'rv_42_abc'],
          flags: { 'no-color': true, server: 'http://localhost' },
        },
        { fetcher: async () => { throw new Error('ECONNREFUSED'); } },
      );
    } finally {
      writeStderr.mockRestore();
      writeStdout.mockRestore();
    }
    expect(process.exitCode).toBe(2);
    expect(stderr.join('')).toContain('fetch failed');
    expect(stderr.join('')).toContain('ECONNREFUSED');
    process.exitCode = 0;
  });

  // Pure parseFilterReportConfig coverage (mirrors parseCompareConfig
  // unit tests above) so each discriminant has a regression pin.
  describe('parseFilterReportConfig (pure)', () => {
    it('resolves the happy path with all defaults', async () => {
      const { parseFilterReportConfig } = await import('../src/commands/review.js');
      const r = parseFilterReportConfig({ reviewId: 'rv_42_abc', server: 'http://x/' });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        // Trailing slash stripped (mirrors parseCompareConfig).
        expect(r.serverUrl).toBe('http://x');
        expect(r.reviewId).toBe('rv_42_abc');
        expect(r.format).toBe('text');
        expect(r.slim).toBe(false);
      }
    });

    it('rejects empty / non-string reviewId', async () => {
      const { parseFilterReportConfig } = await import('../src/commands/review.js');
      expect(parseFilterReportConfig({ reviewId: '', server: 'http://x' }).kind).toBe('missing-review-id');
      expect(parseFilterReportConfig({ reviewId: '   ', server: 'http://x' }).kind).toBe('missing-review-id');
      expect(parseFilterReportConfig({ server: 'http://x' }).kind).toBe('missing-review-id');
      expect(parseFilterReportConfig({ reviewId: 5 as unknown as string, server: 'http://x' }).kind).toBe('missing-review-id');
    });

    it('rejects empty --server', async () => {
      const { parseFilterReportConfig } = await import('../src/commands/review.js');
      expect(parseFilterReportConfig({ reviewId: 'rv', server: '' }).kind).toBe('missing-server');
    });

    it('rejects unknown --format', async () => {
      const { parseFilterReportConfig } = await import('../src/commands/review.js');
      const r = parseFilterReportConfig({ reviewId: 'rv', server: 'http://x', format: 'xml' });
      expect(r.kind).toBe('invalid-format');
      if (r.kind === 'invalid-format') {
        expect(r.message).toContain('xml');
      }
    });

    it('accepts --slim as boolean true OR string "true"/"1"/"yes"', async () => {
      const { parseFilterReportConfig } = await import('../src/commands/review.js');
      const trueArm = parseFilterReportConfig({ reviewId: 'rv', server: 'http://x', slim: true });
      expect(trueArm.kind).toBe('ok');
      if (trueArm.kind === 'ok') expect(trueArm.slim).toBe(true);
      for (const truthy of ['true', '1', 'yes', 'YES', 'True']) {
        const r = parseFilterReportConfig({ reviewId: 'rv', server: 'http://x', slim: truthy });
        if (r.kind === 'ok') expect(r.slim).toBe(true);
      }
      for (const falsy of ['false', '0', 'no', '', 'bogus']) {
        const r = parseFilterReportConfig({ reviewId: 'rv', server: 'http://x', slim: falsy });
        if (r.kind === 'ok') expect(r.slim).toBe(false);
      }
    });
  });

  // Tick 24: --require-filter gating flag. Exit 3 when the persisted
  // report's applied bit is false. Mirrors `presets diff` /
  // `review drift` exit-3-on-drift contract for CI gateability.
  describe('--require-filter (tick 24 gating)', () => {
    it('exits 0 by default (back-compat with tick 23) when applied=false', async () => {
      const r = await runFilterReport(fullBody({ applied: false }));
      expect(r.exitCode).toBe(0);
      // No stderr hint when the flag is OFF.
      expect(r.stderr).not.toContain('require-filter');
    });

    it('exits 0 when --require-filter is set AND applied=true', async () => {
      const r = await runFilterReport(fullBody({ applied: true }), ['filter-report', 'rv_42_abc'], {
        server: 'http://localhost',
        'require-filter': true,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain('require-filter');
    });

    it('exits 3 when --require-filter is set AND applied=false (with stderr hint)', async () => {
      const r = await runFilterReport(fullBody({ applied: false }), ['filter-report', 'rv_42_abc'], {
        server: 'http://localhost',
        'require-filter': true,
      });
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain('--require-filter');
      expect(r.stderr).toContain('applied=false');
      // The body still rendered (text default) before the gate flipped
      // the exit code -- the CI step sees both the report and the
      // failure signal.
      expect(r.stdout).toContain('rv_42_abc');
    });

    it('gates on the slim body too (applied is top-level on both shapes)', async () => {
      const slimBodyFalse = JSON.stringify({
        reviewId: 'rv_42_abc',
        inputTotal: 10,
        droppedTotal: 0,
        applied: false,
        slim: true,
      });
      const r = await runFilterReport(slimBodyFalse, ['filter-report', 'rv_42_abc'], {
        server: 'http://localhost',
        slim: true,
        'require-filter': true,
      });
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain('applied=false');
    });

    it('still renders JSON body before flipping to exit 3 (CI gets both the data and the failure signal)', async () => {
      const r = await runFilterReport(fullBody({ applied: false }), ['filter-report', 'rv_42_abc'], {
        server: 'http://localhost',
        format: 'json',
        'require-filter': true,
      });
      expect(r.exitCode).toBe(3);
      // Stdout still carries the JSON body so jq pipelines have the data.
      const parsed = JSON.parse(r.stdout);
      expect(parsed.reviewId).toBe('rv_42_abc');
      expect(parsed.applied).toBe(false);
    });
  });
});

// Tick 24: `clawreview review filter-report --watch <reviewId>` poll
// mode. Mirrors the runReviewDriftWatch test pattern: stub fetcher +
// sleeper, capture stdout/stderr, drive the loop with canned bodies.
describe('clawreview review filter-report --watch (tick 24)', () => {
  async function runWatch(
    reviewId: string,
    flags: Record<string, string | boolean>,
    bodies: Array<string | { ok: boolean; status: number; body: string }>,
  ): Promise<RunResult & { fetchCalls: string[] }> {
    const { runReviewFilterReportWatch } = await import('../src/commands/review.js');
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
    const fetchCalls: string[] = [];
    let bodyIdx = 0;
    const fetcher = async (url: string) => {
      fetchCalls.push(url);
      const entry = bodies[bodyIdx] ?? bodies[bodies.length - 1]!;
      bodyIdx += 1;
      if (typeof entry === 'string') {
        return { ok: true, status: 200, text: async () => entry };
      }
      return { ok: entry.ok, status: entry.status, text: async () => entry.body };
    };
    const sleeper = async () => undefined;
    process.exitCode = 0;
    try {
      await runReviewFilterReportWatch(
        {
          command: 'review',
          positional: ['filter-report'],
          flags: { 'no-color': true, watch: reviewId, ...flags },
        },
        reviewId,
        { fetcher, sleeper },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code, fetchCalls };
  }

  function makeFullBody(opts: { applied?: boolean; droppedTotal?: number } = {}): string {
    return JSON.stringify({
      reviewId: 'rv_w_1',
      inputTotal: 10,
      droppedTotal: opts.droppedTotal ?? 3,
      applied: opts.applied ?? true,
      slim: false,
      appliedFilters: {
        minConfidence: { raw: 0.5, normalised: 0.5, applied: true },
        severityThreshold: { raw: undefined, normalised: null, applied: false },
        any: opts.applied ?? true,
      },
    });
  }

  function makeSlimBody(opts: { applied?: boolean } = {}): string {
    return JSON.stringify({
      reviewId: 'rv_w_1',
      inputTotal: 10,
      droppedTotal: 3,
      applied: opts.applied ?? true,
      slim: true,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects when --server is missing', async () => {
    const r = await runWatch('rv_w_1', {}, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--server');
    expect(r.stderr).toContain('--watch');
    expect(r.fetchCalls).toEqual([]);
  });

  it('rejects an invalid --interval (below WATCH_MIN_INTERVAL_MS)', async () => {
    const r = await runWatch('rv_w_1', {
      server: 'https://test.local',
      interval: '50',
    }, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--interval');
    expect(r.stderr).toMatch(/>= 250/);
  });

  it('rejects an invalid --max-polls (negative integer)', async () => {
    const r = await runWatch('rv_w_1', {
      server: 'https://test.local',
      'max-polls': '-1',
    }, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--max-polls');
  });

  it('rejects an invalid --format', async () => {
    const r = await runWatch('rv_w_1', {
      server: 'https://test.local',
      format: 'sarif',
    }, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--format');
  });

  it('polls /api/reviews/:id/filter-report with --max-polls 2 (two text samples + watch-stopped message)', async () => {
    const r = await runWatch('rv_w_1', {
      server: 'https://test.local',
      'max-polls': '2',
    }, [makeFullBody(), makeFullBody()]);
    expect(r.exitCode).toBe(0);
    // Two fetches in order; both hit the filter-report endpoint.
    expect(r.fetchCalls).toHaveLength(2);
    expect(r.fetchCalls[0]).toContain('/api/reviews/rv_w_1/filter-report');
    expect(r.fetchCalls[1]).toContain('/api/reviews/rv_w_1/filter-report');
    // Two `--- poll N at <iso> ---` separators -- one per sample.
    expect((r.stdout.match(/--- poll \d+ at/g) ?? []).length).toBe(2);
    // Full text banner shows up between separators.
    expect(r.stdout).toContain('rv_w_1');
    expect(r.stdout).toContain('appliedFilters');
  });

  it('emits JSONL with --format json (one JSON object per poll)', async () => {
    const r = await runWatch('rv_w_1', {
      server: 'https://test.local',
      'max-polls': '2',
      format: 'json',
    }, [makeFullBody(), makeFullBody({ droppedTotal: 5 })]);
    expect(r.exitCode).toBe(0);
    // Two newline-delimited JSON objects.
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    const p0 = JSON.parse(lines[0]!);
    const p1 = JSON.parse(lines[1]!);
    expect(p0.poll).toBe(1);
    expect(p1.poll).toBe(2);
    expect(p0.reviewId).toBe('rv_w_1');
    expect(p0.body.droppedTotal).toBe(3);
    expect(p1.body.droppedTotal).toBe(5);
  });

  it('forwards --slim as ?slim=true on every poll', async () => {
    const r = await runWatch('rv_w_1', {
      server: 'https://test.local',
      'max-polls': '2',
      slim: true,
    }, [makeSlimBody(), makeSlimBody()]);
    expect(r.exitCode).toBe(0);
    // Both URLs carry ?slim=true.
    for (const url of r.fetchCalls) {
      expect(url).toContain('?slim=true');
    }
    // Slim banner reads "slim mode" inline.
    expect(r.stdout).toContain('slim mode');
  });

  it('aborts with exit 2 on HTTP non-2xx (poll N got HTTP <status>)', async () => {
    const r = await runWatch('rv_w_1', {
      server: 'https://test.local',
      'max-polls': '3',
    }, [
      makeFullBody(),
      { ok: false, status: 503, body: 'gone' },
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/poll 2 got HTTP 503/);
    // We did not poll a third time after the error.
    expect(r.fetchCalls).toHaveLength(2);
  });

  it('aborts with exit 2 on fetcher throw (ECONNREFUSED style)', async () => {
    const { runReviewFilterReportWatch } = await import('../src/commands/review.js');
    const stderr: string[] = [];
    const writeStderr = vi.spyOn(process.stderr, 'write').mockImplementation(
      ((chunk: unknown) => {
        stderr.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
        return true;
      }) as never,
    );
    const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as never);
    process.exitCode = 0;
    try {
      await runReviewFilterReportWatch(
        {
          command: 'review',
          positional: ['filter-report'],
          flags: { 'no-color': true, watch: 'rv_w_1', server: 'http://x', 'max-polls': '1' },
        },
        'rv_w_1',
        {
          fetcher: async () => { throw new Error('ECONNREFUSED'); },
          sleeper: async () => undefined,
        },
      );
    } finally {
      writeStderr.mockRestore();
      writeStdout.mockRestore();
    }
    expect(process.exitCode).toBe(2);
    expect(stderr.join('')).toContain('poll 1 failed');
    expect(stderr.join('')).toContain('ECONNREFUSED');
    process.exitCode = 0;
  });

  // Pure parseFilterReportWatchConfig coverage so each discriminant
  // has a regression pin.
  describe('parseFilterReportWatchConfig (pure)', () => {
    it('resolves the happy path with all defaults', async () => {
      const { parseFilterReportWatchConfig } = await import('../src/commands/review.js');
      const r = parseFilterReportWatchConfig({ server: 'http://x/' });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        // Trailing slash stripped.
        expect(r.serverUrl).toBe('http://x');
        expect(r.intervalMs).toBe(5000);
        expect(r.maxPolls).toBe(0);
        expect(r.format).toBe('text');
        expect(r.slim).toBe(false);
      }
    });

    it('rejects each invalid arm individually', async () => {
      const { parseFilterReportWatchConfig } = await import('../src/commands/review.js');
      expect(parseFilterReportWatchConfig({}).kind).toBe('missing-server');
      expect(parseFilterReportWatchConfig({ server: 'http://x', interval: '50' }).kind).toBe('invalid-interval');
      expect(parseFilterReportWatchConfig({ server: 'http://x', 'max-polls': '-1' }).kind).toBe('invalid-max-polls');
      expect(parseFilterReportWatchConfig({ server: 'http://x', format: 'xml' }).kind).toBe('invalid-format');
    });

    it('accepts --slim as boolean or string truthy', async () => {
      const { parseFilterReportWatchConfig } = await import('../src/commands/review.js');
      const bool = parseFilterReportWatchConfig({ server: 'http://x', slim: true });
      expect(bool.kind).toBe('ok');
      if (bool.kind === 'ok') expect(bool.slim).toBe(true);
      const str = parseFilterReportWatchConfig({ server: 'http://x', slim: '1' });
      if (str.kind === 'ok') expect(str.slim).toBe(true);
      const off = parseFilterReportWatchConfig({ server: 'http://x', slim: 'false' });
      if (off.kind === 'ok') expect(off.slim).toBe(false);
    });
  });

  // Tick 24: --require-filter watch-mode gating. The LAST sample's
  // applied bit determines the exit code (matches single-shot's
  // "last poll wins" contract).
  describe('--require-filter (tick 24 watch gating)', () => {
    it('exits 0 by default when last sample has applied=false (back-compat)', async () => {
      const r = await runWatch('rv_w_1', {
        server: 'https://test.local',
        'max-polls': '2',
      }, [makeFullBody({ applied: false }), makeFullBody({ applied: false })]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain('require-filter');
    });

    it('exits 3 when --require-filter is set AND last sample has applied=false', async () => {
      const r = await runWatch('rv_w_1', {
        server: 'https://test.local',
        'max-polls': '2',
        'require-filter': true,
      }, [makeFullBody({ applied: false }), makeFullBody({ applied: false })]);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain('--require-filter');
      expect(r.stderr).toContain('applied=false');
    });

    it('exits 0 when --require-filter is set AND last sample has applied=true (even if earlier samples did not)', async () => {
      // First sample applied=false, second sample applied=true.
      // "Last poll wins" -- gate clears even though the watch loop
      // saw an unfiltered snapshot along the way.
      const r = await runWatch('rv_w_1', {
        server: 'https://test.local',
        'max-polls': '2',
        'require-filter': true,
      }, [makeFullBody({ applied: false }), makeFullBody({ applied: true })]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain('require-filter');
    });
  });

  // Tick 25: --on-applied-change hook + --on-applied-template. Fires
  // on the transition edge of the persisted report's `applied` bit
  // (false->true OR true->false). The first poll never fires (no
  // prior to transition from).
  describe('--on-applied-change (tick 25)', () => {
    async function runWatchWithHook(
      reviewId: string,
      flags: Record<string, string | boolean>,
      bodies: string[],
      hookOutcome: { exitCode: number | null; stderr: string } = { exitCode: 0, stderr: '' },
    ): Promise<RunResult & { fetchCalls: string[]; hookCalls: Array<{ cmd: string; payload: string }> }> {
      const { runReviewFilterReportWatch } = await import('../src/commands/review.js');
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
      const fetchCalls: string[] = [];
      const hookCalls: Array<{ cmd: string; payload: string }> = [];
      let bodyIdx = 0;
      const fetcher = async (url: string) => {
        fetchCalls.push(url);
        const entry = bodies[bodyIdx] ?? bodies[bodies.length - 1]!;
        bodyIdx += 1;
        return { ok: true, status: 200, text: async () => entry };
      };
      const sleeper = async () => undefined;
      const onAppliedChangeExecer = async (cmd: string, payload: string) => {
        hookCalls.push({ cmd, payload });
        return hookOutcome;
      };
      process.exitCode = 0;
      try {
        await runReviewFilterReportWatch(
          {
            command: 'review',
            positional: ['filter-report'],
            flags: { 'no-color': true, watch: reviewId, ...flags },
          },
          reviewId,
          { fetcher, sleeper, onAppliedChangeExecer },
        );
      } finally {
        writeStdout.mockRestore();
        writeStderr.mockRestore();
      }
      const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
      process.exitCode = 0;
      return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code, fetchCalls, hookCalls };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('does NOT fire on the first poll (no prior to transition from)', async () => {
      const r = await runWatchWithHook('rv_w_1', {
        server: 'https://test.local',
        'max-polls': '1',
        'on-applied-change': 'echo applied-edge',
      }, [makeFullBody({ applied: true })]);
      expect(r.exitCode).toBe(0);
      expect(r.hookCalls).toHaveLength(0);
    });

    it('fires on the false->true transition edge', async () => {
      const r = await runWatchWithHook('rv_w_1', {
        server: 'https://test.local',
        'max-polls': '2',
        'on-applied-change': 'echo applied-edge',
      }, [makeFullBody({ applied: false }), makeFullBody({ applied: true })]);
      expect(r.exitCode).toBe(0);
      expect(r.hookCalls).toHaveLength(1);
      expect(r.hookCalls[0]!.cmd).toBe('echo applied-edge');
      const payload = JSON.parse(r.hookCalls[0]!.payload);
      expect(payload.reviewId).toBe('rv_w_1');
      expect(payload.poll).toBe(2);
      expect(payload.prevApplied).toBe(false);
      expect(payload.currentApplied).toBe(true);
    });

    it('fires on the true->false transition edge', async () => {
      const r = await runWatchWithHook('rv_w_1', {
        server: 'https://test.local',
        'max-polls': '2',
        'on-applied-change': 'echo unapplied-edge',
      }, [makeFullBody({ applied: true }), makeFullBody({ applied: false })]);
      expect(r.exitCode).toBe(0);
      expect(r.hookCalls).toHaveLength(1);
      const payload = JSON.parse(r.hookCalls[0]!.payload);
      expect(payload.prevApplied).toBe(true);
      expect(payload.currentApplied).toBe(false);
    });

    it('does NOT fire when applied stays the same (no transition)', async () => {
      const r = await runWatchWithHook('rv_w_1', {
        server: 'https://test.local',
        'max-polls': '3',
        'on-applied-change': 'echo edge',
      }, [makeFullBody({ applied: true }), makeFullBody({ applied: true }), makeFullBody({ applied: true })]);
      expect(r.exitCode).toBe(0);
      expect(r.hookCalls).toHaveLength(0);
    });

    it('fires multiple times on flapping (false->true->false->true)', async () => {
      const r = await runWatchWithHook('rv_w_1', {
        server: 'https://test.local',
        'max-polls': '4',
        'on-applied-change': 'echo flap',
      }, [
        makeFullBody({ applied: false }),
        makeFullBody({ applied: true }),
        makeFullBody({ applied: false }),
        makeFullBody({ applied: true }),
      ]);
      expect(r.exitCode).toBe(0);
      // Three transitions: false->true, true->false, false->true.
      expect(r.hookCalls).toHaveLength(3);
    });

    it('surfaces hook failure on stderr but keeps polling', async () => {
      const r = await runWatchWithHook('rv_w_1', {
        server: 'https://test.local',
        'max-polls': '2',
        'on-applied-change': 'false',
      }, [makeFullBody({ applied: false }), makeFullBody({ applied: true })], { exitCode: 1, stderr: 'mock fail' });
      // Watch finishes normally (exit 0); the hook misfire is reported
      // on stderr but doesn't abort the loop.
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('--on-applied-change exited 1');
      expect(r.hookCalls).toHaveLength(1);
    });

    it('rejects empty --on-applied-change command (typo guard)', async () => {
      const r = await runWatch('rv_w_1', {
        server: 'https://test.local',
        'on-applied-change': '   ',
      }, []);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--on-applied-change');
    });

    it('parseFilterReportWatchConfig: defaults onAppliedChange to null', async () => {
      const { parseFilterReportWatchConfig } = await import('../src/commands/review.js');
      const r = parseFilterReportWatchConfig({ server: 'http://x' });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') expect(r.onAppliedChange).toBeNull();
    });

    it('parseFilterReportWatchConfig: --on-applied-change parses to a non-null command', async () => {
      const { parseFilterReportWatchConfig } = await import('../src/commands/review.js');
      const r = parseFilterReportWatchConfig({ server: 'http://x', 'on-applied-change': 'echo hi' });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') expect(r.onAppliedChange).toBe('echo hi');
    });
  });

  // Tick 25: --on-applied-template slack|webhook expands to the
  // standard curl-to-webhook pipeline; mutex with --on-applied-change.
  describe('--on-applied-template (tick 25)', () => {
    it('expandOnAppliedTemplate: slack with $SLACK_APPLIED_WEBHOOK_URL builds the curl line', async () => {
      const { expandOnAppliedTemplate } = await import('../src/commands/review.js');
      const r = expandOnAppliedTemplate('slack', { SLACK_APPLIED_WEBHOOK_URL: 'https://hooks.slack.com/x' });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.command).toContain('curl');
        expect(r.command).toContain('https://hooks.slack.com/x');
        expect(r.command).toContain("'Content-Type: application/json'");
        expect(r.command).toContain('--data-binary @-');
      }
    });

    it('expandOnAppliedTemplate: slack falls back to $SLACK_WEBHOOK_URL when primary unset', async () => {
      const { expandOnAppliedTemplate } = await import('../src/commands/review.js');
      const r = expandOnAppliedTemplate('slack', { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/fallback' });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') expect(r.command).toContain('https://hooks.slack.com/fallback');
    });

    it('expandOnAppliedTemplate: webhook uses $WEBHOOK_APPLIED_URL primary', async () => {
      const { expandOnAppliedTemplate } = await import('../src/commands/review.js');
      const r = expandOnAppliedTemplate('webhook', { WEBHOOK_APPLIED_URL: 'https://hooks.example.com/x' });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') expect(r.command).toContain('https://hooks.example.com/x');
    });

    it('expandOnAppliedTemplate: webhook falls back to $WEBHOOK_URL', async () => {
      const { expandOnAppliedTemplate } = await import('../src/commands/review.js');
      const r = expandOnAppliedTemplate('webhook', { WEBHOOK_URL: 'https://generic/fallback' });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') expect(r.command).toContain('https://generic/fallback');
    });

    it('expandOnAppliedTemplate: rejects unknown template name with enumerated valid set', async () => {
      const { expandOnAppliedTemplate } = await import('../src/commands/review.js');
      const r = expandOnAppliedTemplate('discord', {});
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') {
        expect(r.message).toContain('discord');
        expect(r.message).toContain('slack');
        expect(r.message).toContain('webhook');
      }
    });

    it('expandOnAppliedTemplate: rejects when both primary AND fallback env vars are unset', async () => {
      const { expandOnAppliedTemplate } = await import('../src/commands/review.js');
      const r = expandOnAppliedTemplate('slack', {});
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') {
        expect(r.message).toContain('SLACK_APPLIED_WEBHOOK_URL');
        expect(r.message).toContain('SLACK_WEBHOOK_URL');
      }
    });

    it('parseFilterReportWatchConfig: --on-applied-template resolves to a curl command', async () => {
      // Set the env so the template expansion has a URL to bake in.
      process.env['SLACK_APPLIED_WEBHOOK_URL'] = 'https://hooks.slack.com/parse';
      try {
        const { parseFilterReportWatchConfig } = await import('../src/commands/review.js');
        const r = parseFilterReportWatchConfig({ server: 'http://x', 'on-applied-template': 'slack' });
        expect(r.kind).toBe('ok');
        if (r.kind === 'ok') {
          expect(r.onAppliedChange).toContain('curl');
          expect(r.onAppliedChange).toContain('https://hooks.slack.com/parse');
        }
      } finally {
        delete process.env['SLACK_APPLIED_WEBHOOK_URL'];
      }
    });

    it('parseFilterReportWatchConfig: --on-applied-template + --on-applied-change rejects with mutex error', async () => {
      process.env['SLACK_APPLIED_WEBHOOK_URL'] = 'https://hooks.slack.com/x';
      try {
        const { parseFilterReportWatchConfig } = await import('../src/commands/review.js');
        const r = parseFilterReportWatchConfig({
          server: 'http://x',
          'on-applied-change': 'echo a',
          'on-applied-template': 'slack',
        });
        expect(r.kind).toBe('invalid-on-applied-change');
        if (r.kind === 'invalid-on-applied-change') {
          expect(r.message).toContain('mutually exclusive');
        }
      } finally {
        delete process.env['SLACK_APPLIED_WEBHOOK_URL'];
      }
    });

    it('parseFilterReportWatchConfig: --on-applied-template with unset env vars surfaces clear error', async () => {
      const { parseFilterReportWatchConfig } = await import('../src/commands/review.js');
      // Ensure both env vars are unset.
      delete process.env['SLACK_APPLIED_WEBHOOK_URL'];
      delete process.env['SLACK_WEBHOOK_URL'];
      const r = parseFilterReportWatchConfig({ server: 'http://x', 'on-applied-template': 'slack' });
      expect(r.kind).toBe('invalid-on-applied-change');
    });

    it('ON_APPLIED_TEMPLATES is a closed slack|webhook tuple', async () => {
      const { ON_APPLIED_TEMPLATES } = await import('../src/commands/review.js');
      expect([...ON_APPLIED_TEMPLATES].sort()).toEqual(['slack', 'webhook']);
    });
  });
});

// Tick 25: `clawreview review filter-report --diff <baseReviewId> <targetReviewId>`
// two-review compare for the filter-report endpoint.
describe('clawreview review filter-report --diff (tick 25)', () => {
  async function runDiff(
    flags: Record<string, string | boolean>,
    bodies: { base: string; target: string },
    positional: string[] = ['filter-report'],
  ): Promise<RunResult & { fetchCalls: string[] }> {
    const { runReviewFilterReport } = await import('../src/commands/review.js');
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
    const fetchCalls: string[] = [];
    const fetcher = async (url: string) => {
      fetchCalls.push(url);
      if (url.includes('/api/reviews/') && url.includes('/filter-report')) {
        // Resolve which side by the review id substring.
        if (typeof flags.diff === 'string' && url.includes(encodeURIComponent(flags.diff))) {
          return { ok: true, status: 200, text: async () => bodies.base };
        }
        return { ok: true, status: 200, text: async () => bodies.target };
      }
      return { ok: false, status: 404, text: async () => '{}' };
    };
    process.exitCode = 0;
    try {
      await runReviewFilterReport(
        { command: 'review', positional, flags: { 'no-color': true, ...flags } },
        { fetcher },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code, fetchCalls };
  }

  function makeFullBody(opts: {
    reviewId?: string;
    applied?: boolean;
    inputTotal?: number;
    droppedTotal?: number;
    minConfidence?: { applied: boolean; normalised: number };
    severityThreshold?: { applied: boolean; normalised: string | null };
  } = {}): string {
    return JSON.stringify({
      reviewId: opts.reviewId ?? 'rv_diff_x',
      inputTotal: opts.inputTotal ?? 10,
      droppedTotal: opts.droppedTotal ?? 3,
      applied: opts.applied ?? true,
      slim: false,
      appliedFilters: {
        minConfidence: {
          raw: 0.5,
          normalised: opts.minConfidence?.normalised ?? 0.5,
          applied: opts.minConfidence?.applied ?? true,
        },
        severityThreshold: {
          raw: undefined,
          normalised: opts.severityThreshold?.normalised ?? null,
          applied: opts.severityThreshold?.applied ?? false,
        },
        any: opts.applied ?? true,
      },
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects --diff without --server', async () => {
    const r = await runDiff(
      { diff: 'rv_base_1' },
      { base: makeFullBody(), target: makeFullBody() },
      ['filter-report', 'rv_target_1'],
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--diff requires --server');
  });

  it('rejects --diff without a positional target reviewId', async () => {
    const r = await runDiff(
      { diff: 'rv_base_1', server: 'http://x' },
      { base: makeFullBody(), target: makeFullBody() },
      ['filter-report'],
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--diff requires a positional <targetReviewId>');
  });

  it('exits 0 when both bodies are identical (hasDelta=false)', async () => {
    const same = makeFullBody({ reviewId: 'X', inputTotal: 10, droppedTotal: 3 });
    const r = await runDiff(
      { diff: 'rv_base_1', server: 'http://x' },
      { base: same, target: same },
      ['filter-report', 'rv_target_1'],
    );
    expect(r.exitCode).toBe(0);
    // Text banner mentions both ids.
    expect(r.stdout).toContain('rv_base_1');
    expect(r.stdout).toContain('rv_target_1');
    expect(r.stdout).toContain('hasDelta');
    // Each axis is unchanged.
    expect(r.stdout).toContain('unchanged');
  });

  it('exits 3 with text output when inputTotal differs (CI gate fires)', async () => {
    const base = makeFullBody({ inputTotal: 10 });
    const target = makeFullBody({ inputTotal: 15 });
    const r = await runDiff(
      { diff: 'rv_base_1', server: 'http://x' },
      { base, target },
      ['filter-report', 'rv_target_1'],
    );
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('inputTotal');
    expect(r.stdout).toContain('10');
    expect(r.stdout).toContain('15');
    expect(r.stdout).toContain('changed');
  });

  it('exits 3 when min_confidence threshold changes', async () => {
    const base = makeFullBody({ minConfidence: { applied: true, normalised: 0.5 } });
    const target = makeFullBody({ minConfidence: { applied: true, normalised: 0.8 } });
    const r = await runDiff(
      { diff: 'rv_base_1', server: 'http://x' },
      { base, target },
      ['filter-report', 'rv_target_1'],
    );
    expect(r.exitCode).toBe(3);
    // Text output shows both thresholds.
    expect(r.stdout).toContain('0.5');
    expect(r.stdout).toContain('0.8');
  });

  it('exits 3 with json output and emits structured delta', async () => {
    const base = makeFullBody({ applied: true });
    const target = makeFullBody({ applied: false });
    const r = await runDiff(
      { diff: 'rv_base_1', server: 'http://x', format: 'json' },
      { base, target },
      ['filter-report', 'rv_target_1'],
    );
    expect(r.exitCode).toBe(3);
    const body = JSON.parse(r.stdout);
    expect(body.baseId).toBe('rv_base_1');
    expect(body.targetId).toBe('rv_target_1');
    expect(body.delta.applied.changed).toBe(true);
    expect(body.delta.applied.base).toBe(true);
    expect(body.delta.applied.target).toBe(false);
    expect(body.delta.hasDelta).toBe(true);
  });

  it('fetches both /filter-report endpoints in parallel', async () => {
    const r = await runDiff(
      { diff: 'rv_base_1', server: 'http://x' },
      { base: makeFullBody(), target: makeFullBody() },
      ['filter-report', 'rv_target_1'],
    );
    expect(r.exitCode).toBe(0);
    expect(r.fetchCalls).toHaveLength(2);
    // Both URLs are filter-report endpoints.
    expect(r.fetchCalls.every((u) => u.includes('/filter-report'))).toBe(true);
    // Both ids appear in the call set.
    expect(r.fetchCalls.some((u) => u.includes('rv_base_1'))).toBe(true);
    expect(r.fetchCalls.some((u) => u.includes('rv_target_1'))).toBe(true);
  });

  it('parseFilterReportDiffConfig: each error arm has a unique discriminant', async () => {
    const { parseFilterReportDiffConfig } = await import('../src/commands/review.js');
    expect(parseFilterReportDiffConfig({}).kind).toBe('missing-base');
    expect(parseFilterReportDiffConfig({ base: 'b' }).kind).toBe('missing-target');
    expect(parseFilterReportDiffConfig({ base: 'b', target: 't' }).kind).toBe('missing-server');
    expect(
      parseFilterReportDiffConfig({ base: 'b', target: 't', server: 'http://x', format: 'xml' }).kind,
    ).toBe('invalid-format');
    const ok = parseFilterReportDiffConfig({
      base: 'b',
      target: 't',
      server: 'http://x/',
      format: 'json',
    });
    expect(ok.kind).toBe('ok');
    if (ok.kind === 'ok') {
      expect(ok.serverUrl).toBe('http://x'); // trailing slash stripped
      expect(ok.format).toBe('json');
    }
  });

  it('computeFilterReportDelta: pure no-change pin', async () => {
    const { computeFilterReportDelta } = await import('../src/commands/review.js');
    const body = JSON.parse(makeFullBody());
    const d = computeFilterReportDelta(body, body);
    expect(d.hasDelta).toBe(false);
    expect(d.applied.changed).toBe(false);
    expect(d.inputTotal.delta).toBe(0);
    expect(d.droppedTotal.delta).toBe(0);
    expect(d.minConfidence.changed).toBe(false);
    expect(d.severityThreshold.changed).toBe(false);
  });

  it('computeFilterReportDelta: tolerates slim bodies (no appliedFilters)', async () => {
    const { computeFilterReportDelta } = await import('../src/commands/review.js');
    const slim = JSON.parse(JSON.stringify({
      reviewId: 'rv_slim', inputTotal: 10, droppedTotal: 3, applied: true, slim: true,
    }));
    const d = computeFilterReportDelta(slim, slim);
    // No appliedFilters on either side -> per-axis fields are
    // base=null/target=null with changed=false.
    expect(d.minConfidence.base).toBeNull();
    expect(d.minConfidence.target).toBeNull();
    expect(d.minConfidence.changed).toBe(false);
    expect(d.severityThreshold.changed).toBe(false);
    expect(d.hasDelta).toBe(false);
  });

  it('computeFilterReportDelta: dropped count delta surfaces as a signed number', async () => {
    const { computeFilterReportDelta } = await import('../src/commands/review.js');
    const base = JSON.parse(makeFullBody({ droppedTotal: 5 }));
    const target = JSON.parse(makeFullBody({ droppedTotal: 2 }));
    const d = computeFilterReportDelta(base, target);
    expect(d.droppedTotal.delta).toBe(-3);
    expect(d.droppedTotal.changed).toBe(true);
    expect(d.hasDelta).toBe(true);
  });

  it('routes HTTP 404 from base review to clear error message', async () => {
    const { runReviewFilterReport } = await import('../src/commands/review.js');
    const stderr: string[] = [];
    const writeStderr = vi.spyOn(process.stderr, 'write').mockImplementation(
      ((chunk: unknown) => {
        stderr.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
        return true;
      }) as never,
    );
    const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const fetcher = async (url: string) => {
      if (url.includes('rv_base_404')) {
        return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'NotFound' }) };
      }
      return { ok: true, status: 200, text: async () => makeFullBody() };
    };
    process.exitCode = 0;
    try {
      await runReviewFilterReport(
        {
          command: 'review',
          positional: ['filter-report', 'rv_target_x'],
          flags: { 'no-color': true, diff: 'rv_base_404', server: 'http://x' },
        },
        { fetcher },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    expect(process.exitCode).toBe(2);
    expect(stderr.join('')).toContain('rv_base_404');
    expect(stderr.join('')).toContain('HTTP 404');
    process.exitCode = 0;
  });

  // Tick 25: wired metrics tests for clawreview_review_filter_report_
  // diff_total{result}. Mirrors the tick-17 watch-metrics group: real
  // bundle from @clawreview/telemetry, scrape the registry text to
  // assert the closed-set {identical, delta, error} labels fired.
  describe('metrics (tick 25)', () => {
    async function runDiffWithMetrics(
      flags: Record<string, string | boolean>,
      bodies: { base: string; target: string },
      positional: string[],
    ): Promise<{ exitCode: number; metricsText: string }> {
      const { runReviewFilterReport } = await import('../src/commands/review.js');
      const { getMetrics, resetMetricsForTests } = await import('@clawreview/telemetry');
      resetMetricsForTests();
      const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
      // Silence stdout/stderr -- they're not under test here.
      const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
      const writeStderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
      const fetcher = async (url: string) => {
        if (typeof flags.diff === 'string' && url.includes(encodeURIComponent(flags.diff))) {
          return { ok: true, status: 200, text: async () => bodies.base };
        }
        return { ok: true, status: 200, text: async () => bodies.target };
      };
      process.exitCode = 0;
      try {
        await runReviewFilterReport(
          { command: 'review', positional, flags: { 'no-color': true, ...flags } },
          { fetcher, metrics },
        );
      } finally {
        writeStdout.mockRestore();
        writeStderr.mockRestore();
      }
      const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
      process.exitCode = 0;
      const metricsText = await metrics.registry.metrics();
      return { exitCode, metricsText };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fires the identical label on a no-delta diff (CLI exit 0)', async () => {
      const same = makeFullBody({ inputTotal: 10 });
      const r = await runDiffWithMetrics(
        { diff: 'rv_a', server: 'http://x' },
        { base: same, target: same },
        ['filter-report', 'rv_b'],
      );
      expect(r.exitCode).toBe(0);
      expect(r.metricsText).toMatch(
        /clawreview_review_filter_report_diff_total\{[^}]*result="identical"[^}]*\}\s*1/,
      );
    });

    it('fires the delta label on a non-empty diff (CLI exit 3)', async () => {
      const base = makeFullBody({ inputTotal: 10 });
      const target = makeFullBody({ inputTotal: 20 });
      const r = await runDiffWithMetrics(
        { diff: 'rv_a', server: 'http://x' },
        { base, target },
        ['filter-report', 'rv_b'],
      );
      expect(r.exitCode).toBe(3);
      expect(r.metricsText).toMatch(
        /clawreview_review_filter_report_diff_total\{[^}]*result="delta"[^}]*\}\s*1/,
      );
    });

    it('fires the error label on a config-error invocation', async () => {
      const { runReviewFilterReport } = await import('../src/commands/review.js');
      const { getMetrics, resetMetricsForTests } = await import('@clawreview/telemetry');
      resetMetricsForTests();
      const metrics = getMetrics({ service: 'clawreview-test', defaultMetrics: false });
      const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
      const writeStderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
      const fetcher = async () => ({ ok: true, status: 200, text: async () => makeFullBody() });
      process.exitCode = 0;
      try {
        // Missing --server triggers the config-error path which fires
        // result=error.
        await runReviewFilterReport(
          {
            command: 'review',
            positional: ['filter-report', 'rv_b'],
            flags: { 'no-color': true, diff: 'rv_a' },
          },
          { fetcher, metrics },
        );
      } finally {
        writeStdout.mockRestore();
        writeStderr.mockRestore();
      }
      expect(process.exitCode).toBe(2);
      const text = await metrics.registry.metrics();
      expect(text).toMatch(
        /clawreview_review_filter_report_diff_total\{[^}]*result="error"[^}]*\}\s*1/,
      );
      process.exitCode = 0;
    });
  });
});

// Tick 26: `clawreview review filter-report --diff --output <path|->`
// writes the JSON delta body to a file (or stdout when --output -)
// instead of printing it directly. Mirrors `presets diff --output`.
describe('clawreview review filter-report --diff --output (tick 26)', () => {
  async function runDiffWithOutput(
    flags: Record<string, string | boolean>,
    bodies: { base: string; target: string },
    positional: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { runReviewFilterReport } = await import('../src/commands/review.js');
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
    const fetcher = async (url: string) => {
      if (typeof flags.diff === 'string' && url.includes(encodeURIComponent(flags.diff))) {
        return { ok: true, status: 200, text: async () => bodies.base };
      }
      return { ok: true, status: 200, text: async () => bodies.target };
    };
    process.exitCode = 0;
    try {
      await runReviewFilterReport(
        { command: 'review', positional, flags: { 'no-color': true, ...flags } },
        { fetcher },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code };
  }

  function makeBody(opts: { applied?: boolean; inputTotal?: number; droppedTotal?: number } = {}): string {
    return JSON.stringify({
      reviewId: 'rv_x',
      inputTotal: opts.inputTotal ?? 10,
      droppedTotal: opts.droppedTotal ?? 3,
      applied: opts.applied ?? true,
      slim: false,
      appliedFilters: {
        minConfidence: { raw: 0.5, normalised: 0.5, applied: true },
        severityThreshold: { raw: undefined, normalised: null, applied: false },
        any: true,
      },
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--output <file> writes the JSON delta body to disk (no stdout output, stderr breadcrumb)', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'delta.json');
    const base = makeBody({ inputTotal: 10 });
    const target = makeBody({ inputTotal: 15 });
    const r = await runDiffWithOutput(
      { diff: 'rv_base_1', server: 'http://x', format: 'json', output: path },
      { base, target },
      ['filter-report', 'rv_target_1'],
    );
    // Delta detected -> exit 3.
    expect(r.exitCode).toBe(3);
    // Stdout has NO JSON body (the artifact landed on disk).
    expect(r.stdout).toBe('');
    // Stderr surfaces the wrote-bytes breadcrumb so a CI log can confirm.
    expect(r.stderr).toContain('wrote ');
    expect(r.stderr).toContain('delta.json');
    // The file on disk holds the JSON body with both ids and the delta.
    const { readFile } = await import('node:fs/promises');
    const written = await readFile(path, 'utf8');
    const parsed = JSON.parse(written);
    expect(parsed.baseId).toBe('rv_base_1');
    expect(parsed.targetId).toBe('rv_target_1');
    expect(parsed.delta.hasDelta).toBe(true);
    expect(parsed.delta.inputTotal.delta).toBe(5);
  });

  it('--output - writes the body to stdout in pure mode (no banner, no stderr)', async () => {
    const r = await runDiffWithOutput(
      { diff: 'rv_base_1', server: 'http://x', format: 'json', output: '-' },
      { base: makeBody({ inputTotal: 10 }), target: makeBody({ inputTotal: 12 }) },
      ['filter-report', 'rv_target_1'],
    );
    expect(r.exitCode).toBe(3);
    // Stdout holds the JSON body (pure mode -- no preamble).
    const parsed = JSON.parse(r.stdout);
    expect(parsed.delta.inputTotal.delta).toBe(2);
    // No stderr breadcrumb on the stdout sentinel path.
    expect(r.stderr).not.toContain('wrote ');
  });

  it('--output with --format text rejects with exit 2 (text is for terminals, not artifacts)', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'delta.txt');
    const r = await runDiffWithOutput(
      { diff: 'rv_base_1', server: 'http://x', format: 'text', output: path },
      { base: makeBody(), target: makeBody() },
      ['filter-report', 'rv_target_1'],
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--output is incompatible with --format text');
    // No file written.
    const { stat } = await import('node:fs/promises');
    await expect(stat(path)).rejects.toThrow();
  });

  it('--output creates parent directories (mkdir -p)', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'nested', 'a', 'b', 'delta.json');
    const r = await runDiffWithOutput(
      { diff: 'rv_base_1', server: 'http://x', format: 'json', output: path },
      { base: makeBody(), target: makeBody() },
      ['filter-report', 'rv_target_1'],
    );
    // identical bodies -> exit 0, no delta.
    expect(r.exitCode).toBe(0);
    const { readFile } = await import('node:fs/promises');
    const written = await readFile(path, 'utf8');
    expect(JSON.parse(written).delta.hasDelta).toBe(false);
  });

  it('--output empty-delta still writes the file (carries hasDelta:false body)', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'empty.json');
    const r = await runDiffWithOutput(
      { diff: 'rv_base_1', server: 'http://x', format: 'json', output: path },
      { base: makeBody(), target: makeBody() },
      ['filter-report', 'rv_target_1'],
    );
    expect(r.exitCode).toBe(0);
    const { readFile } = await import('node:fs/promises');
    const written = await readFile(path, 'utf8');
    const parsed = JSON.parse(written);
    expect(parsed.delta.hasDelta).toBe(false);
  });

  it('resolveFilterReportDiffOutputPath: pure helper -- absolute paths pass through, relative resolved against cwd, "-" maps to sentinel', async () => {
    const { resolveFilterReportDiffOutputPath, FILTER_REPORT_DIFF_STDOUT_SENTINEL } = await import(
      '../src/commands/review.js'
    );
    // Absolute pass-through.
    expect(resolveFilterReportDiffOutputPath('/tmp/x.json', '/etc')).toBe('/tmp/x.json');
    // Relative resolves against cwd arg.
    expect(resolveFilterReportDiffOutputPath('x.json', '/home/sanjay')).toBe('/home/sanjay/x.json');
    // Sentinel.
    expect(resolveFilterReportDiffOutputPath('-', '/anywhere')).toBe(
      FILTER_REPORT_DIFF_STDOUT_SENTINEL,
    );
  });

  it('--output sentinel byte-identical to file-write body (matches contract)', async () => {
    // The whole point of having a sentinel + path mode is that a
    // CI consumer can swap one for the other without changing the
    // parsing code. Pin that the bytes are identical (modulo path).
    const dir = await tmpDir();
    const path = join(dir, 'identity.json');
    const base = makeBody({ inputTotal: 10 });
    const target = makeBody({ inputTotal: 15 });
    const stdoutMode = await runDiffWithOutput(
      { diff: 'rv_a', server: 'http://x', format: 'json', output: '-' },
      { base, target },
      ['filter-report', 'rv_b'],
    );
    await runDiffWithOutput(
      { diff: 'rv_a', server: 'http://x', format: 'json', output: path },
      { base, target },
      ['filter-report', 'rv_b'],
    );
    const { readFile } = await import('node:fs/promises');
    const fileContent = await readFile(path, 'utf8');
    // Stdout body == file body (byte-identical).
    expect(stdoutMode.stdout).toBe(fileContent);
  });
});

// Tick 26: `clawreview review filter-report --diff --json-stream` emits
// a 7-line newline-delimited JSON stream instead of a single multi-line
// JSON body. Mirrors `stats --jsonl` for log-aggregator pipelines.
describe('clawreview review filter-report --diff --json-stream (tick 26)', () => {
  async function runDiffStream(
    flags: Record<string, string | boolean>,
    bodies: { base: string; target: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { runReviewFilterReport } = await import('../src/commands/review.js');
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
    const fetcher = async (url: string) => {
      if (typeof flags.diff === 'string' && url.includes(encodeURIComponent(flags.diff))) {
        return { ok: true, status: 200, text: async () => bodies.base };
      }
      return { ok: true, status: 200, text: async () => bodies.target };
    };
    process.exitCode = 0;
    try {
      await runReviewFilterReport(
        {
          command: 'review',
          positional: ['filter-report', 'rv_target_x'],
          flags: { 'no-color': true, ...flags },
        },
        { fetcher },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code };
  }

  function makeBody(opts: { applied?: boolean; inputTotal?: number; droppedTotal?: number } = {}): string {
    return JSON.stringify({
      reviewId: 'rv_x',
      inputTotal: opts.inputTotal ?? 10,
      droppedTotal: opts.droppedTotal ?? 3,
      applied: opts.applied ?? true,
      slim: false,
      appliedFilters: {
        minConfidence: { raw: 0.5, normalised: 0.5, applied: true },
        severityThreshold: { raw: undefined, normalised: null, applied: false },
        any: true,
      },
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits exactly 7 lines (header + 5 axes + footer) when --json-stream + --format json', async () => {
    const r = await runDiffStream(
      { diff: 'rv_base_1', server: 'http://x', format: 'json', 'json-stream': true },
      { base: makeBody({ inputTotal: 10 }), target: makeBody({ inputTotal: 15 }) },
    );
    expect(r.exitCode).toBe(3);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(7);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].kind).toBe('header');
    expect(parsed[0].baseId).toBe('rv_base_1');
    expect(parsed[0].targetId).toBe('rv_target_x');
    expect(parsed[1].kind).toBe('axis');
    expect(parsed[1].name).toBe('applied');
    expect(parsed[2].name).toBe('inputTotal');
    expect(parsed[3].name).toBe('droppedTotal');
    expect(parsed[4].name).toBe('minConfidence');
    expect(parsed[5].name).toBe('severityThreshold');
    expect(parsed[6].kind).toBe('footer');
    expect(parsed[6].hasDelta).toBe(true);
  });

  it('inputTotal axis line carries base, target, and signed delta', async () => {
    const r = await runDiffStream(
      { diff: 'rv_base_1', server: 'http://x', format: 'json', 'json-stream': true },
      { base: makeBody({ inputTotal: 20 }), target: makeBody({ inputTotal: 15 }) },
    );
    const lines = r.stdout.trim().split('\n');
    const axis = lines.map((l) => JSON.parse(l)).find((p) => p.name === 'inputTotal');
    expect(axis.base).toBe(20);
    expect(axis.target).toBe(15);
    expect(axis.delta).toBe(-5);
    expect(axis.changed).toBe(true);
  });

  it('--json-stream without --format json is a no-op (back-compat: still emits the multi-line body)', async () => {
    const r = await runDiffStream(
      { diff: 'rv_base_1', server: 'http://x', format: 'text', 'json-stream': true },
      { base: makeBody(), target: makeBody({ inputTotal: 15 }) },
    );
    // Falls through to text-mode renderer.
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('filter-report diff');
    // No JSONL output.
    expect(r.stdout.split('\n').filter((l) => l.startsWith('{')).length).toBe(0);
  });

  it('--json-stream + --format json (no other flags) emits the stream by default', async () => {
    // The default stdout path -- no --output -- still routes through
    // the stream renderer when --json-stream is set with --format json.
    const r = await runDiffStream(
      { diff: 'rv_base_1', server: 'http://x', format: 'json', 'json-stream': true },
      { base: makeBody(), target: makeBody() },
    );
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(7);
    const footer = JSON.parse(lines[6]!);
    expect(footer.hasDelta).toBe(false);
  });

  it('--json-stream composes with --output (stream lands on disk verbatim)', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'stream.jsonl');
    const r = await runDiffStream(
      {
        diff: 'rv_base_1',
        server: 'http://x',
        format: 'json',
        'json-stream': true,
        output: path,
      },
      { base: makeBody({ inputTotal: 10 }), target: makeBody({ inputTotal: 15 }) },
    );
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe('');
    const { readFile } = await import('node:fs/promises');
    const written = await readFile(path, 'utf8');
    expect(written.trim().split('\n')).toHaveLength(7);
    // First line is the header.
    expect(JSON.parse(written.split('\n')[0]!).kind).toBe('header');
  });

  it('renderFilterReportDiffJsonStream: pure helper produces stable line ordering', async () => {
    const { renderFilterReportDiffJsonStream, computeFilterReportDelta } = await import(
      '../src/commands/review.js'
    );
    const base = JSON.parse(makeBody({ inputTotal: 5 }));
    const target = JSON.parse(makeBody({ inputTotal: 10 }));
    const delta = computeFilterReportDelta(base, target);
    const stream = renderFilterReportDiffJsonStream('rv_a', 'rv_b', delta);
    const lines = stream.trim().split('\n');
    // Stable ordering: header, applied, inputTotal, droppedTotal, minConfidence, severityThreshold, footer.
    const names = lines.map((l) => {
      const p = JSON.parse(l);
      return p.kind === 'axis' ? p.name : p.kind;
    });
    expect(names).toEqual([
      'header',
      'applied',
      'inputTotal',
      'droppedTotal',
      'minConfidence',
      'severityThreshold',
      'footer',
    ]);
  });
});

// Tick 26: `clawreview review filter-report --diff --on-delta <cmd>` +
// `--on-delta-template slack|webhook` hook fires when computeFilterReportDelta
// surfaces a non-empty delta. Mirror of --on-applied-change for the
// diff command surface.
describe('clawreview review filter-report --diff --on-delta hook (tick 26)', () => {
  async function runDiffWithHook(
    flags: Record<string, string | boolean>,
    bodies: { base: string; target: string },
    onDeltaExecer: (cmd: string, payload: string) => Promise<{ exitCode: number | null; stderr: string }>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { runReviewFilterReport } = await import('../src/commands/review.js');
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
    const fetcher = async (url: string) => {
      if (typeof flags.diff === 'string' && url.includes(encodeURIComponent(flags.diff))) {
        return { ok: true, status: 200, text: async () => bodies.base };
      }
      return { ok: true, status: 200, text: async () => bodies.target };
    };
    process.exitCode = 0;
    try {
      await runReviewFilterReport(
        {
          command: 'review',
          positional: ['filter-report', 'rv_target_h'],
          flags: { 'no-color': true, ...flags },
        },
        { fetcher, onDeltaExecer },
      );
    } finally {
      writeStdout.mockRestore();
      writeStderr.mockRestore();
    }
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0;
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code };
  }

  function makeBody(opts: { applied?: boolean; inputTotal?: number; droppedTotal?: number } = {}): string {
    return JSON.stringify({
      reviewId: 'rv_x',
      inputTotal: opts.inputTotal ?? 10,
      droppedTotal: opts.droppedTotal ?? 3,
      applied: opts.applied ?? true,
      slim: false,
      appliedFilters: {
        minConfidence: { raw: 0.5, normalised: 0.5, applied: true },
        severityThreshold: { raw: undefined, normalised: null, applied: false },
        any: true,
      },
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires --on-delta exactly once when delta detected (payload carries baseId/targetId/delta)', async () => {
    const calls: Array<{ cmd: string; payload: string }> = [];
    const execer = async (cmd: string, payload: string) => {
      calls.push({ cmd, payload });
      return { exitCode: 0, stderr: '' };
    };
    const r = await runDiffWithHook(
      {
        diff: 'rv_base_h',
        server: 'http://x',
        format: 'json',
        'on-delta': 'curl -X POST https://hook.example',
      },
      { base: makeBody({ inputTotal: 10 }), target: makeBody({ inputTotal: 15 }) },
      execer,
    );
    expect(r.exitCode).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('curl -X POST https://hook.example');
    const payload = JSON.parse(calls[0]!.payload);
    expect(payload.baseId).toBe('rv_base_h');
    expect(payload.targetId).toBe('rv_target_h');
    expect(payload.delta.hasDelta).toBe(true);
    expect(payload.delta.inputTotal.delta).toBe(5);
  });

  it('does NOT fire --on-delta when bodies are identical (no-delta = no notify)', async () => {
    const calls: Array<{ cmd: string; payload: string }> = [];
    const execer = async (cmd: string, payload: string) => {
      calls.push({ cmd, payload });
      return { exitCode: 0, stderr: '' };
    };
    const r = await runDiffWithHook(
      {
        diff: 'rv_base_h',
        server: 'http://x',
        format: 'json',
        'on-delta': 'curl -X POST https://hook.example',
      },
      { base: makeBody(), target: makeBody() },
      execer,
    );
    expect(r.exitCode).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('hook non-zero exit surfaces on stderr but does NOT change the diff exit code', async () => {
    const execer = async () => ({ exitCode: 7, stderr: 'webhook down' });
    const r = await runDiffWithHook(
      {
        diff: 'rv_base_h',
        server: 'http://x',
        format: 'json',
        'on-delta': 'curl -X POST https://broken',
      },
      { base: makeBody({ inputTotal: 10 }), target: makeBody({ inputTotal: 15 }) },
      execer,
    );
    // Diff itself succeeded -> exit 3 (delta detected).
    expect(r.exitCode).toBe(3);
    // Hook failure surfaced.
    expect(r.stderr).toContain('--on-delta exited 7');
    expect(r.stderr).toContain('webhook down');
  });

  it('hook executor throwing surfaces on stderr but does NOT crash the diff', async () => {
    const execer = async () => {
      throw new Error('ENOENT: spawn curl');
    };
    const r = await runDiffWithHook(
      {
        diff: 'rv_base_h',
        server: 'http://x',
        format: 'json',
        'on-delta': 'curl -X POST https://x',
      },
      { base: makeBody({ inputTotal: 10 }), target: makeBody({ inputTotal: 15 }) },
      execer,
    );
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('--on-delta failed');
    expect(r.stderr).toContain('ENOENT');
  });

  it('--on-delta + --on-delta-template rejects 2 (mutex)', async () => {
    const execer = async () => ({ exitCode: 0, stderr: '' });
    const r = await runDiffWithHook(
      {
        diff: 'rv_base_h',
        server: 'http://x',
        format: 'json',
        'on-delta': 'curl ...',
        'on-delta-template': 'slack',
      },
      { base: makeBody(), target: makeBody() },
      execer,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('mutually exclusive');
  });

  it('--on-delta empty string rejects 2 (typo guard)', async () => {
    const execer = async () => ({ exitCode: 0, stderr: '' });
    const r = await runDiffWithHook(
      {
        diff: 'rv_base_h',
        server: 'http://x',
        format: 'json',
        'on-delta': '   ',
      },
      { base: makeBody(), target: makeBody() },
      execer,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('non-empty command');
  });

  it('--on-delta-template slack expands using SLACK_DELTA_WEBHOOK_URL (primary)', async () => {
    const orig = { ...process.env };
    process.env.SLACK_DELTA_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/X';
    delete process.env.SLACK_WEBHOOK_URL;
    const calls: Array<{ cmd: string }> = [];
    const execer = async (cmd: string) => {
      calls.push({ cmd });
      return { exitCode: 0, stderr: '' };
    };
    try {
      const r = await runDiffWithHook(
        {
          diff: 'rv_base_h',
          server: 'http://x',
          format: 'json',
          'on-delta-template': 'slack',
        },
        { base: makeBody({ inputTotal: 10 }), target: makeBody({ inputTotal: 15 }) },
        execer,
      );
      expect(r.exitCode).toBe(3);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cmd).toContain('curl');
      expect(calls[0]!.cmd).toContain('https://hooks.slack.com/services/T/B/X');
      expect(calls[0]!.cmd).toContain('Content-Type: application/json');
    } finally {
      process.env = orig;
    }
  });

  it('--on-delta-template falls back from primary to shared env var (SLACK_WEBHOOK_URL)', async () => {
    const orig = { ...process.env };
    delete process.env.SLACK_DELTA_WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = 'https://shared.slack.example/hook';
    const calls: Array<{ cmd: string }> = [];
    const execer = async (cmd: string) => {
      calls.push({ cmd });
      return { exitCode: 0, stderr: '' };
    };
    try {
      const r = await runDiffWithHook(
        {
          diff: 'rv_base_h',
          server: 'http://x',
          format: 'json',
          'on-delta-template': 'slack',
        },
        { base: makeBody({ inputTotal: 10 }), target: makeBody({ inputTotal: 15 }) },
        execer,
      );
      expect(r.exitCode).toBe(3);
      expect(calls[0]!.cmd).toContain('https://shared.slack.example/hook');
    } finally {
      process.env = orig;
    }
  });

  it('--on-delta-template slack with no env vars rejects 2 with hint', async () => {
    const orig = { ...process.env };
    delete process.env.SLACK_DELTA_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    const execer = async () => ({ exitCode: 0, stderr: '' });
    try {
      const r = await runDiffWithHook(
        {
          diff: 'rv_base_h',
          server: 'http://x',
          format: 'json',
          'on-delta-template': 'slack',
        },
        { base: makeBody(), target: makeBody() },
        execer,
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('SLACK_DELTA_WEBHOOK_URL');
      expect(r.stderr).toContain('SLACK_WEBHOOK_URL');
    } finally {
      process.env = orig;
    }
  });

  it('expandOnDeltaTemplate: pure helper -- slack arm prefers primary over fallback', async () => {
    const { expandOnDeltaTemplate } = await import('../src/commands/review.js');
    const r = expandOnDeltaTemplate('slack', {
      SLACK_DELTA_WEBHOOK_URL: 'https://primary',
      SLACK_WEBHOOK_URL: 'https://fallback',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.command).toContain('https://primary');
    }
  });

  it('expandOnDeltaTemplate: webhook arm with neither env var rejects with hint', async () => {
    const { expandOnDeltaTemplate } = await import('../src/commands/review.js');
    const r = expandOnDeltaTemplate('webhook', {});
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.message).toContain('WEBHOOK_DELTA_URL');
      expect(r.message).toContain('WEBHOOK_URL');
    }
  });

  it('expandOnDeltaTemplate: unknown name rejects with enumerated list', async () => {
    const { expandOnDeltaTemplate, ON_DELTA_TEMPLATES } = await import('../src/commands/review.js');
    const r = expandOnDeltaTemplate('discord', { SLACK_WEBHOOK_URL: 'x' });
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.message).toContain('discord');
      expect(r.message).toContain(ON_DELTA_TEMPLATES.join(', '));
    }
  });

  it('parseOnDeltaFlags: absent when neither flag set', async () => {
    const { parseOnDeltaFlags } = await import('../src/commands/review.js');
    expect(parseOnDeltaFlags({}, {}).kind).toBe('absent');
  });

  it('ON_DELTA_TEMPLATES is the closed tuple [slack, webhook]', async () => {
    const { ON_DELTA_TEMPLATES } = await import('../src/commands/review.js');
    expect(ON_DELTA_TEMPLATES).toEqual(['slack', 'webhook']);
  });
});



