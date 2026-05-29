import { Card, CardBody, CardHeader, EmptyState, GitPullRequestIcon, SeverityBadge } from '@clawreview/ui';

import { getRecentReviews } from '@/lib/data';

export default async function ReviewsPage() {
  const items = await getRecentReviews();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
        <p className="mt-1 text-sm text-fg-muted">Every review across every installation you have access to.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="text-sm font-medium">Recent</div>
        </CardHeader>
        <CardBody>
          {items.length === 0 ? (
            <EmptyState
              icon={<GitPullRequestIcon size={28} />}
              title="Nothing here yet"
              description="Reviews appear here as soon as a PR is opened on an installed repo."
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {items.map((r) => (
                <li key={r.id} className="grid grid-cols-12 items-center gap-3 py-3">
                  <div className="col-span-5">
                    <div className="font-medium text-fg">{r.repo} #{r.prNumber}</div>
                    <div className="truncate text-xs text-fg-muted">{r.title}</div>
                  </div>
                  <div className="col-span-2 text-xs text-fg-muted">{r.status}</div>
                  <div className="col-span-2 text-xs text-fg-muted">{r.findings} findings</div>
                  <div className="col-span-3 text-right text-xs text-fg-muted">
                    <time dateTime={r.startedAt}>{new Date(r.startedAt).toLocaleString()}</time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <div className="text-xs text-fg-subtle">
        Severity legend: <SeverityBadge severity="critical" />{' '}
        <SeverityBadge severity="high" /> <SeverityBadge severity="medium" />{' '}
        <SeverityBadge severity="low" /> <SeverityBadge severity="nit" />
      </div>
    </div>
  );
}
