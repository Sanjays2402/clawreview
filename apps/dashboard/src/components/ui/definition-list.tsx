import type { ReactNode } from 'react';
export function DefinitionList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-3 gap-y-2 text-sm">
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="col-span-1 text-fg-muted">{it.label}</dt>
          <dd className="col-span-2 text-fg">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
