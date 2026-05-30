import type { ReactNode } from 'react';

// Dense page header. Smaller title, mono description tone.
export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 pb-3">
      <div className="min-w-0">
        <h1 className="font-mono text-base font-semibold tracking-tight lowercase">{title}</h1>
        {description ? <p className="mt-0.5 text-xs text-fg-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
