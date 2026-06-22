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


