'use client';

import { useState, useTransition } from 'react';

import type { BulkFindingFilter } from '@/lib/data';

import { bulkDismissAction, bulkReopenAction, type BulkActionResult } from './actions';

interface Props {
  reviewId: string;
  filter: BulkFindingFilter;
  matchCount: number;
  stateFilter: 'all' | 'open' | 'dismissed';
}

export function BulkFindingsBar({ reviewId, filter, matchCount, stateFilter }: Props) {
  const [pending, start] = useTransition();
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<BulkActionResult | null>(null);

  const canDismiss = stateFilter !== 'dismissed' && matchCount > 0;
  const canReopen = stateFilter !== 'open' && matchCount > 0;

  function run(kind: 'dismiss' | 'reopen') {
    if (matchCount === 0 || pending) return;
    const label =
      kind === 'dismiss'
        ? `Dismiss ${matchCount} matching finding${matchCount === 1 ? '' : 's'}?`
        : `Reopen ${matchCount} matching finding${matchCount === 1 ? '' : 's'}?`;
    if (!window.confirm(label)) return;
    start(async () => {
      const res =
        kind === 'dismiss'
          ? await bulkDismissAction(reviewId, filter, reason)
          : await bulkReopenAction(reviewId, filter);
      setResult(res);
    });
  }

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border bg-bg-subtle p-3 text-xs sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <span className="font-medium text-fg">Bulk action</span>
        <span className="text-fg-muted">
          on {matchCount} filtered finding{matchCount === 1 ? '' : 's'}
        </span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 280))}
          placeholder="Reason (optional)"
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent sm:max-w-xs"
        />
      </div>
      <div className="flex items-center gap-2">
        {result?.message ? (
          <span className={result.ok ? 'text-fg-muted' : 'text-severity-critical'}>
            {result.ok ? result.message : result.error}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => run('dismiss')}
          disabled={!canDismiss || pending}
          className="rounded-md border border-border bg-bg px-3 py-1 text-xs font-medium text-fg hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? 'Working' : 'Dismiss all'}
        </button>
        <button
          type="button"
          onClick={() => run('reopen')}
          disabled={!canReopen || pending}
          className="rounded-md border border-border bg-bg px-3 py-1 text-xs font-medium text-fg hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reopen all
        </button>
      </div>
    </div>
  );
}
