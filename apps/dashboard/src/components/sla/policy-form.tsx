'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

import type { SlaPolicy } from '@/lib/data';

interface Props {
  defaultPolicy: SlaPolicy;
  current: Partial<SlaPolicy>;
}

const FIELDS: Array<{ key: keyof SlaPolicy; param: string; label: string }> = [
  { key: 'critical', param: 'critical_hours', label: 'Critical' },
  { key: 'high', param: 'high_hours', label: 'High' },
  { key: 'medium', param: 'medium_hours', label: 'Medium' },
  { key: 'low', param: 'low_hours', label: 'Low' },
  { key: 'nit', param: 'nit_hours', label: 'Nit' },
];

export function PolicyForm({ defaultPolicy, current }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [values, setValues] = useState<Record<keyof SlaPolicy, string>>(() => ({
    critical: String(current.critical ?? defaultPolicy.critical),
    high: String(current.high ?? defaultPolicy.high),
    medium: String(current.medium ?? defaultPolicy.medium),
    low: String(current.low ?? defaultPolicy.low),
    nit: String(current.nit ?? defaultPolicy.nit),
  }));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const sp = new URLSearchParams(params?.toString());
    for (const f of FIELDS) {
      const raw = values[f.key].trim();
      if (raw === '' || Number(raw) === defaultPolicy[f.key]) {
        sp.delete(f.param);
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        setError(`${f.label} must be a positive number of hours.`);
        return;
      }
      sp.set(f.param, String(n));
    }
    setError(null);
    startTransition(() => {
      router.push(`/app/sla?${sp.toString()}` as any);
      router.refresh();
    });
  }

  function reset() {
    setValues({
      critical: String(defaultPolicy.critical),
      high: String(defaultPolicy.high),
      medium: String(defaultPolicy.medium),
      low: String(defaultPolicy.low),
      nit: String(defaultPolicy.nit),
    });
    setError(null);
    startTransition(() => {
      router.push('/app/sla' as any);
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-border-subtle bg-bg-subtle/40 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">SLA policy (hours)</div>
          <div className="text-xs text-fg-muted">Override per severity. Blank or default values fall back to the system policy.</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            disabled={pending}
            className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-fg-muted hover:bg-bg-muted disabled:opacity-50"
          >
            Reset
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-bg hover:bg-fg/90 disabled:opacity-50"
          >
            {pending ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-fg-muted">{f.label}</span>
            <input
              inputMode="numeric"
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={String(defaultPolicy[f.key])}
              className="h-8 rounded-md border border-border bg-bg px-2 text-sm tabular-nums focus:border-fg/40 focus:outline-none"
            />
          </label>
        ))}
      </div>
      {error ? (
        <div className="mt-3 text-xs text-rose-500">{error}</div>
      ) : null}
    </form>
  );
}
