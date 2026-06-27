'use client';

import { useId, useMemo, useState } from 'react';

export interface InteractiveSparklineProps {
  data: number[];
  /** Optional label per bucket; index-aligned with `data`. Falls back to `#i`. */
  labels?: string[];
  width?: number;
  height?: number;
  className?: string;
  /** Singular unit shown in the hover readout, e.g. "finding". */
  unit?: string;
  /**
   * Optional custom renderer for the active bucket's value in the hover
   * readout. When provided it fully replaces the default `{v} {unit}{plural}`
   * text -- e.g. a spend series can render `$0.42` instead of `0.42 finding`.
   * Receives the raw bucket value.
   */
  formatValue?: (v: number) => string;
  /**
   * Bucket indices to flag as outliers. Each gets an always-visible hollow
   * ring (in {@link markerColor}) so a spike reads at a glance without
   * hovering -- e.g. a review whose spend is well above the repo average.
   * Out-of-range indices are ignored.
   */
  markers?: number[];
  /**
   * Stroke color for the outlier rings. A plain CSS color string (not a
   * Tailwind class) so the SVG renders regardless of JIT class generation;
   * the severity palette is static hex across themes. Defaults to the
   * `severity.high` token (#f97316).
   */
  markerColor?: string;
}

interface Pt {
  x: number;
  y: number;
  v: number;
  label: string;
}

/**
 * Hover-aware sparkline. Renders the same terse polyline as the static UI
 * primitive, but adds:
 *  - an invisible full-height hit-target per bucket (generous hover zone),
 *  - a highlighted dot + vertical guide on the active bucket,
 *  - a floating readout (value + label) that tracks the cursor bucket and
 *    flips side near the right edge so it never clips.
 *
 * Keyboard accessible: focus the chart and use Left/Right to move the
 * cursor, Home/End to jump to the ends, Escape to clear.
 */
export function InteractiveSparkline({
  data,
  labels,
  width = 600,
  height = 48,
  className,
  unit = 'finding',
  formatValue,
  markers,
  markerColor = '#f97316',
}: InteractiveSparklineProps) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);

  const { pts, min, max } = useMemo(() => {
    if (data.length === 0) return { pts: [] as Pt[], min: 0, max: 0 };
    const lo = Math.min(...data);
    const hi = Math.max(...data);
    const span = hi - lo || 1;
    const stepX = data.length === 1 ? 0 : width / (data.length - 1);
    const points: Pt[] = data.map((v, i) => ({
      x: i * stepX,
      y: height - ((v - lo) / span) * (height - 4) - 2,
      v,
      label: labels?.[i] ?? `#${i + 1}`,
    }));
    return { pts: points, min: lo, max: hi };
  }, [data, labels, width, height]);

  const markerSet = useMemo(() => {
    const s = new Set<number>();
    for (const m of markers ?? []) {
      if (Number.isInteger(m) && m >= 0 && m < data.length) s.add(m);
    }
    return s;
  }, [markers, data.length]);

  if (pts.length === 0) {
    return <svg width={width} height={height} className={className} />;
  }

  const polyline = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const area = `0,${height} ${polyline} ${width},${height}`;
  const cur = active != null ? pts[active] : null;
  const bucketW = pts.length > 1 ? width / pts.length : width;

  function move(delta: number) {
    setActive((prev) => {
      const start = prev ?? 0;
      const next = Math.max(0, Math.min(pts.length - 1, start + delta));
      return next;
    });
  }

  return (
    <div className={`relative ${className ?? ''}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`findings per bucket, ${min} min, ${max} max`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            move(1);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            move(-1);
          } else if (e.key === 'Home') {
            e.preventDefault();
            setActive(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            setActive(pts.length - 1);
          } else if (e.key === 'Escape') {
            setActive(null);
          }
        }}
        onMouseLeave={() => setActive(null)}
        className="block overflow-visible rounded-sm outline-none ring-accent/50 focus-visible:ring-1"
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity="0.18" />
            <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${id}-fill)`} stroke="none" />
        <polyline
          points={polyline}
          fill="none"
          stroke="hsl(var(--accent))"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Outlier rings: always-visible hollow markers so a spike (e.g. a
            costly review) reads without hovering. Drawn under the active
            cursor dot so hovering an outlier still shows the filled accent
            dot on top. */}
        {markerSet.size > 0
          ? pts.map((p, i) =>
              markerSet.has(i) ? (
                <circle
                  key={`mk-${i}`}
                  cx={p.x}
                  cy={p.y}
                  r={3.5}
                  fill="none"
                  stroke={markerColor}
                  strokeWidth={1.5}
                />
              ) : null,
            )
          : null}
        {cur ? (
          <>
            <line
              x1={cur.x}
              y1={0}
              x2={cur.x}
              y2={height}
              stroke="hsl(var(--accent))"
              strokeWidth={1}
              strokeOpacity={0.35}
              strokeDasharray="2 2"
            />
            <circle cx={cur.x} cy={cur.y} r={3} fill="hsl(var(--accent))" stroke="hsl(var(--bg))" strokeWidth={1.5} />
          </>
        ) : null}
        {/* Per-bucket hit targets */}
        {pts.map((p, i) => (
          <rect
            key={i}
            x={Math.max(0, p.x - bucketW / 2)}
            y={0}
            width={bucketW}
            height={height}
            fill="transparent"
            onMouseEnter={() => setActive(i)}
          />
        ))}
      </svg>
      {cur ? (
        <div
          className={`pointer-events-none absolute -top-1 z-10 -translate-y-full whitespace-nowrap rounded-sm border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg shadow-md animate-fade-in ${
            active != null && active > pts.length / 2 ? '-translate-x-full' : ''
          }`}
          style={{ left: `${(cur.x / width) * 100}%` }}
        >
          {formatValue ? (
            <span className="tabular-nums font-semibold text-fg">{formatValue(cur.v)}</span>
          ) : (
            <>
              <span className="tabular-nums font-semibold text-fg">{cur.v}</span>{' '}
              <span className="text-fg-muted">
                {unit}
                {cur.v === 1 ? '' : 's'}
              </span>
            </>
          )}
          <span className="ml-1 text-fg-subtle">· {cur.label}</span>
        </div>
      ) : null}
    </div>
  );
}
