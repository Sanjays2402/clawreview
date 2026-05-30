import Link from 'next/link';
import { GitPullRequest, Warning, CheckCircle } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState, Sparkline, Stat } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { SeverityRow } from '@/components/review/severity-row';
import { StatusPill } from '@/components/review/status-pill';
import { getRecentReviews, getSlaBreaches, getWeeklyStats } from '@/lib/data';
import { formatMs, formatRelative, formatUsd } from '@/lib/format';

export default async function AppOverviewPage() {
  const [reviews, weekly, sla] = await Promise.all([
    getRecentReviews(8),
    getWeeklyStats(7),
    getSlaBreaches(),
  ]);
  const failRate = weekly.totalReviews > 0 ? weekly.failedReviews / weekly.totalReviews : 0;

  return (
    <div className="space-y-8">
      <PageHeader title="Overview" description="Last seven days across every installation you can see." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Reviews" value={weekly.totalReviews} />
        <Stat label="Findings" value={weekly.totalFindings} />
        <Stat label="Spend" value={formatUsd(weekly.totalCostUsd)} />
        <Stat label="p50 latency" value={formatMs(weekly.p50LatencyMs)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Findings per day</div>
              <div className="text-xs text-fg-muted">Last {weekly.windowDays} days</div>
            </div>
          </CardHeader>
          <CardBody>
            {weekly.dailyFindings.some((n) => n > 0) ? (
              <Sparkline data={weekly.dailyFindings} width={600} height={64} className="w-full" />
            ) : (
              <div className="flex h-16 items-center text-xs text-fg-subtle">No findings landed in this window.</div>
            )}
            <div className="mt-4 grid grid-cols-3 gap-3 text-xs text-fg-muted">
              <div>
                <div className="text-fg-subtle">Open</div>
                <div className="text-base font-medium text-fg">{weekly.openFindings}</div>
              </div>
              <div>
                <div className="text-fg-subtle">Dismissed</div>
                <div className="text-base font-medium text-fg">{weekly.dismissedFindings}</div>
              </div>
              <div>
                <div className="text-fg-subtle">p95 latency</div>
                <div className="text-base font-medium text-fg">{formatMs(weekly.p95LatencyMs)}</div>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-medium">Reliability</div>
          </CardHeader>
          <CardBody>
            <div className="flex items-center gap-3">
              {failRate === 0 ? (
                <CheckCircle size={28} weight="duotone" className="text-emerald-500" />
              ) : (
                <Warning size={28} weight="duotone" className="text-amber-500" />
              )}
              <div>
                <div className="text-2xl font-semibold tracking-tight">
                  {weekly.completedReviews}/{weekly.totalReviews}
                </div>
                <div className="text-xs text-fg-muted">reviews completed cleanly</div>
              </div>
            </div>
            {weekly.failedReviews > 0 ? (
              <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {weekly.failedReviews} failed in the last {weekly.windowDays} days.
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Findings by severity</div>
            <div className="text-xs text-fg-muted">{weekly.totalFindings} total</div>
          </div>
        </CardHeader>
        <CardBody>
          <SeverityRow counts={weekly.bySeverity} total={weekly.totalFindings} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">SLA breaches</div>
            <div className="flex items-center gap-3 text-xs text-fg-muted">
              <span>{sla ? `${sla.reviewsScanned} reviews scanned` : 'unavailable'}</span>
              <Link href={'/app/sla' as any} className="hover:text-fg">View all</Link>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {!sla ? (
            <div className="text-sm text-fg-muted">SLA endpoint did not respond.</div>
          ) : sla.totalBreaches === 0 ? (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <CheckCircle size={18} weight="duotone" className="text-emerald-500" />
              No open findings are past their SLA window.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-2xl font-semibold tracking-tight">{sla.totalBreaches}</div>
              <div className="flex flex-wrap gap-2 text-xs">
                {(['critical', 'high', 'medium', 'low', 'nit'] as const).map((sev) => {
                  const n = sla.bySeverity[sev] ?? 0;
                  if (!n) return null;
                  return (
                    <span
                      key={sev}
                      className="rounded-full border border-border bg-bg-subtle px-2 py-0.5 text-fg-muted"
                    >
                      <span className="font-medium text-fg">{n}</span> {sev}
                    </span>
                  );
                })}
              </div>
              <ul className="divide-y divide-border-subtle text-sm">
                {sla.breaches.slice(0, 5).map((b) => (
                  <li key={b.findingId} className="py-2">
                    <Link
                      href={`/app/reviews/${b.reviewId}` as any}
                      className="flex items-center justify-between gap-3 hover:bg-bg-subtle/40"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium text-fg">
                          {b.owner}/{b.repo} #{b.prNumber}
                        </span>{' '}
                        <span className="text-fg-muted">{b.title}</span>
                      </span>
                      <span className="shrink-0 text-xs text-fg-muted">
                        {Math.round(b.ageHours)}h / {b.slaHours}h
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Recent reviews</div>
            <Link href={'/app/reviews' as any} className="text-xs text-fg-muted hover:text-fg">
              View all
            </Link>
          </div>
        </CardHeader>
        <CardBody>
          {reviews.length === 0 ? (
            <EmptyState
              icon={<GitPullRequest size={28} weight="duotone" />}
              title="No reviews yet"
              description="Install ClawReview on a repo and open a PR. The first review lands here within seconds."
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {reviews.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/app/reviews/${r.id}` as any}
                    className="grid grid-cols-12 items-center gap-3 py-3 hover:bg-bg-subtle/40"
                  >
                    <div className="col-span-12 sm:col-span-6">
                      <div className="font-medium text-fg">
                        {r.owner}/{r.repo} #{r.prNumber}
                      </div>
                      <div className="truncate text-xs text-fg-muted">
                        {r.openFindings} open of {r.totalFindings} findings
                      </div>
                    </div>
                    <div className="col-span-4 text-xs text-fg-muted sm:col-span-2">
                      <StatusPill status={r.status} />
                    </div>
                    <div className="col-span-4 text-xs text-fg-muted sm:col-span-2">{formatUsd(r.totalCostUsd)}</div>
                    <div className="col-span-4 text-right text-xs text-fg-muted sm:col-span-2">
                      {formatRelative(r.createdAt)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}


