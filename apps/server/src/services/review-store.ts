import type { Finding, ReviewSummary, ReviewStatus, Severity } from '@clawreview/types';
import { fingerprint } from '@clawreview/aggregator';

export interface ReviewRecord {
  id: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  totalFindings: number;
  totalCostUsd: number;
  durationMs?: number;
  error?: string;
  agentExecutions: ReviewSummary['agentExecutions'];
  findings: StoredFinding[];
  commentId?: number;
  checkRunId?: number;
}

export interface StoredFinding extends Finding {
  id: string;
  reviewId: string;
  state: 'open' | 'dismissed';
  /** Stable content fingerprint, used for cross-review dedup and auto-suppress. */
  fingerprint: string;
  dismissReason?: string;
  dismissedAt?: string;
  /** Set when the finding was auto-dismissed because a prior review on the
   * same PR had dismissed a finding with the same fingerprint. */
  autoDismissed?: boolean;
}

export interface ListReviewsQuery {
  installationId?: number;
  owner?: string;
  repo?: string;
  status?: ReviewStatus;
  limit: number;
  cursor?: string;
}

export interface ListReviewsResult {
  items: ReviewRecord[];
  nextCursor: string | null;
}

export interface StartInput {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}

/**
 * Storage interface for review state. Backed by an in-memory map today; the
 * Postgres-backed implementation lives in @clawreview/db and is swapped in by
 * the server bootstrap once DATABASE_URL is reachable.
 */
export interface ReviewStore {
  start(input: StartInput): Promise<ReviewRecord>;
  markRunning(id: string): Promise<void>;
  complete(
    id: string,
    summary: ReviewSummary,
    findings: Finding[],
    refs?: { commentId?: number; checkRunId?: number },
  ): Promise<ReviewRecord>;
  fail(id: string, error: Error): Promise<void>;
  get(id: string): Promise<ReviewRecord | null>;
  list(query: ListReviewsQuery): Promise<ListReviewsResult>;
  findingAction(
    findingId: string,
    action: 'dismiss' | 'reopen',
    reason?: string,
  ): Promise<StoredFinding | null>;

  /**
   * Apply an action to every open (or every dismissed, on 'reopen') finding
   * in a review that matches the supplied filter. Returns the IDs that were
   * actually mutated so callers can audit-log them.
   */
  bulkFindingAction(
    reviewId: string,
    action: 'dismiss' | 'reopen',
    filter: BulkFindingFilter,
    reason?: string,
  ): Promise<BulkFindingResult | null>;

  /** Aggregated stats over the last `days` days for the dashboard. */
  weeklyStats(days?: number): Promise<WeeklyStats>;
}

export interface WeeklyStats {
  windowDays: number;
  totalReviews: number;
  completedReviews: number;
  failedReviews: number;
  totalFindings: number;
  openFindings: number;
  dismissedFindings: number;
  totalCostUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  bySeverity: Record<Severity, number>;
  byAgent: Array<{ agent: string; runs: number; findings: number; avgMs: number; errorRate: number }>;
  dailyFindings: number[];
}

export interface BulkFindingFilter {
  /** Limit to these severities. Empty/undefined matches all severities. */
  severities?: Severity[];
  /** Limit to these categories. Empty/undefined matches all categories. */
  categories?: string[];
  /** Limit to findings produced by these agents. */
  agents?: string[];
  /** Limit to these file paths (exact match). */
  files?: string[];
}

export interface BulkFindingResult {
  reviewId: string;
  action: 'dismiss' | 'reopen';
  matched: number;
  changed: string[];
}

export class InMemoryReviewStore implements ReviewStore {
  private reviews = new Map<string, ReviewRecord>();
  private findingsIndex = new Map<string, string>(); // findingId -> reviewId
  private counter = 0;
  /**
   * Map of `${owner}/${repo}#${pr}` -> Set<fingerprint> of findings a
   * reviewer dismissed on a prior review of the same PR. New reviews use
   * this set to auto-suppress recurring noise after a force-push or rerun.
   */
  private dismissedByPr = new Map<string, Map<string, string>>();

  async start(input: StartInput): Promise<ReviewRecord> {
    this.counter += 1;
    const now = new Date().toISOString();
    const id = `rv_${this.counter}_${input.headSha.slice(0, 7)}`;
    const rec: ReviewRecord = {
      id,
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      baseSha: input.baseSha,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      totalFindings: 0,
      totalCostUsd: 0,
      agentExecutions: [],
      findings: [],
    };
    this.reviews.set(id, rec);
    return rec;
  }

