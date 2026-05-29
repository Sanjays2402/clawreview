'use client';
import { useState } from 'react';
export function Tabs({ tabs }: { tabs: Array<{ id: string; label: string; content: React.ReactNode }> }) {
  const [active, setActive] = useState(tabs[0]?.id);
  return (
    <div>
      <div className="flex gap-1 border-b border-border-subtle">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setActive(t.id)} className={
            'px-3 py-2 text-sm ' + (active === t.id ? 'border-b-2 border-accent text-fg' : 'text-fg-muted hover:text-fg')
          }>{t.label}</button>
        ))}
      </div>
      <div className="pt-4">{tabs.find((t) => t.id === active)?.content}</div>
    </div>
  );
}
