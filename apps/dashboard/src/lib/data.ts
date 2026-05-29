/**
 * Data access layer for the dashboard. In a real deployment these functions
 * call the server REST API; while running standalone they return realistic
 * empty defaults so every page renders without exploding.
 */

export interface ReviewListItem {
  id: string;
  repo: string;
  prNumber: number;
  title: string;
  findings: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  startedAt: string;
}

export interface WeeklyFindings {
  totalReviews: number;
  totalFindings: number;
  totalCostUsd: number;
  p50LatencyMs: number;
  dailyFindings: number[];
}

const API = process.env.NEXT_PUBLIC_API_URL ?? '';

async function tryFetch<T>(path: string, fallback: T): Promise<T> {
  if (!API) return fallback;
  try {
    const res = await fetch(`${API}${path}`, { cache: 'no-store' });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export async function getRecentReviews(): Promise<ReviewListItem[]> {
  const json = await tryFetch<{ items: ReviewListItem[] }>('/api/reviews?limit=10', { items: [] });
  return json.items;
}

export async function getWeeklyFindings(): Promise<WeeklyFindings> {
  return tryFetch<WeeklyFindings>('/api/stats/weekly', {
    totalReviews: 0,
    totalFindings: 0,
    totalCostUsd: 0,
    p50LatencyMs: 0,
    dailyFindings: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
}

export interface InstallationListItem {
  id: string;
  login: string;
  type: 'User' | 'Organization';
  repoCount: number;
  monthlyBudgetUsd: number;
  spentUsd: number;
}

export async function getInstallations(): Promise<InstallationListItem[]> {
  const json = await tryFetch<{ items: InstallationListItem[] }>('/api/installations', { items: [] });
  return json.items;
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorLogin: string;
  action: string;
  subject?: string;
}

export async function getAudit(): Promise<AuditEntry[]> {
  const json = await tryFetch<{ items: AuditEntry[] }>('/api/audit', { items: [] });
  return json.items;
}
