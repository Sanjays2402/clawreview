'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowsClockwise } from '@phosphor-icons/react';

import { toast } from '@/components/ui/toaster';
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
        setResult({ ok: true, message: `queued ${res.reviewId.slice(0, 8)}` });
        // The router.push below replaces this page immediately, so the inline
        // message never gets read. The corner toast lives in the app shell and
        // survives the navigation, confirming the re-run on the new review page.
        // Info tone: a queued job is pending work, not a completed state change.
        toast('review re-run queued', { tone: 'info' });
        router.push(`/app/reviews/${res.reviewId}` as any);
      } else {
        setResult({ ok: false, message: res.error ?? 'failed' });
        // No navigation happens on failure, so the inline message does read --
        // but fire the error toast too for parity with the success path and so
        // a failed re-run is unmissable if the button has scrolled off.
        toast(res.error ?? 're-run failed', { tone: 'error' });
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex h-7 items-center gap-1.5 rounded-sm bg-accent px-2 font-mono text-[11px] font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        <ArrowsClockwise size={12} weight="bold" className={pending ? 'animate-spin' : ''} />
        {pending ? 'queueing' : 're-run'}
      </button>
      {result ? (
        <span className={`font-mono text-[11px] ${result.ok ? 'text-emerald-400' : 'text-severity-critical'}`}>
          {result.message}
        </span>
      ) : null}
    </div>
  );
}
