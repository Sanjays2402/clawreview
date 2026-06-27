'use client';

import { useState, useTransition } from 'react';

import type { BulkFindingFilter } from '@/lib/data';
import { toast } from '@/components/ui/toaster';

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
        ? `dismiss ${matchCount} finding${matchCount === 1 ? '' : 's'}?`
        : `reopen ${matchCount} finding${matchCount === 1 ? '' : 's'}?`;
    if (!window.confirm(label)) return;
    start(async () => {
      const res =
        kind === 'dismiss'
          ? await bulkDismissAction(reviewId, filter, reason)
          : await bulkReopenAction(reviewId, filter);
      setResult(res);
      // Corner toast on success: the inline message lives in this bar, which
      // scrolls off the top of long filtered lists -- the toast keeps the
      // "dismissed N findings" confirmation visible wherever the operator is.
      if (res.ok && typeof res.updated === 'number') {
        const verb = kind === 'dismiss' ? 'dismissed' : 'reopened';
        // Neutral tone for a bulk dismiss (deactivation), success for reopen --
        // matches the single-finding row toasts so a mixed triage pass reads
        // consistently whether you act on one finding or the whole filter.
        toast(`${verb} ${res.updated} finding${res.updated === 1 ? '' : 's'}`, {
          tone: kind === 'dismiss' ? 'neutral' : 'success',
        });
      } else if (!res.ok) {
        // A bulk action over a large filter is the most painful to silently
        // lose -- surface the failure in the corner too, matching the
        // single-finding error toasts.
        toast(res.error ?? 'bulk action failed', { tone: 'error' });
      }
    });
  }

  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-md border border-border bg-bg-subtle/60 px-2 py-1.5 font-mono text-[11px] sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <span className="uppercase tracking-wider text-fg-subtle">bulk</span>
        <span className="tabular-nums text-fg">{matchCount}</span>
        <span className="text-fg-muted">filtered</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 280))}
          placeholder="reason (optional)"
          className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 text-[11px] text-fg outline-none focus:border-accent sm:max-w-xs"
        />
      </div>
      <div className="flex items-center gap-1.5">
        {result?.message ? (
          <span className={result.ok ? 'text-fg-muted' : 'text-severity-critical'}>
            {result.ok ? result.message : result.error}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => run('dismiss')}
          disabled={!canDismiss || pending}
          className="h-6 rounded-sm border border-border bg-bg px-2 text-fg hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? 'working' : 'dismiss all'}
        </button>
        <button
          type="button"
          onClick={() => run('reopen')}
          disabled={!canReopen || pending}
          className="h-6 rounded-sm border border-border bg-bg px-2 text-fg hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-40"
        >
          reopen all
        </button>
      </div>
    </div>
  );
}
