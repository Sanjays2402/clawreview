'use client';

import { useMemo, useState } from 'react';

import { Card, CardBody, CardHeader } from '@clawreview/ui';

import { InteractiveSparkline } from '@/components/charts/interactive-sparkline';
import { formatUsd } from '@/lib/format';

type Metric = 'findings' | 'spend';

/**
 * Per-review trend card with a findings <-> spend toggle. Both series are
 * computed server-side (chronological, oldest -> newest, one point per review)
 * and passed in; the toggle just swaps which the single InteractiveSparkline
 * renders, so a second metric costs no extra chart card. Spend renders through
 * the sparkline's formatValue hook so the hover readout shows `$0.42` rather
 * than `0.42 finding`.
 */
export function RepoTrendCard({
  findings,
  spend,
  labels,
}: {
  findings: number[];
  spend: number[];
  labels: string[];
}) {
  const [metric, setMetric] = useState<Metric>('findings');
  const isFindings = metric === 'findings';
  const series = isFindings ? findings : spend;
  const count = series.length;

  const peak = count > 0 ? Math.max(...series) : 0;
  const sum = series.reduce((a, b) => a + b, 0);
  const avg = count > 0 ? sum / count : 0;

  // Spend outliers: reviews whose cost is a clear spike vs the repo's own
  // average, so a runaway review pops without reading every hover. Threshold
  // is "at least 1.6x the mean AND above an absolute floor" so a repo that's
  // uniformly cheap doesn't light up every tiny wobble. Findings are not
  // marked -- a high finding count is signal, not an anomaly to flag.
  const spendAvg = spend.length > 0 ? spend.reduce((a, b) => a + b, 0) / spend.length : 0;
  const spendMarkers = useMemo(() => {
    if (spendAvg <= 0) return [];
    const floor = Math.max(spendAvg * 1.6, 0.05);
    const out: number[] = [];
    spend.forEach((v, i) => {
      if (v >= floor) out.push(i);
    });
    return out;
  }, [spend, spendAvg]);
  const markers = isFindings ? undefined : spendMarkers;
  const outlierCount = isFindings ? 0 : spendMarkers.length;

  const fmt = (v: number) => (isFindings ? String(Math.round(v)) : formatUsd(v));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
            per review
          </span>
          <div className="flex items-center gap-px font-mono text-[11px]">
            {(['findings', 'spend'] as const).map((m) => {
              const active = m === metric;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMetric(m)}
                  aria-pressed={active}
                  className={`rounded-sm px-1.5 py-0.5 lowercase transition-colors ${
                    active ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'
                  }`}
                >
                  {m}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-fg-muted">
          <span>
            avg <span className="text-fg">{fmt(avg)}</span>
          </span>
          <span className="text-fg-subtle">·</span>
          <span>
            peak <span className="text-fg">{fmt(peak)}</span>
          </span>
          <span className="text-fg-subtle">·</span>
          <span>
            <span className="text-fg">{count}</span> reviews
          </span>
        </div>
      </CardHeader>
      <CardBody>
        <InteractiveSparkline
          key={metric}
          data={series}
          labels={labels}
          width={600}
          height={72}
          unit={isFindings ? 'finding' : 'spend'}
          formatValue={isFindings ? undefined : (v) => formatUsd(v)}
          markers={markers}
          className="w-full"
        />
        <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-fg-subtle">
          <span>oldest</span>
          {outlierCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-fg-muted">
              <span
                className="inline-block h-2 w-2 rounded-full border-[1.5px] border-severity-high"
                aria-hidden
              />
              {outlierCount} cost {outlierCount === 1 ? 'spike' : 'spikes'}
            </span>
          ) : null}
          <span>newest</span>
        </div>
      </CardBody>
    </Card>
  );
}
