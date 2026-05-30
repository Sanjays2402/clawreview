'use server';

import { revalidatePath } from 'next/cache';

import { updateBudget } from '@/lib/data';

export async function updateBudgetAction(
  installationId: number,
  limitUsd: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await updateBudget(installationId, limitUsd);
    revalidatePath(`/app/installations/${installationId}/billing`);
    revalidatePath('/app/budget');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to update budget' };
  }
}
