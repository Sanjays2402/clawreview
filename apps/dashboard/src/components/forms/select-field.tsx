import type { SelectHTMLAttributes } from 'react';

export function SelectField({ label, options, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: Array<{ value: string; label: string }> }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-fg-muted">{label}</label>
      <select className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm text-fg" {...rest}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
