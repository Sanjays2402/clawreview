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
    <div className={cn('rounded-md border border-border bg-bg-subtle/40 px-3 py-2', className)} {...rest}>
      <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <div className="text-xl font-semibold tracking-tight text-fg tabular-nums">{value}</div>
        {delta ? <div className="font-mono text-xs text-fg-muted">{delta}</div> : null}
      </div>
    </div>
  );
}
