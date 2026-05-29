import type { ReactNode } from 'react';
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-border bg-bg-subtle px-1.5 py-0.5 text-[10px] font-mono text-fg-muted">{children}</kbd>;
}
