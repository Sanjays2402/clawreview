'use client';

import { useRef, useState } from 'react';
import { CheckCircle, WarningCircle, MinusCircle } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import { AgentDurationBar } from '@/components/charts/agent-duration-bar';
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
  // Which row currently holds DOM focus (null = none / mouse-only). Distinct
  // from `active` (which also fires on hover) so the keyboard discoverability
  // hint never shows for a mouse user just gliding over rows.
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  // Flips true the first time the user actually presses an arrow / Home / End.
  // Once they've discovered the scrub keys we stop advertising them.
  const [scrubbed, setScrubbed] = useState(false);
  // Per-row DOM handles (by sorted index) so Up/Down arrow keys can rove
  // focus between rows without a focus trap or external library.
  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);

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

  // The bottleneck is the slowest agent (index 0 after the sort), but only
  // call it out when there's a real contest: 2+ agents AND it actually owns
  // a meaningful slice of wall time (>= 40%). A near-even split has no single
  // bottleneck worth flagging.
  const slowestShare = totalMs > 0 ? ((sorted[0]?.durationMs ?? 0) / totalMs) * 100 : 0;
  const bottleneckAgent =
    sorted.length >= 2 && (sorted[0]?.durationMs ?? 0) > 0 && slowestShare >= 40
      ? sorted[0]!.agent
      : null;

  function focusRow(i: number) {
    const clamped = Math.max(0, Math.min(i, sorted.length - 1));
    rowRefs.current[clamped]?.focus();
  }

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
        {sorted.length > 1 ? (
          <span className="ml-auto hidden items-center gap-1 text-fg-subtle sm:inline-flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span>scrub</span>
          </span>
        ) : null}
      </div>

      {/* Per-agent timing rows */}
      <ul className="divide-y divide-border-subtle/60 rounded-sm border border-border-subtle">
        {sorted.map((ex, i) => {
          const ms = ex.durationMs ?? 0;
          const rawPct = (ms / maxMs) * 100;
          const pct = Math.max(rawPct, MIN_BAR_PCT);
          const shareOfTotal = totalMs > 0 ? (ms / totalMs) * 100 : 0;
          const isActive = active === ex.agent;
          const isBottleneck = bottleneckAgent === ex.agent;
          return (
            <li
              key={ex.agent}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              tabIndex={0}
              onMouseEnter={() => setActive(ex.agent)}
              onMouseLeave={() => setActive((cur) => (cur === ex.agent ? null : cur))}
              onFocus={() => {
                setActive(ex.agent);
                setFocusedIdx(i);
              }}
              onBlur={() => {
                setActive((cur) => (cur === ex.agent ? null : cur));
                setFocusedIdx((cur) => (cur === i ? null : cur));
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setScrubbed(true);
                  focusRow(i + 1);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setScrubbed(true);
                  focusRow(i - 1);
                } else if (e.key === 'Home') {
                  e.preventDefault();
                  setScrubbed(true);
                  focusRow(0);
                } else if (e.key === 'End') {
                  e.preventDefault();
                  setScrubbed(true);
                  focusRow(sorted.length - 1);
                }
              }}
              aria-label={`${ex.agent}: ${STATUS_LABEL[ex.status]}, ${formatMs(ms)}, ${ex.findings} finding${ex.findings === 1 ? '' : 's'}, ${shareOfTotal.toFixed(0)}% of total time${isBottleneck ? ', slowest agent' : ''}`}
              className={`group/agent px-2.5 py-1.5 outline-none transition-colors ${
                isActive ? 'bg-accent/[0.06]' : 'hover:bg-bg-subtle/40'
              } focus-visible:bg-accent/[0.08] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40`}
            >
              <div className="flex items-center gap-2 font-mono text-xs">
                <StatusGlyph status={ex.status} />
                <span className="flex min-w-[8rem] shrink-0 items-center gap-1.5">
                  <span className="truncate text-fg" title={ex.agent}>
                    {ex.agent}
                  </span>
                  {isBottleneck ? (
                    <span
                      className="shrink-0 rounded-sm border border-severity-high/40 bg-severity-high/10 px-1 text-[9px] uppercase tracking-wider text-severity-high"
                      title={`slowest agent: ${shareOfTotal.toFixed(0)}% of total time`}
                    >
                      slowest
                    </span>
                  ) : null}
                </span>
                <AgentDurationBar
                  pct={pct}
                  tone={isActive ? STATUS_BAR_ACTIVE[ex.status] : STATUS_BAR[ex.status]}
                  sharePct={shareOfTotal}
                  shareTone={
                    isBottleneck
                      ? 'bg-severity-high/50'
                      : isActive
                        ? 'bg-accent/45'
                        : 'bg-fg-subtle/30'
                  }
                  title={`${shareOfTotal.toFixed(shareOfTotal < 10 ? 1 : 0)}% of total time`}
                />
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

              {/* First-Tab discoverability: the moment a keyboard user lands on
                  a row (focus, not hover) we surface the scrub keys inline --
                  the header hint is easy to miss once you've Tabbed past it.
                  Suppressed the instant they actually press an arrow, and only
                  shown when there's more than one row to move between. */}
              {focusedIdx === i && !scrubbed && sorted.length > 1 ? (
                <div className="ml-6 mt-1 inline-flex items-center gap-1 font-mono text-[10px] text-fg-subtle animate-fade-in">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                  <span>move between agents</span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-border bg-bg-subtle px-1 text-[10px] leading-none text-fg-muted">
      {children}
    </kbd>
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