  async markRunning(id: string): Promise<void> {
    const rec = this.reviews.get(id);
    if (!rec) return;
    rec.status = 'running';
    rec.startedAt = new Date().toISOString();
    rec.updatedAt = rec.startedAt;
  }

  async complete(
    id: string,
    summary: ReviewSummary,
    findings: Finding[],
    refs?: { commentId?: number; checkRunId?: number },
  ): Promise<ReviewRecord> {
    const rec = this.reviews.get(id);
    if (!rec) throw new Error(`unknown review ${id}`);
    rec.status = 'completed';
    rec.completedAt = summary.completedAt ?? new Date().toISOString();
    rec.startedAt = rec.startedAt ?? summary.startedAt;
    rec.updatedAt = rec.completedAt;
    rec.totalFindings = findings.length;
    rec.totalCostUsd = summary.totalCostUsd;
    rec.agentExecutions = summary.agentExecutions;
    if (rec.startedAt) {
      rec.durationMs = Math.max(0, Date.parse(rec.completedAt) - Date.parse(rec.startedAt));
    }
    rec.commentId = refs?.commentId;
    rec.checkRunId = refs?.checkRunId;

    const prKey = `${rec.owner}/${rec.repo}#${rec.prNumber}`;
    const priorDismissed = this.dismissedByPr.get(prKey) ?? new Map<string, string>();
    rec.findings = findings.map((f, idx) => {
      const fid = `${id}:${idx}`;
      this.findingsIndex.set(fid, id);
      const fp = fingerprint(f);
      const priorReason = priorDismissed.get(fp);
      const stored: StoredFinding = {
        ...f,
        id: fid,
        reviewId: id,
        state: priorReason !== undefined ? 'dismissed' : 'open',
        fingerprint: fp,
      };
      if (priorReason !== undefined) {
        stored.dismissedAt = new Date().toISOString();
        stored.dismissReason = priorReason;
        stored.autoDismissed = true;
      }
      return stored;
    });
    return rec;
  }

  async fail(id: string, error: Error): Promise<void> {
    const rec = this.reviews.get(id);
    if (!rec) return;
    rec.status = 'failed';
    rec.error = error.message;
    rec.completedAt = new Date().toISOString();
    rec.updatedAt = rec.completedAt;
    if (rec.startedAt) {
      rec.durationMs = Math.max(0, Date.parse(rec.completedAt) - Date.parse(rec.startedAt));
    }
  }

  async get(id: string): Promise<ReviewRecord | null> {
    return this.reviews.get(id) ?? null;
  }

  async list(query: ListReviewsQuery): Promise<ListReviewsResult> {
    let items = [...this.reviews.values()];
    if (query.installationId !== undefined) {
      items = items.filter((r) => r.installationId === query.installationId);
    }
    if (query.owner) items = items.filter((r) => r.owner === query.owner);
    if (query.repo) items = items.filter((r) => r.repo === query.repo);
    if (query.status) items = items.filter((r) => r.status === query.status);
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    const start = query.cursor ? Math.max(0, parseInt(query.cursor, 10) || 0) : 0;
    const page = items.slice(start, start + query.limit);
    const next = start + query.limit < items.length ? String(start + query.limit) : null;
    return { items: page, nextCursor: next };
  }

  async findingAction(
    findingId: string,
    action: 'dismiss' | 'reopen',
    reason?: string,
  ): Promise<StoredFinding | null> {
    const reviewId = this.findingsIndex.get(findingId);
    if (!reviewId) return null;
    const rec = this.reviews.get(reviewId);
    if (!rec) return null;
    const f = rec.findings.find((x) => x.id === findingId);
    if (!f) return null;
    this.applyAction(f, action, reason);
    rec.updatedAt = new Date().toISOString();
    return f;
  }

  async bulkFindingAction(
    reviewId: string,
    action: 'dismiss' | 'reopen',
    filter: BulkFindingFilter,
    reason?: string,
  ): Promise<BulkFindingResult | null> {
    const rec = this.reviews.get(reviewId);
    if (!rec) return null;

    const sevSet = filter.severities && filter.severities.length > 0 ? new Set(filter.severities) : null;
    const catSet = filter.categories && filter.categories.length > 0 ? new Set(filter.categories) : null;
    const agentSet = filter.agents && filter.agents.length > 0 ? new Set(filter.agents) : null;
    const fileSet = filter.files && filter.files.length > 0 ? new Set(filter.files) : null;

    // 'dismiss' acts on findings currently in 'open' state; 'reopen' acts
    // on findings currently in 'dismissed' state. Findings already in the
    // target state are counted in `matched` but not re-mutated.
    const sourceState: StoredFinding['state'] = action === 'dismiss' ? 'open' : 'dismissed';
    const changed: string[] = [];
    let matched = 0;
    for (const f of rec.findings) {
      if (sevSet && !sevSet.has(f.severity)) continue;
      if (catSet && !catSet.has(f.category)) continue;
      if (agentSet && !agentSet.has(f.agent)) continue;
      if (fileSet && !fileSet.has(f.file)) continue;
      matched += 1;
      if (f.state !== sourceState) continue;
      this.applyAction(f, action, reason);
      changed.push(f.id);
    }
    if (changed.length > 0) rec.updatedAt = new Date().toISOString();
    return { reviewId, action, matched, changed };
  }

