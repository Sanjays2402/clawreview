import type { ReactNode } from 'react';
export function Banner({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'danger'; children: ReactNode }) {
  const tones = { info: 'border-accent/40 bg-accent/5 text-fg', warning: 'border-severity-medium/40 bg-severity-medium/5', danger: 'border-severity-critical/40 bg-severity-critical/5' } as const;
  return <div className={'rounded-lg border px-3 py-2 text-sm ' + tones[tone]}>{children}</div>;
}
