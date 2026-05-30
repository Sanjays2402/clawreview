'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowsClockwise } from '@phosphor-icons/react';

import { rerunReviewAction } from '@/app/app/reviews/actions';
import type { ReviewDetail } from '@/lib/data';

export function RerunForm({ review }: { review: ReviewDetail }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const router = useRouter();

  function onClick() {
    setResult(null);
    startTransition(async () => {
      const res = await rerunReviewAction({
        installationId: review.installationId,
        owner: review.owner,
        repo: review.repo,
        prNumber: review.prNumber,
        headSha: review.headSha,
        baseSha: review.baseSha,
      });
      if (res.ok && res.reviewId) {
        setResult({ ok: true, message: `Queued as ${res.reviewId.slice(0, 8)}` });
        router.push(`/app/reviews/${res.reviewId}` as any);
      } else {
        setResult({ ok: false, message: res.error ?? 'Failed' });
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex h-9 items-center gap-2 rounded-md bg-fg px-3 text-xs font-medium text-bg transition-colors hover:bg-fg/90 disabled:opacity-50"
      >
        <ArrowsClockwise size={14} weight="duotone" className={pending ? 'animate-spin' : ''} />
        {pending ? 'Queueing' : 'Re-run review'}
      </button>
      {result ? (
        <span className={`text-xs ${result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
          {result.message}
        </span>
      ) : null}
    </div>
  );
}
