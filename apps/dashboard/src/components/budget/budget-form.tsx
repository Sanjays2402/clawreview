'use client';

import { useState, useTransition } from 'react';

import { updateBudgetAction } from '@/app/app/installations/[id]/billing/actions';

export function BudgetForm({ installationId, currentLimit }: { installationId: number; currentLimit: number }) {
  const [value, setValue] = useState(String(currentLimit));
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n) || n <= 0) {
      setResult({ ok: false, message: 'Enter a positive dollar amount' });
      return;
    }
    setResult(null);
    startTransition(async () => {
      const res = await updateBudgetAction(installationId, n);
      if (res.ok) setResult({ ok: true, message: 'Saved' });
      else setResult({ ok: false, message: res.error ?? 'Failed' });
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <label className="flex items-center gap-2 text-sm text-fg-muted">
        <span>$</span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-9 w-32 rounded-md border border-border bg-bg px-2 text-sm text-fg outline-none focus:border-fg-muted"
        />
        <span className="text-xs text-fg-subtle">per month</span>
      </label>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-9 items-center rounded-md bg-fg px-3 text-xs font-medium text-bg hover:bg-fg/90 disabled:opacity-50"
      >
        {pending ? 'Saving' : 'Save'}
      </button>
      {result ? (
        <span className={`text-xs ${result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
          {result.message}
        </span>
      ) : null}
    </form>
  );
}
