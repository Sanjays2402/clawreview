import { ChartLineUp } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState, Stat } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { InteractiveSparkline } from '@/components/charts/interactive-sparkline';
import { AgentPerformanceTable } from '@/components/trends/agent-performance-table';
import { SeverityRow } from '@/components/review/severity-row';
import { WindowForm } from '@/components/trends/window-form';
import { getWeeklyStats, type Severity } from '@/lib/data';
import { dayLabels, formatMs, formatUsd } from '@/lib/format';

const WINDOW_PRESETS = [7, 14, 30, 60, 90] as const;
const AGENT_SORTS = ['avg', 'total'] as const;
type AgentSort = (typeof AGENT_SORTS)[number];

function parseAgentSort(raw: string | undefined): AgentSort {
  return AGENT_SORTS.includes((raw ?? 'avg') as AgentSort) ? (raw as AgentSort) : 'avg';
}

/**
 * Findings-per-day spike days: indices in the daily series that jump well past
 * the window's own baseline. Same dual gate the repo-detail trend card + the
 * reviews list already use -- a ratio (>= 1.8x mean) AND an absolute gap
 * (>= mean + 3) -- so a 1 -> 2 wobble never lights up, only a genuine surge (a
 * big PR day, or a regression worth a look). Off below 2 points / zero mean.
 * Feeds the sparkline's always-visible outlier rings so a spike day reads at a
 * glance, the way the per-review trend card already marks its outliers -- the
 * window-level chart was the one place the marker idiom hadn't reached.
 */
function spikeDayIndices(daily: number[]): number[] {
  const mean = daily.length > 0 ? daily.reduce((a, b) => a + b, 0) / daily.length : 0;
  if (daily.length < 2 || mean <= 0) return [];
  const ratioFloor = mean * 1.8;
  const gapFloor = mean + 3;
  const out: number[] = [];
  daily.forEach((v, i) => {
    if (v >= ratioFloor && v >= gapFloor) out.push(i);
  });
  return out;
}

interface PageProps {
  searchParams: Promise<{ days?: string; sort?: string }>;
}

export default async function TrendsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const raw = Number.parseInt(sp.days ?? '', 10);
  const days = Number.isFinite(raw) && raw >= 1 && raw <= 90 ? raw : 14;
  const agentSort = parseAgentSort(sp.sort);

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
  const spikeDays = spikeDayIndices(stats.dailyFindings);

  return (
    <div className="space-y-4">
      <PageHeader
        title="trends"
        description="aggregate review and finding volume over a custom window."
        action={<WindowForm days={days} presets={WINDOW_PRESETS} />}
      />

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="reviews" value={stats.totalReviews} />
        <Stat label="completion" value={`${Math.round(completionRate * 100)}%`} />
        <Stat label="findings" value={stats.totalFindings} />
        <Stat label="spend" value={formatUsd(stats.totalCostUsd)} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">findings/day</div>
            <div className="flex items-center gap-3 font-mono text-[11px] text-fg-muted">
              {spikeDays.length > 0 ? (
                <span
                  className="inline-flex items-center gap-1"
                  title={`${spikeDays.length} day${spikeDays.length === 1 ? '' : 's'} well above the window baseline (>= 1.8x mean and >= mean + 3)`}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full border-[1.5px] border-accent"
                    aria-hidden
                  />
                  <span className="tabular-nums">{spikeDays.length}</span>
                  {spikeDays.length === 1 ? ' spike day' : ' spike days'}
                </span>
              ) : null}
              <span>{stats.windowDays}d</span>
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
                markers={spikeDays}
                markerColor="hsl(var(--accent))"
                className="w-full"
              />
            ) : (
              <div className="flex h-20 items-center font-mono text-xs text-fg-subtle">
                no findings landed in this window.
              </div>
            )}
            <div className="mt-4 grid grid-cols-2 gap-3 font-mono text-[11px] text-fg-muted sm:grid-cols-4">
              <Cell label="open" value={String(stats.openFindings)} />
              <Cell label="dismissed" value={String(stats.dismissedFindings)} />
              <Cell label="p50 latency" value={formatMs(stats.p50LatencyMs)} />
              <Cell label="p95 latency" value={formatMs(stats.p95LatencyMs)} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">severity mix</div>
            <div className="font-mono text-[11px] tabular-nums text-fg-muted">{sevTotal} total</div>
          </CardHeader>
          <CardBody>
            {sevTotal === 0 ? (
              <div className="font-mono text-xs text-fg-subtle">no findings in window.</div>
            ) : (
              <SeverityRow counts={sevCounts} total={sevTotal} />
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">agent performance</div>
          <div className="font-mono text-[11px] tabular-nums text-fg-muted">{stats.byAgent.length} agents</div>
        </CardHeader>
        <CardBody>
          {stats.byAgent.length === 0 ? (
            <EmptyState
              icon={<ChartLineUp size={28} weight="duotone" />}
              title="no agent runs"
              description="no agents executed in this window."
            />
          ) : (
            <AgentPerformanceTable rows={stats.byAgent} initialSort={agentSort} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className="text-sm tabular-nums text-fg">{value}</div>
    </div>
  );
}
