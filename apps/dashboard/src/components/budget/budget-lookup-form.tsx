'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';

export function BudgetLookupForm() {
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number.parseInt(id.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter a positive integer installation id');
      return;
    }
    setError(null);
    router.push(`/app/installations/${n}/billing` as any);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
      <input
        type="text"
        inputMode="numeric"
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder="e.g. 12345678"
        className="h-9 flex-1 rounded-md border border-border bg-bg px-3 text-sm text-fg outline-none focus:border-fg-muted"
      />
      <button
        type="submit"
        className="inline-flex h-9 items-center justify-center gap-1 rounded-md bg-fg px-3 text-xs font-medium text-bg hover:bg-fg/90"
      >
        <MagnifyingGlass size={14} weight="duotone" />
        Look up
      </button>
      {error ? <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span> : null}
    </form>
  );
}
