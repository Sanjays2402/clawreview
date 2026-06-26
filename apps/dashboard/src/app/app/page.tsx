import Link from 'next/link';
import { GitPullRequest, Warning, CheckCircle } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState, Stat } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { InteractiveSparkline } from '@/components/charts/interactive-sparkline';
import { SeverityRow } from '@/components/review/severity-row';
import { StatusPill } from '@/components/review/status-pill';
import { ListKeyboardNav } from '@/components/list-keyboard-nav';
import { LiveRelativeTime } from '@/components/ui/live-relative-time';
import { getRecentReviews, getSlaBreaches, getWeeklyStats } from '@/lib/data';
import { dayLabels, formatMs, formatUsd } from '@/lib/format';

export default async function AppOverviewPage() {
  const [reviews, weekly, sla] = await Promise.all([
    getRecentReviews(8),
    getWeeklyStats(7),
    getSlaBreaches(),
  ]);
  const failRate = weekly.totalReviews > 0 ? weekly.failedReviews / weekly.totalReviews : 0;

  return (
    <div className="space-y-4">
      <ListKeyboardNav selector="[data-review-row]" enabled={reviews.length > 0} />
      <PageHeader title="overview" description="last 7d across installations." />

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="reviews" value={weekly.totalReviews} />
        <Stat label="findings" value={weekly.totalFindings} />
        <Stat label="spend" value={formatUsd(weekly.totalCostUsd)} />
        <Stat label="p50 latency" value={formatMs(weekly.p50LatencyMs)} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">findings/day</div>
            <div className="font-mono text-[11px] text-fg-muted">{weekly.windowDays}d</div>
          </CardHeader>
          <CardBody>
            {weekly.dailyFindings.some((n) => n > 0) ? (
              <InteractiveSparkline
                data={weekly.dailyFindings}
                labels={dayLabels(weekly.dailyFindings.length)}
                width={600}
                height={48}
                unit="finding"
                className="w-full"
              />
            ) : (
              <div className="flex h-12 items-center font-mono text-xs text-fg-subtle">no findings in window.</div>
            )}
            <div className="mt-3 grid grid-cols-3 gap-3 font-mono text-[11px] text-fg-muted">
              <div>
                <div className="uppercase tracking-wider text-fg-subtle">open</div>
                <div className="text-sm tabular-nums text-fg">{weekly.openFindings}</div>
              </div>
              <div>
                <div className="uppercase tracking-wider text-fg-subtle">dismissed</div>
                <div className="text-sm tabular-nums text-fg">{weekly.dismissedFindings}</div>
              </div>
              <div>
                <div className="uppercase tracking-wider text-fg-subtle">p95</div>
                <div className="text-sm tabular-nums text-fg">{formatMs(weekly.p95LatencyMs)}</div>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">reliability</div>
          </CardHeader>
          <CardBody>
            <div className="flex items-center gap-3">
              {failRate === 0 ? (
                <CheckCircle size={22} weight="duotone" className="text-emerald-400" />
              ) : (
                <Warning size={22} weight="duotone" className="text-severity-medium" />
              )}
              <div>
                <div className="font-mono text-xl font-semibold tracking-tight tabular-nums">
                  {weekly.completedReviews}/{weekly.totalReviews}
                </div>
                <div className="font-mono text-[11px] text-fg-muted">clean reviews</div>
              </div>
            </div>
            {weekly.failedReviews > 0 ? (
              <div className="mt-2 rounded-sm border border-severity-medium/40 bg-severity-medium/5 px-2 py-1 font-mono text-[11px] text-severity-medium">
                {weekly.failedReviews} failed in {weekly.windowDays}d.
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">findings by severity</div>
          <div className="font-mono text-[11px] tabular-nums text-fg-muted">{weekly.totalFindings} total</div>
        </CardHeader>
        <CardBody>
          <SeverityRow counts={weekly.bySeverity} total={weekly.totalFindings} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">sla breaches</div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-fg-muted">
            <span>{sla ? `${sla.reviewsScanned} reviews scanned` : 'unavailable'}</span>
            <Link href={'/app/sla' as any} className="hover:text-fg">view all</Link>
          </div>
        </CardHeader>
        <CardBody>
          {!sla ? (
            <div className="font-mono text-xs text-fg-muted">sla endpoint unreachable.</div>
          ) : sla.totalBreaches === 0 ? (
            <div className="flex items-center gap-2 font-mono text-xs text-fg-muted">
              <CheckCircle size={14} weight="duotone" className="text-emerald-400" />
              no open findings past sla.
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
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">recent reviews</div>
          <div className="flex items-center gap-3">
            {reviews.length > 0 ? (
              <span className="hidden items-center gap-1 font-mono text-[10px] text-fg-subtle sm:inline-flex">
                <kbd className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-sm border border-border bg-bg-subtle px-1 text-[9px] text-fg-muted">j</kbd>
                <kbd className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-sm border border-border bg-bg-subtle px-1 text-[9px] text-fg-muted">k</kbd>
                <span>nav</span>
              </span>
            ) : null}
            <Link href={'/app/reviews' as any} className="font-mono text-[11px] text-fg-muted hover:text-fg">
              view all
            </Link>
          </div>
        </CardHeader>
        <CardBody>
          {reviews.length === 0 ? (
            <EmptyState
              icon={<GitPullRequest size={20} weight="duotone" />}
              title="no reviews yet"
              description="install on a repo, open a pr. first review lands in seconds."
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {reviews.map((r) => (
                <li key={r.id} className="focus-within:bg-accent/[0.07]">
                  <Link
                    href={`/app/reviews/${r.id}` as any}
                    data-review-row
                    className="grid grid-cols-12 items-center gap-3 rounded-sm px-1 py-1.5 font-mono text-xs outline-none ring-accent/60 hover:bg-bg-subtle/40 focus-visible:ring-1"
                  >
                    <div className="col-span-12 sm:col-span-6">
                      <div className="truncate text-fg">
                        {r.owner}/{r.repo} <span className="text-fg-subtle">#</span>{r.prNumber}
                      </div>
                      <div className="truncate text-[11px] text-fg-muted">
                        {r.openFindings} open / {r.totalFindings}
                      </div>
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <StatusPill status={r.status} />
                    </div>
                    <div className="col-span-4 tabular-nums text-fg-muted sm:col-span-2">{formatUsd(r.totalCostUsd)}</div>
                    <div className="col-span-4 text-right tabular-nums text-fg-muted sm:col-span-2">
                      <LiveRelativeTime iso={r.createdAt} />
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