  private applyAction(
    f: StoredFinding,
    action: 'dismiss' | 'reopen',
    reason: string | undefined,
  ): void {
    const rec = this.reviews.get(f.reviewId);
    const prKey = rec ? `${rec.owner}/${rec.repo}#${rec.prNumber}` : null;
    if (action === 'dismiss') {
      f.state = 'dismissed';
      f.dismissedAt = new Date().toISOString();
      f.dismissReason = reason;
      f.autoDismissed = false;
      if (prKey) {
        const map = this.dismissedByPr.get(prKey) ?? new Map<string, string>();
        map.set(f.fingerprint, reason ?? '');
        this.dismissedByPr.set(prKey, map);
      }
    } else {
      f.state = 'open';
      f.dismissedAt = undefined;
      f.dismissReason = undefined;
      f.autoDismissed = false;
      if (prKey) {
        const map = this.dismissedByPr.get(prKey);
        if (map) {
          map.delete(f.fingerprint);
          if (map.size === 0) this.dismissedByPr.delete(prKey);
        }
      }
    }
  }

  async weeklyStats(days = 7): Promise<WeeklyStats> {
    const cutoff = Date.now() - days * 86400_000;
    const window = [...this.reviews.values()].filter(
      (r) => Date.parse(r.createdAt) >= cutoff,
    );

    const completed = window.filter((r) => r.status === 'completed');
    const latencies = completed
      .map((r) => r.durationMs ?? 0)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    const bySeverity: WeeklyStats['bySeverity'] = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      nit: 0,
    };
    let open = 0;
    let dismissed = 0;
    let totalFindings = 0;
    for (const r of window) {
      for (const f of r.findings) {
        totalFindings += 1;
        if (f.state === 'open') open += 1;
        else dismissed += 1;
        bySeverity[f.severity] += 1;
      }
    }

    const byAgentMap = new Map<
      string,
      { runs: number; findings: number; durationMs: number; errors: number }
    >();
    for (const r of window) {
      for (const ex of r.agentExecutions) {
        const cur = byAgentMap.get(ex.agent) ?? {
          runs: 0,
          findings: 0,
          durationMs: 0,
          errors: 0,
        };
        cur.runs += 1;
        cur.findings += ex.findings.length;
        cur.durationMs += ex.durationMs;
        if (ex.status === 'error') cur.errors += 1;
        byAgentMap.set(ex.agent, cur);
      }
    }
    const byAgent = [...byAgentMap.entries()].map(([agent, v]) => ({
      agent,
      runs: v.runs,
      findings: v.findings,
      avgMs: v.runs > 0 ? Math.round(v.durationMs / v.runs) : 0,
      errorRate: v.runs > 0 ? v.errors / v.runs : 0,
    }));

    const daily = new Array(days).fill(0);
    // Bucket by UTC day. Today is the last bucket (index days-1).
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    for (const r of window) {
      const created = Date.parse(r.createdAt);
      const createdDay = new Date(created);
      createdDay.setUTCHours(0, 0, 0, 0);
      const ageDays = Math.floor((todayStart.getTime() - createdDay.getTime()) / 86400_000);
      const bucket = days - 1 - ageDays;
      if (bucket >= 0 && bucket < days) {
        daily[bucket] += r.findings.length;
      }
    }

    return {
      windowDays: days,
      totalReviews: window.length,
      completedReviews: completed.length,
      failedReviews: window.filter((r) => r.status === 'failed').length,
      totalFindings,
      openFindings: open,
      dismissedFindings: dismissed,
      totalCostUsd: window.reduce((a, r) => a + r.totalCostUsd, 0),
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      bySeverity,
      byAgent,
      dailyFindings: daily,
    };
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx]!;
}

/** Singleton accessor used by routes and worker. */
let singleton: ReviewStore | null = null;
export function getReviewStore(): ReviewStore {
  if (!singleton) singleton = new InMemoryReviewStore();
  return singleton;
}

/** Test helper for resetting the singleton between specs. */
export function _resetReviewStoreForTests(): void {
  singleton = new InMemoryReviewStore();
}
