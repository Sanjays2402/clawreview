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

export function SeverityRow({ counts, total }: { counts: Record<Severity, number>; total: number }) {
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
          return <div key={sev} className={BAR[sev]} style={{ width: `${pct}%` }} aria-label={`${sev}: ${v}`} />;
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
        {ORDER.map((sev) => (
          <div key={sev} className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${BAR[sev]}`} />
            <span className={`uppercase ${TXT[sev]}`}>{sev}</span>
            <span className="tabular-nums text-fg">{counts[sev] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
