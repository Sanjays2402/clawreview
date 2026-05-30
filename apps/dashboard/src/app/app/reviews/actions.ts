'use server';

import { revalidatePath } from 'next/cache';

import { applyFindingAction, rerunReview, type RerunInput } from '@/lib/data';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export async function dismissFindingAction(
  findingId: string,
  reviewId: string,
  reason: string | undefined,
): Promise<ActionResult> {
  try {
    await applyFindingAction(findingId, 'dismiss', reason || undefined);
    revalidatePath(`/app/reviews/${reviewId}`);
    return { ok: true, message: 'Dismissed' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to dismiss' };
  }
}

export async function reopenFindingAction(
  findingId: string,
  reviewId: string,
): Promise<ActionResult> {
  try {
    await applyFindingAction(findingId, 'reopen');
    revalidatePath(`/app/reviews/${reviewId}`);
    return { ok: true, message: 'Reopened' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to reopen' };
  }
}

export async function rerunReviewAction(input: RerunInput): Promise<ActionResult & { reviewId?: string }> {
  try {
    const res = await rerunReview(input);
    revalidatePath('/app/reviews');
    revalidatePath(`/app/reviews/${res.reviewId}`);
    return { ok: true, message: 'Queued', reviewId: res.reviewId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to queue rerun' };
  }
}
