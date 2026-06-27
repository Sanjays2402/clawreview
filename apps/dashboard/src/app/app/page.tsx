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

// Severity -> dot/text tint (literal classes so Tailwind JIT keeps them).
const SEV_DOT: Record<string, string> = {
  critical: 'bg-severity-critical',
  high: 'bg-severity-high',
  medium: 'bg-severity-medium',
  low: 'bg-severity-low',
  nit: 'bg-severity-nit',
};
const SEV_TEXT: Record<string, string> = {
  critical: 'text-severity-critical',
  high: 'text-severity-high',
  medium: 'text-severity-medium',
  low: 'text-severity-low',
  nit: 'text-severity-nit',
};

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
            <div className="font-mono text-[11px] tabular-nums text-fg-muted">
              {Math.round((1 - failRate) * 100)}% clean
            </div>
          </CardHeader>
          <CardBody>
            {(() => {
              // Dense reliability readout: a completion bar split into clean
              // (emerald), failed (critical) and any still-running (neutral)
              // segments so the health mix reads at a glance, plus a mono
              // N/M + percentage. Mirrors the dense lowercase/mono language
              // the SLA block (tick 41) and the rest of the overview already use.
              const total = weekly.totalReviews;
              const completed = weekly.completedReviews;
              const failed = weekly.failedReviews;
              const inProgress = Math.max(0, total - completed - failed);
              const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
              return (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2.5">
                    {failRate === 0 ? (
                      <CheckCircle size={18} weight="duotone" className="shrink-0 text-emerald-400" />
                    ) : (
                      <Warning size={18} weight="duotone" className="shrink-0 text-severity-medium" />
                    )}
                    <div className="flex items-baseline gap-1.5 font-mono">
                      <span className="text-xl font-semibold tracking-tight tabular-nums text-fg">
                        {completed}
                      </span>
                      <span className="text-sm tabular-nums text-fg-subtle">/ {total}</span>
                      <span className="text-[11px] text-fg-muted">clean reviews</span>
                    </div>
                  </div>

                  {total > 0 ? (
                    <span
                      className="flex h-1.5 w-full overflow-hidden rounded-full bg-bg-muted"
                      title={`${completed} clean / ${failed} failed${inProgress > 0 ? ` / ${inProgress} running` : ''}`}
                      aria-hidden
                    >
                      {completed > 0 ? (
                        <span className="h-full bg-emerald-500/70" style={{ width: `${pct(completed)}%` }} />
                      ) : null}
                      {failed > 0 ? (
                        <span className="h-full bg-severity-critical/70" style={{ width: `${pct(failed)}%` }} />
                      ) : null}
                      {inProgress > 0 ? (
                        <span className="h-full bg-fg-subtle/30" style={{ width: `${pct(inProgress)}%` }} />
                      ) : null}
                    </span>
                  ) : (
                    <div className="font-mono text-[11px] text-fg-subtle">no reviews in window.</div>
                  )}

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-fg-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" aria-hidden />
                      <span className="tabular-nums text-fg">{completed}</span> clean
                    </span>
                    {failed > 0 ? (
                      <span className="inline-flex items-center gap-1.5 text-severity-critical">
                        <span className="h-1.5 w-1.5 rounded-full bg-severity-critical/70" aria-hidden />
                        <span className="tabular-nums">{failed}</span> failed in {weekly.windowDays}d
                      </span>
                    ) : null}
                    {inProgress > 0 ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-fg-subtle/40" aria-hidden />
                        <span className="tabular-nums text-fg">{inProgress}</span> running
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })()}
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
            <div className="space-y-2.5">
              <div className="flex items-baseline gap-2 font-mono">
                <span className="text-2xl font-semibold tabular-nums tracking-tight text-severity-critical">
                  {sla.totalBreaches}
                </span>
                <span className="text-[11px] text-fg-subtle">
                  open finding{sla.totalBreaches === 1 ? '' : 's'} past sla
                </span>
              </div>
              <div className="flex flex-wrap gap-1 font-mono text-[11px]">
                {(['critical', 'high', 'medium', 'low', 'nit'] as const).map((sev) => {
                  const n = sla.bySeverity[sev] ?? 0;
                  if (!n) return null;
                  return (
                    <Link
                      key={sev}
                      href={`/app/sla?sev=${sev}` as any}
                      className="group inline-flex items-center gap-1.5 rounded-sm border border-border-subtle bg-bg-subtle/50 px-1.5 py-0.5 lowercase text-fg-muted transition-colors hover:border-border hover:bg-bg-subtle"
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT[sev]}`} aria-hidden />
                      <span className="tabular-nums text-fg">{n}</span>
                      <span className={SEV_TEXT[sev]}>{sev}</span>
                    </Link>
                  );
                })}
              </div>
              <ul className="divide-y divide-border-subtle font-mono text-xs">
                {sla.breaches.slice(0, 5).map((b) => {
                  const overdue = b.overdueHours ?? Math.max(0, b.ageHours - b.slaHours);
                  return (
                    <li key={b.findingId} className="focus-within:bg-accent/[0.07]">
                      <Link
                        href={`/app/reviews/${b.reviewId}` as any}
                        className="flex items-center gap-2 rounded-sm px-1 py-1.5 outline-none ring-accent/60 hover:bg-bg-subtle/40 focus-visible:ring-1"
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[b.severity]}`} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="text-fg">
                            {b.owner}/{b.repo} <span className="text-fg-subtle">#</span>{b.prNumber}
                          </span>{' '}
                          <span className="text-fg-muted">{b.title}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-fg-subtle">
                          {Math.round(b.ageHours)}h / {b.slaHours}h
                        </span>
                        {overdue > 0 ? (
                          <span
                            className="shrink-0 tabular-nums font-medium text-severity-critical"
                            title="hours overdue"
                          >
                            +{Math.round(overdue)}h
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {sla.totalBreaches > 5 ? (
                <Link
                  href={'/app/sla' as any}
                  className="inline-block font-mono text-[11px] text-fg-subtle hover:text-fg"
                >
                  +{sla.totalBreaches - 5} more breaches
                </Link>
              ) : null}
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


