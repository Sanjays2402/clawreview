'use client';
import { useState } from 'react';

export function YamlEditor({ initial = '', onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [val, setVal] = useState(initial);
  return (
    <textarea
      spellCheck={false}
      value={val}
      onChange={(e) => { setVal(e.target.value); onChange?.(e.target.value); }}
      className="font-mono min-h-[240px] w-full rounded-lg border border-border bg-bg-subtle p-3 text-xs leading-relaxed text-fg outline-none focus:border-accent"
    />
  );
}
