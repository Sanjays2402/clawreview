'use client';

import { useEffect, useMemo, useState } from 'react';

import { AgentDurationBar } from '@/components/charts/agent-duration-bar';
import { LeaderPill } from '@/components/charts/leader-pill';
import { formatMs } from '@/lib/format';

export interface AgentPerfRow {
  agent: string;
  runs: number;
  findings: number;
  avgMs: number;
  errorRate: number;
}

type SortMode = 'avg' | 'total';

/**
 * Agent-performance table with a sort toggle.
 *
 * Two questions an operator asks of agent timing point at different rows:
 *   - "which agent is slowest per run?"  -> sort by average duration
 *   - "which agent dominates the bill?"  -> sort by total wall time (avg x runs)
 * A frequent mid-speed agent can burn far more total time than a rare slow one,
 * so the answer differs. Tick 41 surfaced total time as a column + share track
 * but the table was always pinned slowest-avg-first. This adds a header toggle
 * so the operator can re-sort by either axis and put the row they care about on
 * top.
 *
 * The chosen axis is reflected into the URL as `?sort=avg|total` (shallow, via
 * history.replaceState -- the sort is purely client-side so no server re-fetch
 * is needed), matching the `?days=` param the page already carries. A shared or
 * reloaded trends link then preserves the operator's axis instead of snapping
 * back to the default. The initial value is seeded server-side from the param.
 *
 * Client component (the toggle is interactive); the parent trends page is a
 * server component and passes the raw byAgent rows + the parsed initial sort.
 */
