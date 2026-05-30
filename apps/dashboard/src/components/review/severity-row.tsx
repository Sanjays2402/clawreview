import type { Severity } from '@/lib/data';

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'nit'];

const COLORS: Record<Severity, { bar: string; dot: string; label: string }> = {
  critical: { bar: 'bg-rose-500', dot: 'bg-rose-500', label: 'text-rose-700 dark:text-rose-300' },
  high: { bar: 'bg-orange-500', dot: 'bg-orange-500', label: 'text-orange-700 dark:text-orange-300' },
  medium: { bar: 'bg-amber-500', dot: 'bg-amber-500', label: 'text-amber-700 dark:text-amber-300' },
  low: { bar: 'bg-sky-500', dot: 'bg-sky-500', label: 'text-sky-700 dark:text-sky-300' },
  nit: { bar: 'bg-zinc-400', dot: 'bg-zinc-400', label: 'text-fg-muted' },
};

export function SeverityRow({ counts, total }: { counts: Record<Severity, number>; total: number }) {
  if (total === 0) {
    return <div className="text-xs text-fg-subtle">No findings yet.</div>;
  }
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-subtle">
        {ORDER.map((sev) => {
          const v = counts[sev] ?? 0;
          if (v === 0) return null;
          const pct = (v / total) * 100;
          return <div key={sev} className={COLORS[sev].bar} style={{ width: `${pct}%` }} aria-label={`${sev}: ${v}`} />;
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {ORDER.map((sev) => (
          <div key={sev} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${COLORS[sev].dot}`} />
            <span className="text-fg-muted capitalize">{sev}</span>
            <span className="font-medium text-fg">{counts[sev] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
