import { describe, it, expect } from 'vitest';

import type { ReviewRecord, StoredFinding } from '../src/services/review-store.js';
import { computeSlaBreaches, DEFAULT_SLA_POLICY } from '../src/services/sla.js';

function finding(over: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id: 'f1',
    reviewId: 'rv_1',
    state: 'open',
    fingerprint: 'fp1',
    agent: 'security',
    category: 'security',
    severity: 'high',
    title: 'Tainted SQL',
    rationale: 'r',
    file: 'src/u.ts',
    startLine: 10,
    confidence: 0.8,
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
    prNumber: 42,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.000Z',
    totalFindings: findings.length,
    totalCostUsd: 0,
    agentExecutions: [],
    findings,
    ...over,
  } as ReviewRecord;
}

const NOW = new Date('2026-01-10T00:00:00.000Z'); // 9 days later

describe('computeSlaBreaches', () => {
  it('flags findings older than their severity SLA', () => {
    const r = review({}, [
      finding({ severity: 'high', id: 'f_high' }),
      finding({ severity: 'low', id: 'f_low' }),
      finding({ severity: 'nit', id: 'f_nit' }),
    ]);
    const out = computeSlaBreaches([r], { now: NOW });
    // 9 days = 216h. high SLA=72h -> breach. low SLA=336h -> ok.
    // nit SLA=720h -> ok.
    expect(out.totalOpen).toBe(3);
    expect(out.totalBreached).toBe(1);
    expect(out.breaches[0].findingId).toBe('f_high');
    expect(out.breaches[0].overdueHours).toBeCloseTo(216 - 72, 1);
    expect(out.breachedBySeverity.high).toBe(1);
  });

  it('ignores dismissed findings', () => {
    const r = review({}, [finding({ state: 'dismissed' })]);
    const out = computeSlaBreaches([r], { now: NOW });
    expect(out.totalOpen).toBe(0);
    expect(out.totalBreached).toBe(0);
  });

  it('sorts most overdue first and respects limit', () => {
    const r = review({}, [
      finding({ id: 'old', severity: 'critical' }), // SLA 24h, age 216h -> overdue 192h
      finding({ id: 'mid', severity: 'high' }),     // overdue 144h
    ]);
    const out = computeSlaBreaches([r], { now: NOW, limit: 1 });
    expect(out.breaches).toHaveLength(1);
    expect(out.breaches[0].findingId).toBe('old');
    expect(out.totalBreached).toBe(2); // total counts ignore limit
  });

  it('honors policy override', () => {
    const r = review({}, [finding({ severity: 'high' })]);
    const out = computeSlaBreaches([r], { now: NOW, policy: { high: 1000 } });
    expect(out.totalBreached).toBe(0);
    expect(out.policy.high).toBe(1000);
    expect(out.policy.critical).toBe(DEFAULT_SLA_POLICY.critical);
  });

  it('uses completedAt over createdAt for age', () => {
    const r = review({ createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-09T23:00:00.000Z' }, [
      finding({ severity: 'high' }),
    ]);
    // Age = 1h vs SLA 72h -> no breach
    const out = computeSlaBreaches([r], { now: NOW });
    expect(out.totalBreached).toBe(0);
  });
});
