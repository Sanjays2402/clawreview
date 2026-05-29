import { Stat, Sparkline, Card, CardBody, CardHeader, EmptyState, GitPullRequestIcon } from '@clawreview/ui';

import { getRecentReviews, getWeeklyFindings } from '@/lib/data';

export default async function AppOverviewPage() {
  const reviews = await getRecentReviews();
  const weekly = await getWeeklyFindings();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-fg-muted">Last seven days across all installations.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Reviews" value={weekly.totalReviews} delta="+12% wow" />
        <Stat label="Findings" value={weekly.totalFindings} />
        <Stat label="Cost" value={`$${weekly.totalCostUsd.toFixed(2)}`} />
        <Stat label="P50 latency" value={`${weekly.p50LatencyMs}ms`} />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Findings per day</div>
            <div className="text-xs text-fg-muted">Last 14 days</div>
          </div>
        </CardHeader>
        <CardBody>
          <Sparkline data={weekly.dailyFindings} width={600} height={64} className="w-full" />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="text-sm font-medium">Recent reviews</div>
        </CardHeader>
        <CardBody>
          {reviews.length === 0 ? (
            <EmptyState
              icon={<GitPullRequestIcon size={28} />}
              title="No reviews yet"
              description="Install the ClawReview GitHub App on a repo, open a PR, and the first review will appear here within seconds."
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {reviews.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <div className="font-medium text-fg">{r.repo} #{r.prNumber}</div>
                    <div className="text-xs text-fg-muted">{r.title}</div>
                  </div>
                  <div className="text-xs text-fg-muted">
                    {r.findings} findings · {r.status}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
