'use server';

import { revalidatePath } from 'next/cache';

import { bulkFindingAction, type BulkFindingFilter } from '@/lib/data';

export interface BulkActionResult {
  ok: boolean;
  message?: string;
  matched?: number;
  updated?: number;
  error?: string;
}

export async function bulkDismissAction(
  reviewId: string,
  filter: BulkFindingFilter,
  reason: string | undefined,
): Promise<BulkActionResult> {
  try {
    const res = await bulkFindingAction(reviewId, 'dismiss', filter, reason || undefined);
    revalidatePath(`/app/reviews/${reviewId}/findings`);
    revalidatePath(`/app/reviews/${reviewId}`);
    return {
      ok: true,
      matched: res.matched,
      updated: res.updated,
      message: `Dismissed ${res.updated} of ${res.matched} matching findings.`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Bulk dismiss failed' };
  }
}

export async function bulkReopenAction(
  reviewId: string,
  filter: BulkFindingFilter,
): Promise<BulkActionResult> {
  try {
    const res = await bulkFindingAction(reviewId, 'reopen', filter);
    revalidatePath(`/app/reviews/${reviewId}/findings`);
    revalidatePath(`/app/reviews/${reviewId}`);
    return {
      ok: true,
      matched: res.matched,
      updated: res.updated,
      message: `Reopened ${res.updated} of ${res.matched} matching findings.`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Bulk reopen failed' };
  }
}
