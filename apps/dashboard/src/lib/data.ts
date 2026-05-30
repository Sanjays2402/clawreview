/**
 * Data access layer for the dashboard. All reads hit the ClawReview server
 * REST API. Reads that fail return safe empty defaults so pages can render
 * an empty state instead of a server-side exception. Mutations throw so the
 * caller can render an error UI.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

class ApiError extends Error {
  constructor(public status: number, public path: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJSON<T>(path: string, fallback: T, init?: RequestInit): Promise<T> {
  try {
    const res = await fetch(`${API}${path}`, { cache: 'no-store', ...init });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

async function getJSONStrict<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { cache: 'no-store', ...init });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, path, await res.text().catch(() => res.statusText));
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return null;
  }
}

async function mutate<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, path, text);
  }
  return (await res.json()) as T;
}

// ---- Types matching the server DTOs ----

export type ReviewStatus = 'queued' | 'running' | 'completed' | 'failed';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'nit';

export interface ReviewListItem {
  id: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  status: ReviewStatus;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  totalFindings: number;
  openFindings: number;
  totalCostUsd: number;
}

export interface AgentExecutionDto {
  agent: string;
  status: 'ok' | 'error' | 'skipped';
  durationMs: number;
  findings: number;
  error?: string;
}

export interface FindingDto {
  id: string;
  reviewId: string;
  agent: string;
  category?: string;
  severity: Severity;
  title: string;
  rationale: string;
  file: string;
  line?: number;
  endLine?: number;
  state: 'open' | 'dismissed';
  dismissReason?: string;
  dismissedAt?: string;
  suggestedPatch?: string;
}

export interface ReviewDetail extends ReviewListItem {
  baseSha: string;
  error?: string;
  commentId?: number;
  checkRunId?: number;
  agentExecutions: AgentExecutionDto[];
  findings: FindingDto[];
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

export interface BudgetSnapshot {
  installationId: number;
  periodKey: string;
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
  overLimit: boolean;
}

export interface RepoHealth {
  owner: string;
  repo: string;
  status: 'healthy' | 'degraded' | 'paused';
  lastReviewAt?: string;
  failures: number;
  pauseReason?: string;
  pausedUntil?: string;
}

export interface InstallationListItem {
  id: string;
  login: string;
  type: 'User' | 'Organization';
  repoCount: number;
  monthlyBudgetUsd: number;
  spentUsd: number;
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorLogin: string;
  action: string;
  subject?: string;
}

// ---- Reads ----

export async function getRecentReviews(limit = 10): Promise<ReviewListItem[]> {
  const json = await getJSON<{ items: ReviewListItem[] }>(`/api/reviews?limit=${limit}`, { items: [] });
  return json.items;
}

export async function listReviews(params: {
  limit?: number;
  status?: ReviewStatus;
  owner?: string;
  repo?: string;
  installation?: number;
} = {}): Promise<{ items: ReviewListItem[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  return getJSON(`/api/reviews?${qs.toString()}`, { items: [], nextCursor: null });
}

export async function getReview(id: string): Promise<ReviewDetail | null> {
  return getJSONStrict<ReviewDetail>(`/api/reviews/${encodeURIComponent(id)}`);
}

export async function getWeeklyStats(days = 7): Promise<WeeklyStats> {
  return getJSON<WeeklyStats>(`/api/stats/weekly?days=${days}`, {
    windowDays: days,
    totalReviews: 0,
    completedReviews: 0,
    failedReviews: 0,
    totalFindings: 0,
    openFindings: 0,
    dismissedFindings: 0,
    totalCostUsd: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
    byAgent: [],
    dailyFindings: new Array(days).fill(0),
  });
}

export async function getBudgetSnapshot(installationId: number): Promise<BudgetSnapshot | null> {
  return getJSONStrict<BudgetSnapshot>(`/api/budget/${installationId}`);
}

export async function getRepoHealthList(): Promise<RepoHealth[]> {
  const json = await getJSON<{ items: RepoHealth[] }>('/api/repos/health', { items: [] });
  return json.items;
}

export async function getRepoHealth(owner: string, repo: string): Promise<RepoHealth | null> {
  return getJSONStrict<RepoHealth>(
    `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/health`,
  );
}

export async function getInstallations(): Promise<InstallationListItem[]> {
  const json = await getJSON<{ items: InstallationListItem[] }>('/api/installations', { items: [] });
  return json.items;
}

export async function getAudit(): Promise<AuditEntry[]> {
  const json = await getJSON<{ items: AuditEntry[] }>('/api/audit', { items: [] });
  return json.items;
}

// ---- Mutations (called from Server Actions) ----

export async function applyFindingAction(
  findingId: string,
  action: 'dismiss' | 'reopen',
  reason?: string,
): Promise<{ ok: true; finding: { id: string; state: 'open' | 'dismissed' } }> {
  return mutate(`/api/findings/${encodeURIComponent(findingId)}`, {
    method: 'POST',
    body: JSON.stringify({ action, reason }),
  });
}

export interface RerunInput {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}

export async function rerunReview(input: RerunInput): Promise<{ ok: true; reviewId: string; jobId: string }> {
  return mutate('/api/reviews/rerun', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateBudget(installationId: number, limitUsd: number): Promise<{ installationId: number; limitUsd: number; spentUsd: number }> {
  return mutate(`/api/budget/${installationId}`, {
    method: 'PUT',
    body: JSON.stringify({ limitUsd }),
  });
}

export async function pauseRepo(owner: string, repo: string, reason?: string): Promise<{ ok: true; state: RepoHealth }> {
  return mutate(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pause`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function resumeRepo(owner: string, repo: string): Promise<{ ok: true; state: RepoHealth }> {
  return mutate(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/resume`, {
    method: 'POST',
  });
}

export function reviewSarifUrl(id: string): string {
  return `${API}/api/reviews/${encodeURIComponent(id)}/sarif`;
}
export function reviewCsvUrl(id: string): string {
  return `${API}/api/reviews/${encodeURIComponent(id)}/findings.csv`;
}
export function reviewReportUrl(id: string): string {
  return `${API}/api/reviews/${encodeURIComponent(id)}/report.md`;
}
export function reviewJUnitUrl(id: string): string {
  return `${API}/api/reviews/${encodeURIComponent(id)}/junit.xml`;
}

export { ApiError };
