import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from './cn.js';

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action, className, ...rest }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-subtle bg-bg-subtle/20 px-6 py-8 text-center',
        className,
      )}
      {...rest}
    >
      {icon ? <div className="text-fg-muted">{icon}</div> : null}
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {description ? <p className="max-w-sm text-sm text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
