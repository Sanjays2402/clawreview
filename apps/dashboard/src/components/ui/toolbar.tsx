import type { ReactNode } from 'react';
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle/40 px-3 py-2">{children}</div>;
}
