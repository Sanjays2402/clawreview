/**
 * Shared "leader" callout pill.
 *
 * Both the per-review AgentTimeline ("slowest") and the trends agent-performance
 * table ("slowest" / "heaviest") flag the standout row with a byte-identical
 * little pill: a severity-high tinted, uppercase, hairline-bordered badge that
 * sits next to the agent name. Tick 41 shared the duration bar between the two
 * views; this extracts the pill too so the callout stays in visual lock-step as
 * either evolves, and a future third caller (an SLA / cost leaderboard, say)
 * reuses one definition instead of re-pasting the class string.
 *
 * Presentational only: the caller decides WHEN a row is the leader and WHAT to
 * call it (label + hover title), since "slowest on average" and "owns the most
 * total time" point at different rows.
 */

export interface LeaderPillProps {
  /** Short uppercase label, e.g. "slowest" or "heaviest". */
  label: string;
  /** Hover title explaining why this row leads, e.g. "slowest agent on average". */
  title?: string;
  className?: string;
}

export function LeaderPill({ label, title, className }: LeaderPillProps) {
  return (
    <span
      className={`shrink-0 rounded-sm border border-severity-high/40 bg-severity-high/10 px-1 text-[9px] uppercase tracking-wider text-severity-high ${
        className ?? ''
      }`}
      title={title}
    >
      {label}
    </span>
  );
}
