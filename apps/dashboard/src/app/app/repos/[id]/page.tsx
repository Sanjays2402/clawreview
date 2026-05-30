import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GitPullRequest, PauseCircle, PlayCircle } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { StatusPill } from '@/components/review/status-pill';
import { getRepoHealth, listReviews, type RepoHealth } from '@/lib/data';
import { formatMs, formatRelative, formatUsd } from '@/lib/format';

import { pauseRepoAction, resumeRepoAction } from './actions';

function parseSlug(id: string): { owner: string; repo: string } | null {
  const idx = id.indexOf('__');
  if (idx <= 0 || idx === id.length - 2) return null;
  return { owner: id.slice(0, idx), repo: id.slice(idx + 2) };
}

function statusTone(s: RepoHealth['status']): string {
  if (s === 'healthy') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  if (s === 'degraded') return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
  return 'bg-rose-500/10 text-rose-600 dark:text-rose-400';
}

export default async function RepoDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const slug = parseSlug(id);
  if (!slug) notFound();

  const [health, reviewsRes] = await Promise.all([
    getRepoHealth(slug.owner, slug.repo),
    listReviews({ limit: 20, owner: slug.owner, repo: slug.repo }),
  ]);

  if (!health) notFound();

  const reviews = reviewsRes.items;
  const isPaused = health.status === 'paused';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title={`${slug.owner}/${slug.repo}`}
          description="repo health, recent reviews, pause controls."
        />
        <Link href="/app/repos" className="text-xs text-fg-muted hover:text-fg">
          Back to repos
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardBody>
            <div className="text-xs uppercase tracking-wide text-fg-subtle">Status</div>
            <div className="mt-2">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-sm font-medium ${statusTone(health.status)}`}
              >
                {health.status}
              </span>
            </div>
            {health.pauseReason ? (
              <div className="mt-2 text-xs text-fg-muted">{health.pauseReason}</div>
            ) : null}
            {health.pausedUntil ? (
              <div className="mt-1 text-xs text-fg-subtle">
                Until {new Date(health.pausedUntil).toLocaleString()}
              </div>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs uppercase tracking-wide text-fg-subtle">Recent failures</div>
            <div className="mt-2 text-2xl font-semibold tracking-tight">{health.failures}</div>
            <div className="mt-1 text-xs text-fg-muted">Consecutive review failures</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs uppercase tracking-wide text-fg-subtle">Last review</div>
            <div className="mt-2 text-sm font-medium text-fg">
              {health.lastReviewAt ? formatRelative(health.lastReviewAt) : 'never'}
            </div>
            <div className="mt-1 text-xs text-fg-muted">
              {health.lastReviewAt
                ? new Date(health.lastReviewAt).toLocaleString()
                : 'No reviews recorded yet'}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="text-sm font-medium">
            {isPaused ? 'Resume reviews' : 'Pause reviews'}
          </div>
        </CardHeader>
        <CardBody>
          {isPaused ? (
            <form action={resumeRepoAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="owner" value={slug.owner} />
              <input type="hidden" name="repo" value={slug.repo} />
              <p className="text-sm text-fg-muted">
                Reviews are paused on this repo. New pull requests will not trigger runs until you resume.
              </p>
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-bg hover:opacity-90"
              >
                <PlayCircle size={16} weight="duotone" /> Resume
              </button>
            </form>
          ) : (
            <form
              action={pauseRepoAction}
              className="flex flex-col gap-3 sm:flex-row sm:items-center"
            >
              <input type="hidden" name="owner" value={slug.owner} />
              <input type="hidden" name="repo" value={slug.repo} />
              <input
                name="reason"
                type="text"
                maxLength={280}
                placeholder="Why are you pausing? (optional)"
                className="w-full flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm placeholder:text-fg-subtle focus:border-fg focus:outline-none"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-sm font-medium hover:bg-bg-subtle/70"
              >
                <PauseCircle size={16} weight="duotone" /> Pause
              </button>
            </form>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Recent reviews</div>
            <div className="text-xs text-fg-muted">
              {reviews.length} result{reviews.length === 1 ? '' : 's'}
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {reviews.length === 0 ? (
            <EmptyState
              icon={<GitPullRequest size={28} weight="duotone" />}
              title="No reviews yet"
              description="When a pull request is opened on this repo, the review will appear here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="py-2 font-medium">PR</th>
                    <th className="font-medium">Status</th>
                    <th className="font-medium">Findings</th>
                    <th className="font-medium">Duration</th>
                    <th className="font-medium">Spend</th>
                    <th className="text-right font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {reviews.map((r) => (
                    <tr key={r.id} className="hover:bg-bg-subtle/40">
                      <td className="py-3">
                        <Link href={`/app/reviews/${r.id}` as any} className="block">
                          <div className="font-medium text-fg">#{r.prNumber}</div>
                          <div className="font-mono text-[11px] text-fg-subtle">
                            {r.headSha.slice(0, 8)}
                          </div>
                        </Link>
                      </td>
                      <td><StatusPill status={r.status} /></td>
                      <td className="text-fg-muted">
                        <span className="font-medium text-fg">{r.openFindings}</span>
                        <span className="text-fg-subtle"> / {r.totalFindings}</span>
                      </td>
                      <td className="text-fg-muted">{formatMs(r.durationMs)}</td>
                      <td className="text-fg-muted">{formatUsd(r.totalCostUsd)}</td>
                      <td className="text-right text-fg-muted">{formatRelative(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
