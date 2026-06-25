import Link from 'next/link';

import type { Severity } from '@/lib/data';

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'nit'];

const BAR: Record<Severity, string> = {
  critical: 'bg-severity-critical',
  high: 'bg-severity-high',
  medium: 'bg-severity-medium',
  low: 'bg-severity-low',
  nit: 'bg-severity-nit',
};

const TXT: Record<Severity, string> = {
  critical: 'text-severity-critical',
  high: 'text-severity-high',
  medium: 'text-severity-medium',
  low: 'text-severity-low',
  nit: 'text-severity-nit',
};

export interface SeverityRowProps {
  counts: Record<Severity, number>;
  total: number;
  /**
   * When provided, each non-empty severity in the legend (and its bar
   * segment) becomes a deep link to the returned href -- e.g. the review
   * detail page points these at the filtered findings view. Severities with
   * a zero count stay inert (filtering to them would show nothing). Omit the
   * prop entirely for a purely presentational row (the overview chart).
   */
  hrefFor?: (sev: Severity) => string;
}

export function SeverityRow({ counts, total, hrefFor }: SeverityRowProps) {
  if (total === 0) {
    return <div className="font-mono text-xs text-fg-subtle">no findings.</div>;
  }
  return (
    <div>
      <div className="flex h-1.5 w-full overflow-hidden rounded-sm bg-bg-muted">
        {ORDER.map((sev) => {
          const v = counts[sev] ?? 0;
          if (v === 0) return null;
          const pct = (v / total) * 100;
          if (hrefFor) {
            return (
              <Link
                key={sev}
                href={hrefFor(sev) as any}
                aria-label={`filter findings to ${sev} (${v})`}
                title={`${sev}: ${v}`}
                className={`${BAR[sev]} block h-full transition-opacity hover:opacity-80`}
                style={{ width: `${pct}%` }}
              />
            );
          }
          return <div key={sev} className={BAR[sev]} style={{ width: `${pct}%` }} aria-label={`${sev}: ${v}`} />;
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-1 gap-y-1 font-mono text-[11px]">
        {ORDER.map((sev) => {
          const v = counts[sev] ?? 0;
          const inner = (
            <>
              <span className={`h-1.5 w-1.5 rounded-full ${BAR[sev]}`} />
              <span className={`uppercase ${TXT[sev]}`}>{sev}</span>
              <span className="tabular-nums text-fg">{v}</span>
            </>
          );
          // Link only when we have a target AND something to filter to.
          if (hrefFor && v > 0) {
            return (
              <Link
                key={sev}
                href={hrefFor(sev) as any}
                aria-label={`filter findings to ${sev} (${v})`}
                className="group inline-flex items-center gap-1.5 rounded-sm border border-transparent px-1.5 py-0.5 transition-colors hover:border-border hover:bg-bg-subtle/60"
              >
                {inner}
                <span className="text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>
                  &rsaquo;
                </span>
              </Link>
            );
          }
          return (
            <div
              key={sev}
              className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 ${v === 0 ? 'opacity-45' : ''}`}
            >
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}
