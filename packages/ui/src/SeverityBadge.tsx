import type { Severity } from '@clawreview/types';
import { SEVERITY_LABELS } from '@clawreview/types';

import { cn } from './cn.js';

const TONE: Record<Severity, string> = {
  critical: 'bg-severity-critical/15 text-severity-critical border-severity-critical/30',
  high: 'bg-severity-high/15 text-severity-high border-severity-high/30',
  medium: 'bg-severity-medium/15 text-severity-medium border-severity-medium/30',
  low: 'bg-severity-low/15 text-severity-low border-severity-low/30',
  nit: 'bg-severity-nit/15 text-severity-nit border-severity-nit/30',
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] font-semibold uppercase tracking-wide',
        TONE[severity],
        className,
      )}
    >
      {SEVERITY_LABELS[severity]}
    </span>
  );
}
