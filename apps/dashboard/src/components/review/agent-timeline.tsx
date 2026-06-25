'use client';

import { useState } from 'react';
import { CheckCircle, WarningCircle, MinusCircle } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import type { AgentExecutionDto } from '@/lib/data';
import { formatMs } from '@/lib/format';

type AgentStatus = AgentExecutionDto['status'];

const STATUS_BAR: Record<AgentStatus, string> = {
  ok: 'bg-emerald-500/70',
  error: 'bg-severity-critical/70',
  skipped: 'bg-fg-subtle/30',
};

const STATUS_BAR_ACTIVE: Record<AgentStatus, string> = {
  ok: 'bg-emerald-400',
  error: 'bg-severity-critical',
  skipped: 'bg-fg-subtle/60',
};

const STATUS_DOT: Record<AgentStatus, string> = {
  ok: 'text-emerald-400',
  error: 'text-severity-critical',
  skipped: 'text-fg-subtle',
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  ok: 'ok',
  error: 'error',
  skipped: 'skipped',
};

const MIN_BAR_PCT = 1.5; // minimum visible width for a row so a 0-ms run is still clickable-feeling

export function AgentTimeline({ executions }: { executions: AgentExecutionDto[] }) {
  const [active, setActive] = useState<string | null>(null);

  if (executions.length === 0) {
    return <div className="font-mono text-xs text-fg-subtle">no runs.</div>;
  }

  // Order: longest duration first so the "slow agent" pops to the top.
  // Within the same bucket (ok / error / skipped), this gives a nice
  // descending-bar look, exactly like a Linear timing view.
  const sorted = executions.slice().sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  const maxMs = Math.max(...sorted.map((e) => e.durationMs ?? 0), 1);
  const totalMs = sorted.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
  const totalFindings = sorted.reduce((sum, e) => sum + e.findings, 0);
  const totalErrors = sorted.filter((e) => e.status === 'error').length;

  return (
    <div className="space-y-2">
      {/* Summary header */}
      <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-fg-muted">
        <span>
          <span className="tabular-nums text-fg">{sorted.length}</span> agent
          {sorted.length === 1 ? '' : 's'}
        </span>
        <span className="text-fg-subtle">·</span>
        <span>
          <span className="tabular-nums text-fg">{formatMs(totalMs)}</span> total
        </span>
        <span className="text-fg-subtle">·</span>
        <span>
          <span className="tabular-nums text-fg">{totalFindings}</span> finding
          {totalFindings === 1 ? '' : 's'}
        </span>
        {totalErrors > 0 ? (
          <>
            <span className="text-fg-subtle">·</span>
            <span className="text-severity-critical">
              <span className="tabular-nums">{totalErrors}</span> error
              {totalErrors === 1 ? '' : 's'}
            </span>
          </>
        ) : null}
      </div>

      {/* Per-agent timing rows */}
      <ul className="divide-y divide-border-subtle/60 rounded-sm border border-border-subtle">
        {sorted.map((ex) => {
          const ms = ex.durationMs ?? 0;
          const rawPct = (ms / maxMs) * 100;
          const pct = Math.max(rawPct, MIN_BAR_PCT);
          const shareOfTotal = totalMs > 0 ? (ms / totalMs) * 100 : 0;
          const isActive = active === ex.agent;
          return (
            <li
              key={ex.agent}
              tabIndex={0}
              onMouseEnter={() => setActive(ex.agent)}
              onMouseLeave={() => setActive((cur) => (cur === ex.agent ? null : cur))}
              onFocus={() => setActive(ex.agent)}
              onBlur={() => setActive((cur) => (cur === ex.agent ? null : cur))}
              aria-label={`${ex.agent}: ${STATUS_LABEL[ex.status]}, ${formatMs(ms)}, ${ex.findings} finding${ex.findings === 1 ? '' : 's'}, ${shareOfTotal.toFixed(0)}% of total time`}
              className={`group/agent px-2.5 py-1.5 outline-none transition-colors ${
                isActive ? 'bg-accent/[0.06]' : 'hover:bg-bg-subtle/40'
              } focus-visible:bg-accent/[0.08]`}
            >
              <div className="flex items-center gap-2 font-mono text-xs">
                <StatusGlyph status={ex.status} />
                <span className="min-w-[8rem] shrink-0 truncate text-fg" title={ex.agent}>
                  {ex.agent}
                </span>
                <span className="relative h-1.5 flex-1 overflow-hidden rounded-sm bg-bg-muted">
                  <span
                    className={`absolute inset-y-0 left-0 transition-colors ${
                      isActive ? STATUS_BAR_ACTIVE[ex.status] : STATUS_BAR[ex.status]
                    }`}
                    style={{ width: `${pct}%` }}
                    aria-hidden
                  />
                </span>
                <span className={`w-12 shrink-0 text-right tabular-nums ${isActive ? 'text-fg' : 'text-fg-muted'}`}>
                  {formatMs(ms)}
                </span>
                <span className="w-12 shrink-0 text-right tabular-nums text-fg-subtle">
                  {ex.findings}
                </span>
              </div>

              {/* Scrub readout: only the focused/hovered row expands its exact
                  numbers, so the bottleneck's share + findings surface without
                  reading the side columns. */}
              {isActive ? (
                <div className="ml-6 mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-fg-muted animate-fade-in">
                  <span>
                    <span className="text-fg-subtle">dur</span>{' '}
                    <span className="tabular-nums text-fg">{formatMs(ms)}</span>
                  </span>
                  <span>
                    <span className="text-fg-subtle">share</span>{' '}
                    <span className="tabular-nums text-fg">{shareOfTotal.toFixed(shareOfTotal < 10 ? 1 : 0)}%</span>
                  </span>
                  <span>
                    <span className="text-fg-subtle">findings</span>{' '}
                    <span className="tabular-nums text-fg">{ex.findings}</span>
                  </span>
                  <span>
                    <span className="text-fg-subtle">status</span>{' '}
                    <span className={STATUS_DOT[ex.status]}>{STATUS_LABEL[ex.status]}</span>
                  </span>
                </div>
              ) : null}

              {ex.error ? (
                <div className="ml-6 mt-0.5 font-mono text-[11px] text-severity-critical/90">
                  {ex.error}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatusGlyph({ status }: { status: AgentStatus }) {
  const cls = STATUS_DOT[status];
  const label = STATUS_LABEL[status];
  let icon: ReactNode;
  if (status === 'ok') {
    icon = <CheckCircle size={13} weight="duotone" className={`shrink-0 ${cls}`} aria-label={label} />;
  } else if (status === 'error') {
    icon = <WarningCircle size={13} weight="duotone" className={`shrink-0 ${cls}`} aria-label={label} />;
  } else {
    icon = <MinusCircle size={13} weight="duotone" className={`shrink-0 ${cls}`} aria-label={label} />;
  }
  return <Tooltip label={label}>{icon}</Tooltip>;
}
