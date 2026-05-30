'use server';

import { revalidatePath } from 'next/cache';

import { pauseRepo, resumeRepo } from '@/lib/data';

export async function pauseRepoAction(formData: FormData): Promise<void> {
  const owner = String(formData.get('owner') ?? '');
  const repo = String(formData.get('repo') ?? '');
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  if (!owner || !repo) throw new Error('Missing repo');
  await pauseRepo(owner, repo, reason);
  revalidatePath(`/app/repos/${owner}__${repo}`);
  revalidatePath('/app/repos');
}

export async function resumeRepoAction(formData: FormData): Promise<void> {
  const owner = String(formData.get('owner') ?? '');
  const repo = String(formData.get('repo') ?? '');
  if (!owner || !repo) throw new Error('Missing repo');
  await resumeRepo(owner, repo);
  revalidatePath(`/app/repos/${owner}__${repo}`);
  revalidatePath('/app/repos');
}
