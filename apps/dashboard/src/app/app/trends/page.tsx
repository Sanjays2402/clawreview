import { ChartLineUp } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState, Stat } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { InteractiveSparkline } from '@/components/charts/interactive-sparkline';
import { SeverityRow } from '@/components/review/severity-row';
import { WindowForm } from '@/components/trends/window-form';
import { getWeeklyStats, type Severity } from '@/lib/data';
import { dayLabels, formatMs, formatUsd } from '@/lib/format';

const WINDOW_PRESETS = [7, 14, 30, 60, 90] as const;

interface PageProps {
  searchParams: Promise<{ days?: string }>;
}

export default async function TrendsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const raw = Number.parseInt(sp.days ?? '', 10);
  const days = Number.isFinite(raw) && raw >= 1 && raw <= 90 ? raw : 14;

  const stats = await getWeeklyStats(days);

  const sevCounts: Record<Severity, number> = {
    critical: stats.bySeverity.critical ?? 0,
    high: stats.bySeverity.high ?? 0,
    medium: stats.bySeverity.medium ?? 0,
    low: stats.bySeverity.low ?? 0,
    nit: stats.bySeverity.nit ?? 0,
  };
  const sevTotal = Object.values(sevCounts).reduce((a, b) => a + b, 0);
  const completionRate = stats.totalReviews > 0 ? stats.completedReviews / stats.totalReviews : 0;
  const dailyHasData = stats.dailyFindings.some((n) => n > 0);

  // Agent performance, slowest-first so the bottleneck pops to the top (the
  // same idiom as the per-review AgentTimeline). The duration bars are
  // normalised to the slowest agent's average, and tinted by error rate so a
  // flaky agent reads red without scanning the rightmost column.
  const byAgent = stats.byAgent.slice().sort((a, b) => b.avgMs - a.avgMs);
  const maxAvgMs = Math.max(...byAgent.map((r) => r.avgMs), 1);

  return (
    <div className="space-y-8">
      <PageHeader
        title="trends"
        description="aggregate review and finding volume over a custom window."
        action={<WindowForm days={days} presets={WINDOW_PRESETS} />}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Reviews" value={stats.totalReviews} />
        <Stat label="Completion" value={`${Math.round(completionRate * 100)}%`} />
        <Stat label="Findings" value={stats.totalFindings} />
        <Stat label="Spend" value={formatUsd(stats.totalCostUsd)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Findings per day</div>
              <div className="text-xs text-fg-muted">Last {stats.windowDays} days</div>
            </div>
          </CardHeader>
          <CardBody>
            {dailyHasData ? (
              <InteractiveSparkline
                data={stats.dailyFindings}
                labels={dayLabels(stats.dailyFindings.length)}
                width={600}
                height={80}
                unit="finding"
                className="w-full"
              />
            ) : (
              <div className="flex h-20 items-center text-xs text-fg-subtle">
                No findings landed in this window.
              </div>
            )}
            <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-fg-muted sm:grid-cols-4">
              <Cell label="Open" value={String(stats.openFindings)} />
              <Cell label="Dismissed" value={String(stats.dismissedFindings)} />
              <Cell label="p50 latency" value={formatMs(stats.p50LatencyMs)} />
              <Cell label="p95 latency" value={formatMs(stats.p95LatencyMs)} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-medium">Severity mix</div>
          </CardHeader>
          <CardBody>
            {sevTotal === 0 ? (
              <div className="text-xs text-fg-subtle">No findings in window.</div>
            ) : (
              <SeverityRow counts={sevCounts} total={sevTotal} />
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Agent performance</div>
            <div className="text-xs text-fg-muted">{stats.byAgent.length} agents</div>
          </div>
        </CardHeader>
        <CardBody>
          {stats.byAgent.length === 0 ? (
            <EmptyState
              icon={<ChartLineUp size={28} weight="duotone" />}
              title="No agent runs"
              description="No agents executed in this window."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] font-mono text-xs">
                <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                  <tr>
                    <th className="py-1.5 font-medium">agent</th>
                    <th className="font-medium tabular-nums">runs</th>
                    <th className="font-medium tabular-nums">findings</th>
                    <th className="w-[34%] font-medium">avg duration</th>
                    <th className="text-right font-medium tabular-nums">error rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {byAgent.map((row, i) => {
                    const pct = Math.max((row.avgMs / maxAvgMs) * 100, 1.5);
                    // Tint the duration bar by error rate: a clean agent reads
                    // emerald, a flaky one shifts toward critical -- so "which
                    // agent is slow AND failing?" is one glance, not a column scan.
                    const barTone =
                      row.errorRate >= 0.25
                        ? 'bg-severity-critical/70'
                        : row.errorRate > 0
                          ? 'bg-severity-medium/70'
                          : 'bg-emerald-500/60';
                    const errPct = Math.round(row.errorRate * 100);
                    const isSlowest = i === 0 && byAgent.length > 1 && row.avgMs > 0;
                    return (
                      <tr key={row.agent} className="hover:bg-bg-subtle/40">
                        <td className="py-1.5">
                          <span className="flex items-center gap-1.5">
                            <span className="text-fg" title={row.agent}>{row.agent}</span>
                            {isSlowest ? (
                              <span
                                className="shrink-0 rounded-sm border border-severity-high/40 bg-severity-high/10 px-1 text-[9px] uppercase tracking-wider text-severity-high"
                                title="slowest agent on average"
                              >
                                slowest
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="tabular-nums text-fg-muted">{row.runs}</td>
                        <td className="tabular-nums text-fg-muted">{row.findings}</td>
                        <td className="pr-3">
                          <span className="flex items-center gap-2">
                            <span className="relative h-1.5 flex-1 overflow-hidden rounded-sm bg-bg-muted">
                              <span
                                className={`absolute inset-y-0 left-0 ${barTone}`}
                                style={{ width: `${pct}%` }}
                                aria-hidden
                              />
                            </span>
                            <span className="w-12 shrink-0 text-right tabular-nums text-fg-muted">
                              {formatMs(row.avgMs)}
                            </span>
                          </span>
                        </td>
                        <td className={`text-right tabular-nums ${errPct > 0 ? 'text-severity-critical' : 'text-fg-subtle'}`}>
                          {errPct}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-fg-subtle">{label}</div>
      <div className="text-base font-medium text-fg">{value}</div>
    </div>
  );
}
