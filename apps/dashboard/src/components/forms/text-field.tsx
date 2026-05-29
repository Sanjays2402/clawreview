import type { InputHTMLAttributes } from 'react';

export function TextField({ label, hint, error, id, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const inputId = id ?? rest.name;
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="text-xs font-medium text-fg-muted">{label}</label>
      <input
        id={inputId}
        className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
        {...rest}
      />
      {error ? <div className="text-xs text-severity-high">{error}</div> : hint ? <div className="text-xs text-fg-subtle">{hint}</div> : null}
    </div>
  );
}