export function AgentPerformanceTable({
  rows,
  initialSort = 'avg',
}: {
  rows: AgentPerfRow[];
  initialSort?: SortMode;
}) {
  const [sort, setSort] = useState<SortMode>(initialSort);

  // Reflect the active axis into the URL without a navigation/re-fetch: the
  // table sorts client-side, so a shallow replaceState is enough to make the
  // link shareable + reload-stable. 'avg' is the default, so it drops the param
  // to keep the canonical URL clean (mirrors how the page omits days=14).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (sort === 'avg') url.searchParams.delete('sort');
    else url.searchParams.set('sort', sort);
    const next = `${url.pathname}${url.search}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, '', next);
    }
  }, [sort]);

  const { sorted, maxAvgMs, totalMsByRow, summedTotalMs, maxTotalMs } = useMemo(() => {
    // Total time per agent = average duration x number of runs.
    const withTotal = rows.map((r) => ({ row: r, totalMs: r.avgMs * Math.max(r.runs, 0) }));
    const summed = withTotal.reduce((a, b) => a + b.totalMs, 0);
    const maxAvg = Math.max(...rows.map((r) => r.avgMs), 1);
    const maxTotal = Math.max(...withTotal.map((w) => w.totalMs), 1);
    // Sort by the active axis, descending, so the heaviest row floats to top.
    const ordered = withTotal
      .slice()
      .sort((a, b) => (sort === 'avg' ? b.row.avgMs - a.row.avgMs : b.totalMs - a.totalMs));
    return {
      sorted: ordered,
      maxAvgMs: maxAvg,
      totalMsByRow: ordered.map((o) => o.totalMs),
      summedTotalMs: summed,
      maxTotalMs: maxTotal,
    };
  }, [rows, sort]);

  return (
    <div className="space-y-2">
      {/* Sort toggle: a tiny segmented control in the same mono/dense language
          as the rest of the page. Re-sorts the table by the chosen axis. */}
      <div className="flex items-center justify-end gap-1.5 font-mono text-[10px] uppercase tracking-wider">
        <span className="text-fg-subtle">sort</span>
        <div className="inline-flex overflow-hidden rounded-sm border border-border-subtle">
          <SortButton active={sort === 'avg'} onClick={() => setSort('avg')}>
            avg
          </SortButton>
          <SortButton active={sort === 'total'} onClick={() => setSort('total')}>
            total
          </SortButton>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] font-mono text-xs">
          <thead className="sticky top-0 z-10 border-b border-border-subtle bg-bg text-left text-[10px] uppercase tracking-wider text-fg-subtle shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
            <tr>
              <th className="py-1.5 font-medium">agent</th>
              <th className="font-medium tabular-nums">runs</th>
              <th className="font-medium tabular-nums">findings</th>
              <th className="w-[30%] font-medium">
                <span className={sort === 'avg' ? 'text-fg' : undefined}>avg duration</span>
              </th>
              <th className="w-[16%] font-medium tabular-nums">
                <span className={sort === 'total' ? 'text-fg' : undefined}>total time</span>
              </th>
              <th className="text-right font-medium tabular-nums">error rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {sorted.map(({ row, totalMs }, i) => {
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
              // The "slowest" / "heaviest" pill follows the active sort axis so
              // the top-row callout always matches what the operator sorted by.
              const isLeader =
                i === 0 &&
                sorted.length > 1 &&
                (sort === 'avg' ? row.avgMs > 0 : totalMs > 0);
              const leaderLabel = sort === 'avg' ? 'slowest' : 'heaviest';
              const leaderTitle =
                sort === 'avg' ? 'slowest agent on average' : 'owns the most total wall time';
              const sharePct = summedTotalMs > 0 ? (totalMs / summedTotalMs) * 100 : 0;
              const ownsMostTotal =
                sorted.length > 1 && summedTotalMs > 0 && totalMs === maxTotalMs;
              return (
                <tr key={row.agent} className="hover:bg-bg-subtle/40">
                  <td className="py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span className="text-fg" title={row.agent}>
                        {row.agent}
                      </span>
                      {isLeader ? (
                        <LeaderPill label={leaderLabel} title={leaderTitle} />
                      ) : null}
                    </span>
                  </td>
                  <td className="tabular-nums text-fg-muted">{row.runs}</td>
                  <td className="tabular-nums text-fg-muted">{row.findings}</td>
                  <td className="pr-3">
                    <span className="flex items-center gap-2">
                      <AgentDurationBar
                        pct={pct}
                        tone={barTone}
                        sharePct={sharePct}
                        shareTone={ownsMostTotal ? 'bg-severity-high/50' : 'bg-fg-subtle/30'}
                        title={`${sharePct.toFixed(sharePct < 10 ? 1 : 0)}% of total agent time`}
                      />
                      <span className="w-12 shrink-0 text-right tabular-nums text-fg-muted">
                        {formatMs(row.avgMs)}
                      </span>
                    </span>
                  </td>
                  <td className="tabular-nums">
                    <span className={ownsMostTotal ? 'text-fg' : 'text-fg-muted'}>
                      {formatMs(totalMs)}
                    </span>
                    <span className="ml-1 text-[10px] text-fg-subtle">
                      {sharePct.toFixed(sharePct < 10 ? 1 : 0)}%
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

      {/* Share-track legend: the duration bar carries a faint sub-track for this
          agent's share of total wall time, but the cue is silent without a key.
          Spell out the two stacked bars once, below the table, so the secondary
          track reads as "% of total" not visual noise. Shown only when there's a
          row to explain. sm:+ keeps it off cramped mobile. */}
      {sorted.length > 0 ? (
        <div className="hidden items-center justify-end gap-1.5 px-1 font-mono text-[10px] text-fg-subtle sm:flex">
          <span className="relative h-1.5 w-6 overflow-hidden rounded-sm bg-bg-muted" aria-hidden>
            <span className="absolute inset-y-0 left-0 w-full bg-fg-subtle/30" />
          </span>
          <span>thin track = share of total agent time</span>
        </div>
      ) : null}
    </div>
  );
}

function SortButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-1.5 py-0.5 transition-colors ${
        active ? 'bg-accent/15 text-fg' : 'text-fg-subtle hover:bg-bg-subtle/60 hover:text-fg-muted'
      }`}
    >
      {children}
    </button>
  );
}
