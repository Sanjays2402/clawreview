import type { ReactNode } from 'react';
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-border bg-bg-subtle px-1 font-mono text-[10px] font-medium text-fg-muted">
      {children}
    </kbd>
  );
}
