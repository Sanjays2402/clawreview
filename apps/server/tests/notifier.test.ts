import { describe, it, expect, beforeEach } from 'vitest';

import type { ReviewRecord, StoredFinding } from '../src/services/review-store.js';
import {
  ReviewNotifier,
  buildPayload,
  sign,
  verifySignature,
} from '../src/services/notifier.js';

function finding(over: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id: 'f1',
    reviewId: 'rv_1',
    state: 'open',
    fingerprint: 'fp1',
    agent: 'security',
    category: 'security',
    severity: 'high',
    title: 't',
    rationale: 'r',
    file: 'src/x.ts',
    startLine: 1,
    confidence: 0.7,
    tags: [],
    ...over,
  } as StoredFinding;
}

function review(over: Partial<ReviewRecord> = {}, findings: StoredFinding[] = []): ReviewRecord {
  return {
    id: 'rv_1',
    installationId: 1,
    owner: 'acme',
    repo: 'web',
    prNumber: 9,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    status: 'completed',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:00Z',
    totalFindings: findings.length,
    totalCostUsd: 0,
    agentExecutions: [],
    findings,
    ...over,
  } as ReviewRecord;
}

describe('buildPayload', () => {
  it('counts open findings only and picks worst severity', () => {
    const rec = review({}, [
      finding({ severity: 'medium' }),
      finding({ severity: 'critical', id: 'f2' }),
      finding({ severity: 'high', id: 'f3', state: 'dismissed' }),
    ]);
    const p = buildPayload(rec, 'review.completed');
    expect(p.openFindings).toBe(2);
    expect(p.worstSeverity).toBe('critical');
    expect(p.bySeverity.critical).toBe(1);
    expect(p.bySeverity.medium).toBe(1);
    expect(p.bySeverity.high).toBe(0);
  });

  it('worstSeverity is null with no open findings', () => {
    const p = buildPayload(review(), 'review.completed');
    expect(p.worstSeverity).toBeNull();
  });
});

describe('sign/verifySignature', () => {
  it('round-trips with the right secret', () => {
    const ts = '1700000000';
    const body = '{"a":1}';
    const sig = sign(ts, body, 'topsecret');
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifySignature(sig, ts, body, 'topsecret')).toBe(true);
    expect(verifySignature(sig, ts, body, 'wrong')).toBe(false);
    expect(verifySignature(sig, ts, '{"a":2}', 'topsecret')).toBe(false);
  });
});

describe('ReviewNotifier', () => {
  let calls: Array<{ url: string; init: RequestInit }>;
  beforeEach(() => { calls = []; });

  function fakeFetch(status = 200): typeof fetch {
    return (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response('ok', { status });
    }) as unknown as typeof fetch;
  }

  it('skips when url is empty', async () => {
    const n = new ReviewNotifier({ url: '' });
    const res = await n.notify(review({}, [finding({ severity: 'critical' })]));
    expect(res).toEqual({ delivered: false, skipped: 'no-url' });
  });

  it('skips completed reviews below the min severity threshold', async () => {
    const n = new ReviewNotifier({
      url: 'http://hook',
      minSeverity: 'high',
      fetchImpl: fakeFetch(),
    });
    const res = await n.notify(review({}, [finding({ severity: 'medium' })]));
    expect(res.skipped).toBe('below-threshold');
    expect(calls).toHaveLength(0);
  });

  it('delivers, signs, and reports HTTP status', async () => {
    const n = new ReviewNotifier({
      url: 'http://hook',
      secret: 's3cret',
      minSeverity: 'medium',
      fetchImpl: fakeFetch(202),
      now: () => 1700000000000,
    });
    const res = await n.notify(review({}, [finding({ severity: 'high' })]));
    expect(res.delivered).toBe(true);
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-clawreview-event']).toBe('review.completed');
    expect(headers['x-clawreview-signature']?.startsWith('sha256=')).toBe(true);
    expect(headers['x-clawreview-timestamp']).toBe('1700000000000');
    // Signature must verify against the actual body posted.
    const body = String(calls[0]!.init.body);
    expect(
      verifySignature(headers['x-clawreview-signature']!, headers['x-clawreview-timestamp']!, body, 's3cret'),
    ).toBe(true);
  });

  it('respects notifyOnFailure=false for failed reviews', async () => {
    const n = new ReviewNotifier({
      url: 'http://hook',
      notifyOnFailure: false,
      fetchImpl: fakeFetch(),
    });
    const res = await n.notify(review({ status: 'failed', error: 'boom' }));
    expect(res.skipped).toBe('not-on-failure');
  });

  it('always fires for failures when notifyOnFailure is true (no threshold check)', async () => {
    const n = new ReviewNotifier({
      url: 'http://hook',
      notifyOnFailure: true,
      minSeverity: 'critical',
      fetchImpl: fakeFetch(),
    });
    const res = await n.notify(review({ status: 'failed', error: 'boom' }));
    expect(res.delivered).toBe(true);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.event).toBe('review.failed');
    expect(body.error).toBe('boom');
  });

  it('returns an error on non-2xx', async () => {
    const n = new ReviewNotifier({ url: 'http://hook', fetchImpl: fakeFetch(500), minSeverity: 'low' });
    const res = await n.notify(review({}, [finding({ severity: 'high' })]));
    expect(res.delivered).toBe(false);
    expect(res.status).toBe(500);
    expect(res.error).toContain('500');
  });

  it('catches fetch exceptions', async () => {
    const n = new ReviewNotifier({
      url: 'http://hook',
      fetchImpl: (async () => { throw new Error('econnrefused'); }) as unknown as typeof fetch,
      minSeverity: 'low',
    });
    const res = await n.notify(review({}, [finding({ severity: 'high' })]));
    expect(res.delivered).toBe(false);
    expect(res.error).toBe('econnrefused');
  });
});
