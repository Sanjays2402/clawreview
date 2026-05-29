import type { HTMLAttributes } from 'react';

import { cn } from './cn.js';

export function Stat({
  label,
  value,
  delta,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { label: string; value: string | number; delta?: string }) {
  return (
    <div className={cn('rounded-xl border border-border bg-bg-subtle/40 px-4 py-3', className)} {...rest}>
      <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-2xl font-semibold tracking-tight text-fg">{value}</div>
        {delta ? <div className="text-xs text-fg-muted">{delta}</div> : null}
      </div>
    </div>
  );
}
