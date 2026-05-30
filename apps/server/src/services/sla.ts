import type { Severity } from '@clawreview/types';

import type { ReviewRecord, StoredFinding } from './review-store.js';

export interface SlaPolicy {
  /** Hours allowed for a finding of this severity to remain open. */
  critical: number;
  high: number;
  medium: number;
  low: number;
  nit: number;
}

export const DEFAULT_SLA_POLICY: SlaPolicy = {
  critical: 24,
  high: 72,
  medium: 24 * 7,
  low: 24 * 14,
  nit: 24 * 30,
};

export interface SlaBreach {
  reviewId: string;
  owner: string;
  repo: string;
  prNumber: number;
  findingId: string;
  fingerprint: string;
  severity: Severity;
  file: string;
  startLine: number;
  title: string;
  ageHours: number;
  slaHours: number;
  /** Hours past SLA. ageHours - slaHours. */
  overdueHours: number;
}

export interface SlaSummary {
  policy: SlaPolicy;
  totalOpen: number;
  totalBreached: number;
  breachedBySeverity: Record<Severity, number>;
  breaches: SlaBreach[];
}

export interface ComputeSlaOptions {
  /** Override the SLA policy. Falls back to DEFAULT_SLA_POLICY. */
  policy?: Partial<SlaPolicy>;
  /** Reference time for "now". Defaults to Date.now(). Useful for tests. */
  now?: Date;
  /** Cap the breaches list to this many entries; 0 = unlimited. */
  limit?: number;
}

/**
 * Compute SLA breaches across a set of reviews.
 *
 * "Age" for a finding is measured from the parent review's completedAt
 * (falling back to createdAt) up to `now`. Dismissed findings are
 * excluded; only open findings can breach SLA. The result is sorted with
 * the most overdue items first so dashboards and notifiers can surface
 * them without re-sorting.
 */
export function computeSlaBreaches(
  reviews: ReviewRecord[],
  opts: ComputeSlaOptions = {},
): SlaSummary {
  const policy: SlaPolicy = { ...DEFAULT_SLA_POLICY, ...(opts.policy ?? {}) };
  const now = (opts.now ?? new Date()).getTime();
  const breaches: SlaBreach[] = [];
  let totalOpen = 0;

  for (const r of reviews) {
    const refTs = Date.parse(r.completedAt ?? r.createdAt);
    if (!Number.isFinite(refTs)) continue;
    const ageHours = (now - refTs) / (1000 * 60 * 60);
    for (const f of r.findings) {
      if (f.state !== 'open') continue;
      totalOpen += 1;
      const slaHours = policy[f.severity];
      if (ageHours <= slaHours) continue;
      breaches.push(makeBreach(r, f, ageHours, slaHours));
    }
  }

  breaches.sort((a, b) => b.overdueHours - a.overdueHours);
  const capped = opts.limit && opts.limit > 0 ? breaches.slice(0, opts.limit) : breaches;

  const bySev: Record<Severity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, nit: 0,
  };
  for (const b of breaches) bySev[b.severity] += 1;

  return {
    policy,
    totalOpen,
    totalBreached: breaches.length,
    breachedBySeverity: bySev,
    breaches: capped,
  };
}

function makeBreach(
  r: ReviewRecord,
  f: StoredFinding,
  ageHours: number,
  slaHours: number,
): SlaBreach {
  return {
    reviewId: r.id,
    owner: r.owner,
    repo: r.repo,
    prNumber: r.prNumber,
    findingId: f.id,
    fingerprint: f.fingerprint,
    severity: f.severity,
    file: f.file,
    startLine: f.startLine,
    title: f.title,
    ageHours: round2(ageHours),
    slaHours,
    overdueHours: round2(ageHours - slaHours),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
