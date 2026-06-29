'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

interface Props {
  days: number;
  presets: ReadonlyArray<number>;
}

export function WindowForm({ days, presets }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(String(days));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function apply(next: number) {
    // Read the LIVE search string rather than useSearchParams: the agent-table
    // sort toggle writes `?sort=` via history.replaceState, which Next's
    // useSearchParams hook does not observe. Reading window.location here keeps
    // any client-set param (e.g. the chosen sort axis) intact when the window
    // changes, instead of silently dropping it on the navigation.
    const sp = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    sp.set('days', String(next));
    startTransition(() => {
      router.push(`/app/trends?${sp.toString()}`);
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
      setError('pick a window between 1 and 90 days.');
      return;
    }
    setError(null);
    apply(parsed);
  }

  return (
    <div className="flex flex-col items-end gap-1.5 font-mono">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {/* Segmented preset control: dense accent-tinted toggle matching the
            agent-table sort toggle + repo-trend metric switch, rather than the
            old heavy border-fg/bg-fg pill. The active window reads as a quiet
            accent fill, inactive presets stay muted. */}
        <div className="inline-flex overflow-hidden rounded-sm border border-border-subtle">
          {presets.map((p) => {
            const active = p === days;
            return (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setValue(String(p));
                  setError(null);
                  apply(p);
                }}
                disabled={pending}
                aria-pressed={active}
                className={`px-2 py-0.5 tabular-nums transition-colors disabled:opacity-50 ${
                  active
                    ? 'bg-accent/15 text-fg'
                    : 'text-fg-subtle hover:bg-bg-subtle/60 hover:text-fg-muted'
                }`}
              >
                {p}d
              </button>
            );
          })}
        </div>
        <form onSubmit={onSubmit} className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={90}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-14 rounded-sm border border-border bg-bg px-2 py-0.5 tabular-nums text-fg outline-none ring-accent/60 focus:border-accent focus-visible:ring-1"
            aria-label="custom window in days"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-sm border border-border bg-bg-subtle px-2 py-0.5 lowercase text-fg-muted outline-none ring-accent/60 transition-colors hover:bg-bg-muted hover:text-fg focus-visible:ring-1 disabled:opacity-50"
          >
            {pending ? 'loading' : 'apply'}
          </button>
        </form>
      </div>
      {error ? <div className="text-[11px] text-severity-critical">{error}</div> : null}
    </div>
  );
}
