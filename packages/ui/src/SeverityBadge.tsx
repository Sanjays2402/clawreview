import type { Severity } from '@clawreview/types';
import { SEVERITY_LABELS } from '@clawreview/types';

import { cn } from './cn.js';

// Severity pill: monospace, uppercase, colored text + thin border. No fills.
const TONE: Record<Severity, string> = {
  critical: 'text-severity-critical border-severity-critical/40',
  high: 'text-severity-high border-severity-high/40',
  medium: 'text-severity-medium border-severity-medium/40',
  low: 'text-severity-low border-severity-low/40',
  nit: 'text-severity-nit border-severity-nit/40',
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center rounded-sm border bg-transparent px-1.5 font-mono text-[10px] font-medium uppercase tracking-wider',
        TONE[severity],
        className,
      )}
    >
      {SEVERITY_LABELS[severity]}
    </span>
  );
}
