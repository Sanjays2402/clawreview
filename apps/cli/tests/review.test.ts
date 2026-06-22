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
