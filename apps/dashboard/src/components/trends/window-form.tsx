'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

interface Props {
  days: number;
  presets: ReadonlyArray<number>;
}

export function WindowForm({ days, presets }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(String(days));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function apply(next: number) {
    const sp = new URLSearchParams(params?.toString());
    sp.set('days', String(next));
    startTransition(() => {
      router.push(`/app/trends?${sp.toString()}`);
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
      setError('Pick a window between 1 and 90 days.');
      return;
    }
    setError(null);
    apply(parsed);
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setValue(String(p));
              setError(null);
              apply(p);
            }}
            disabled={pending}
            className={`rounded-md border px-2 py-1 text-xs transition-colors ${
              p === days
                ? 'border-fg bg-fg text-bg'
                : 'border-border bg-bg-subtle text-fg-muted hover:bg-bg-muted'
            } disabled:opacity-50`}
          >
            {p}d
          </button>
        ))}
        <form onSubmit={onSubmit} className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={90}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-16 rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-fg focus:outline-none"
            aria-label="Custom window in days"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md border border-border bg-bg-subtle px-2 py-1 text-xs text-fg-muted hover:bg-bg-muted disabled:opacity-50"
          >
            {pending ? 'Loading' : 'Apply'}
          </button>
        </form>
      </div>
      {error ? <div className="text-xs text-rose-500">{error}</div> : null}
    </div>
  );
}
