'use client';

import { useState, useTransition } from 'react';
import { ArrowCounterClockwise, X } from '@phosphor-icons/react';

import { SeverityBadge } from '@clawreview/ui';

import type { FindingDto } from '@/lib/data';
import { dismissFindingAction, reopenFindingAction } from '@/app/app/reviews/actions';

export function FindingRow({ finding, reviewId }: { finding: FindingDto; reviewId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [showReason, setShowReason] = useState(false);

  const dismissed = finding.state === 'dismissed';

  function onDismiss() {
    setError(null);
    startTransition(async () => {
      const res = await dismissFindingAction(finding.id, reviewId, reason);
      if (!res.ok) setError(res.error ?? 'Failed');
      else {
        setShowReason(false);
        setReason('');
      }
    });
  }

  function onReopen() {
    setError(null);
    startTransition(async () => {
      const res = await reopenFindingAction(finding.id, reviewId);
      if (!res.ok) setError(res.error ?? 'Failed');
    });
  }

  return (
    <li className={`py-4 ${dismissed ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="font-mono text-xs text-fg-muted">
          {finding.file}
          {finding.line ? `:${finding.line}` : ''}
        </span>
        <span className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
          {finding.agent}
        </span>
        {dismissed ? (
          <span className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
            Dismissed
          </span>
        ) : null}
      </div>
      <div className={`mt-1 font-medium text-fg ${dismissed ? 'line-through decoration-fg-subtle' : ''}`}>
        {finding.title}
      </div>
      <div className="mt-1 text-sm text-fg-muted">{finding.rationale}</div>

      {finding.suggestedPatch ? (
        <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-border-subtle bg-bg-subtle/50 p-3 font-mono text-[11px] leading-relaxed text-fg">
          {finding.suggestedPatch}
        </pre>
      ) : null}

      {dismissed && finding.dismissReason ? (
        <div className="mt-2 text-xs text-fg-subtle">Reason: {finding.dismissReason}</div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {dismissed ? (
          <button
            type="button"
            onClick={onReopen}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-subtle px-2 py-1 text-fg-muted hover:bg-bg-muted disabled:opacity-50"
          >
            <ArrowCounterClockwise size={14} weight="duotone" />
            {pending ? 'Reopening' : 'Reopen'}
          </button>
        ) : showReason ? (
          <>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional)"
              maxLength={280}
              className="h-8 w-full max-w-xs rounded-md border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-fg-muted sm:w-64"
            />
            <button
              type="button"
              onClick={onDismiss}
              disabled={pending}
              className="inline-flex h-8 items-center rounded-md bg-fg px-2 text-xs font-medium text-bg disabled:opacity-50"
            >
              {pending ? 'Dismissing' : 'Confirm dismiss'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowReason(false);
                setReason('');
              }}
              className="inline-flex h-8 items-center rounded-md border border-border bg-bg-subtle px-2 text-xs text-fg-muted hover:bg-bg-muted"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setShowReason(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-subtle px-2 py-1 text-fg-muted hover:bg-bg-muted"
          >
            <X size={14} weight="duotone" />
            Dismiss
          </button>
        )}
        {error ? <span className="text-rose-600 dark:text-rose-400">{error}</span> : null}
      </div>
    </li>
  );
}
