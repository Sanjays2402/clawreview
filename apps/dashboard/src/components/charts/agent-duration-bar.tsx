/**
 * Shared agent duration bar.
 *
 * Both the per-review AgentTimeline and the trends agent-performance table
 * draw the same idiom: a horizontal bar whose width is an agent's duration
 * normalised to the slowest agent, tinted by health (status / error rate),
 * with an optional faint sub-track showing that agent's share of the total
 * wall time across all agents. Extracting it here keeps the two views in
 * visual lock-step as either evolves, and gives a single place to tune the
 * track heights, min-widths and emphasis treatment.
 *
 * Presentational only -- callers compute the percentages (so each can use its
 * own normalisation basis) and pass tone classes. Tone changes animate via
 * `transition-colors`, so a caller that swaps tone on hover/focus (e.g. the
 * per-review AgentTimeline brightening the active row) gets a smooth crossfade
 * for free. The primary bar is `h-1.5`, the share sub-track `h-[3px]`, matching
 * the existing AgentTimeline rows.
 */

const MIN_BAR_PCT = 1.5;

export interface AgentDurationBarProps {
  /** Primary bar width, 0-100. Clamped to a small minimum so a near-zero
   *  duration is still visible. */
  pct: number;
  /** Tailwind background class for the primary bar (e.g. tint by error rate). */
  tone: string;
  /**
   * Optional share-of-total-time sub-track, 0-100. When provided, a thinner,
   * fainter bar renders under the primary one -- across every row these sum to
   * ~100%, so "where does the time actually go?" is glanceable. Omit for a
   * plain duration bar.
   */
  sharePct?: number;
  /** Background class for the share sub-track. Defaults to a quiet neutral. */
  shareTone?: string;
  /**
   * Emphasise this row (e.g. the slowest / worst agent): the primary bar reads
   * at full strength while the rest can be dimmed by the caller's tone. Adds a
   * subtle ring so the standout row pops in a long sorted list.
   */
  emphasized?: boolean;
  /** Hover title on the share track (e.g. the exact percentage). */
  title?: string;
  className?: string;
}

export function AgentDurationBar({
  pct,
  tone,
  sharePct,
  shareTone = 'bg-fg-subtle/30',
  emphasized = false,
  title,
  className,
}: AgentDurationBarProps) {
  const barPct = Math.max(pct, MIN_BAR_PCT);
  const hasShare = typeof sharePct === 'number';
  return (
    <span className={`flex flex-1 flex-col gap-0.5 ${className ?? ''}`} title={title}>
      <span
        className={`relative h-1.5 w-full overflow-hidden rounded-sm bg-bg-muted ${
          emphasized ? 'ring-1 ring-inset ring-severity-high/40' : ''
        }`}
      >
        <span
          className={`absolute inset-y-0 left-0 transition-colors ${tone}`}
          style={{ width: `${barPct}%` }}
          aria-hidden
        />
      </span>
      {hasShare ? (
        <span className="relative h-[3px] w-full overflow-hidden rounded-full bg-bg-muted/40">
          <span
            className={`absolute inset-y-0 left-0 transition-colors ${shareTone}`}
            style={{ width: `${Math.max(sharePct!, MIN_BAR_PCT)}%` }}
            aria-hidden
          />
        </span>
      ) : null}
    </span>
  );
}
