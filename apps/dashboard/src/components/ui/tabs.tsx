'use client';
import { useState } from 'react';
export function Tabs({ tabs }: { tabs: Array<{ id: string; label: string; content: React.ReactNode }> }) {
  const [active, setActive] = useState(tabs[0]?.id);
  return (
    <div>
      <div className="flex gap-px border-b border-border-subtle font-mono text-[11px]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={
              '-mb-px border-b-2 px-2.5 py-1 lowercase ' +
              (active === t.id ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg')
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="pt-3">{tabs.find((t) => t.id === active)?.content}</div>
    </div>
  );
}
