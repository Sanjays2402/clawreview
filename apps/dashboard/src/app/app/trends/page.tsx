import { ChartLineUp } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState, Sparkline, Stat } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { SeverityRow } from '@/components/review/severity-row';
import { WindowForm } from '@/components/trends/window-form';
import { getWeeklyStats, type Severity } from '@/lib/data';
import { formatMs, formatUsd } from '@/lib/format';

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

  return (
    <div className="space-y-8">
      <PageHeader
        title="Trends"
        description="Aggregate review and finding volume over a custom window."
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
              <Sparkline data={stats.dailyFindings} width={600} height={80} className="w-full" />
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
              <table className="w-full min-w-[520px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="py-2 font-medium">Agent</th>
                    <th className="font-medium">Runs</th>
                    <th className="font-medium">Findings</th>
                    <th className="font-medium">Avg duration</th>
                    <th className="font-medium">Error rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {stats.byAgent
                    .slice()
                    .sort((a, b) => b.runs - a.runs)
                    .map((row) => (
                      <tr key={row.agent}>
                        <td className="py-2 font-medium text-fg">{row.agent}</td>
                        <td className="text-fg-muted">{row.runs}</td>
                        <td className="text-fg-muted">{row.findings}</td>
                        <td className="text-fg-muted">{formatMs(row.avgMs)}</td>
                        <td className="text-fg-muted">{Math.round(row.errorRate * 100)}%</td>
                      </tr>
                    ))}
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
