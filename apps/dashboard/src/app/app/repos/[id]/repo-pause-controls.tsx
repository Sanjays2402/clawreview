'use client';

import { useTransition } from 'react';
import { PauseCircle, PlayCircle } from '@phosphor-icons/react';

import { toast } from '@/components/ui/toaster';

type RepoAction = (formData: FormData) => Promise<void>;

/**
 * Client wrapper around the pause/resume server-action forms so the operator
 * gets a confirmation. The bare `<form action={serverAction}>` forms succeed
 * silently -- the row re-renders via revalidatePath, but on a long page the
 * status card may be scrolled off, so there's no feedback that the click
 * landed. We run the action inside a transition and fire a corner toast on
 * success, reusing the same global Toaster bus the copy-deep-link button uses.
 *
 * The server actions are passed in as props from the server component (the
 * standard Next pattern) so this stays a thin client shell over the existing
 * pause/resume logic -- no data plumbing moves to the client.
 */
export function RepoPauseControls({
  owner,
  repo,
  isPaused,
  pauseAction,
  resumeAction,
}: {
  owner: string;
  repo: string;
  isPaused: boolean;
  pauseAction: RepoAction;
  resumeAction: RepoAction;
}) {
  const [pending, startTransition] = useTransition();

  function onResume(formData: FormData) {
    startTransition(async () => {
      await resumeAction(formData);
      // Success tone: resuming re-activates reviews on the repo.
      toast(`reviews resumed on ${owner}/${repo}`, { tone: 'success' });
    });
  }

  function onPause(formData: FormData) {
    startTransition(async () => {
      await pauseAction(formData);
      // Neutral tone: pausing is a deactivation, mirroring the resume's success.
      toast(`reviews paused on ${owner}/${repo}`, { tone: 'neutral' });
    });
  }

  if (isPaused) {
    return (
      <form action={onResume} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="owner" value={owner} />
        <input type="hidden" name="repo" value={repo} />
        <p className="font-mono text-[11px] text-fg-muted">
          reviews are paused on this repo. new pull requests will not trigger runs until you resume.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-sm bg-fg px-2.5 py-1 font-mono text-[11px] font-medium lowercase text-bg hover:opacity-90 disabled:opacity-50"
        >
          <PlayCircle size={14} weight="duotone" /> {pending ? 'resuming' : 'resume'}
        </button>
      </form>
    );
  }

  return (
    <form action={onPause} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input type="hidden" name="owner" value={owner} />
      <input type="hidden" name="repo" value={repo} />
      <input
        name="reason"
        type="text"
        maxLength={280}
        placeholder="why are you pausing? (optional)"
        className="h-7 w-full flex-1 rounded-sm border border-border bg-bg px-2 font-mono text-[11px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
      />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg-subtle px-2.5 py-1 font-mono text-[11px] font-medium lowercase text-fg-muted hover:bg-bg-muted hover:text-fg disabled:opacity-50"
      >
        <PauseCircle size={14} weight="duotone" /> {pending ? 'pausing' : 'pause'}
      </button>
    </form>
  );
}
