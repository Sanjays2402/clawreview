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
