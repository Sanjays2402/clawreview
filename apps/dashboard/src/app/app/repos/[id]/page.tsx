import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, GitPullRequest, PauseCircle, PlayCircle } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { StatusPill } from '@/components/review/status-pill';
import { ListKeyboardNav } from '@/components/list-keyboard-nav';
import { InteractiveSparkline } from '@/components/charts/interactive-sparkline';
import { Kbd } from '@/components/ui/kbd';
import { LiveRelativeTime } from '@/components/ui/live-relative-time';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import { getRepoHealth, listReviews, type RepoHealth } from '@/lib/data';
import { formatMs, formatUsd } from '@/lib/format';

import { pauseRepoAction, resumeRepoAction } from './actions';

function parseSlug(id: string): { owner: string; repo: string } | null {
  const idx = id.indexOf('__');
  if (idx <= 0 || idx === id.length - 2) return null;
  return { owner: id.slice(0, idx), repo: id.slice(idx + 2) };
}

function statusTone(s: RepoHealth['status']): string {
  if (s === 'healthy') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  if (s === 'degraded') return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400';
  return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400';
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

  // Findings-per-review trend. `listReviews` returns newest-first; reverse to
  // chronological (oldest -> newest) so the sparkline reads left-to-right like
  // every other chart in the dashboard. Each point is one review's total
  // findings, labelled by PR number so the hover readout is legible. Only
  // worth drawing when there are at least two reviews to connect.
  const chronological = reviews.slice().reverse();
  const findingsSeries = chronological.map((r) => r.totalFindings);
  const findingsLabels = chronological.map((r) => `#${r.prNumber}`);
  const showTrend = chronological.length >= 2;
  const peakFindings = findingsSeries.length > 0 ? Math.max(...findingsSeries) : 0;
  const avgFindings =
    findingsSeries.length > 0
      ? Math.round(findingsSeries.reduce((a, b) => a + b, 0) / findingsSeries.length)
      : 0;

  return (
    <div className="space-y-3">
      <ListKeyboardNav selector="[data-review-row]" enabled={reviews.length > 0} />

      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title={`${slug.owner}/${slug.repo}`}
          description="repo health, recent reviews, pause controls."
        />
        <Link
          href="/app/repos"
          className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-fg-muted hover:text-fg"
        >
          <ArrowLeft size={11} weight="bold" /> repos
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardBody>
            <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">status</div>
            <div className="mt-2">
              <span
                className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium lowercase ${statusTone(health.status)}`}
              >
                {health.status}
              </span>
            </div>
            {health.pauseReason ? (
              <div className="mt-2 font-mono text-[11px] text-fg-muted">{health.pauseReason}</div>
            ) : null}
            {health.pausedUntil ? (
              <div className="mt-1 font-mono text-[11px] text-fg-subtle">
                until {new Date(health.pausedUntil).toLocaleString()}
              </div>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">recent failures</div>
            <div className={`mt-2 font-mono text-2xl font-semibold tabular-nums tracking-tight ${health.failures > 0 ? 'text-severity-high' : 'text-fg'}`}>
              {health.failures}
            </div>
            <div className="mt-1 font-mono text-[11px] text-fg-muted">consecutive review failures</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">last review</div>
            <div className="mt-2 font-mono text-sm font-medium text-fg">
              {health.lastReviewAt ? (
                <LiveRelativeTime iso={health.lastReviewAt} />
              ) : (
                <span className="text-fg-subtle">never</span>
              )}
            </div>
            <div className="mt-1 font-mono text-[11px] text-fg-muted">
              {health.lastReviewAt
                ? new Date(health.lastReviewAt).toLocaleString()
                : 'no reviews recorded yet'}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
            {isPaused ? 'resume reviews' : 'pause reviews'}
          </div>
        </CardHeader>
        <CardBody>
          {isPaused ? (
            <form action={resumeRepoAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="owner" value={slug.owner} />
              <input type="hidden" name="repo" value={slug.repo} />
              <p className="font-mono text-[11px] text-fg-muted">
                reviews are paused on this repo. new pull requests will not trigger runs until you resume.
              </p>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-sm bg-fg px-2.5 py-1 font-mono text-[11px] font-medium lowercase text-bg hover:opacity-90"
              >
                <PlayCircle size={14} weight="duotone" /> resume
              </button>
            </form>
          ) : (
            <form
              action={pauseRepoAction}
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
            >
              <input type="hidden" name="owner" value={slug.owner} />
              <input type="hidden" name="repo" value={slug.repo} />
              <input
                name="reason"
                type="text"
                maxLength={280}
                placeholder="why are you pausing? (optional)"
                className="h-7 w-full flex-1 rounded-sm border border-border bg-bg px-2 font-mono text-[11px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg-subtle px-2.5 py-1 font-mono text-[11px] font-medium lowercase text-fg-muted hover:bg-bg-muted hover:text-fg"
              >
                <PauseCircle size={14} weight="duotone" /> pause
              </button>
            </form>
          )}
        </CardBody>
      </Card>

      {showTrend ? (
        <Card>
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
              findings per review
            </div>
            <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-fg-muted">
              <span>
                avg <span className="text-fg">{avgFindings}</span>
              </span>
              <span className="text-fg-subtle">·</span>
              <span>
                peak <span className="text-fg">{peakFindings}</span>
              </span>
              <span className="text-fg-subtle">·</span>
              <span>
                <span className="text-fg">{chronological.length}</span> reviews
              </span>
            </div>
          </CardHeader>
          <CardBody>
            <InteractiveSparkline
              data={findingsSeries}
              labels={findingsLabels}
              width={600}
              height={72}
              unit="finding"
              className="w-full"
            />
            <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-fg-subtle">
              <span>oldest</span>
              <span>newest</span>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">recent reviews</div>
          <div className="flex items-center gap-3">
            {reviews.length > 0 ? (
              <span className="hidden items-center gap-1.5 font-mono text-[11px] text-fg-muted sm:inline-flex">
                <Kbd>j</Kbd>
                <Kbd>k</Kbd>
                <span>nav</span>
                <Kbd>↵</Kbd>
                <span>open</span>
              </span>
            ) : null}
            <span className="font-mono text-[11px] tabular-nums text-fg-muted">
              {reviews.length} result{reviews.length === 1 ? '' : 's'}
            </span>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {reviews.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={<GitPullRequest size={20} weight="duotone" />}
                title="no reviews yet"
                description="when a pull request opens on this repo, the review lands here."
                action={
                  <EmptyStateActions
                    primary={{ label: 'view all reviews', href: '/app/reviews' }}
                    secondary={{ label: 'view docs', href: '/docs', external: true }}
                  />
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] font-mono text-xs">
                <thead className="bg-bg-subtle/50 text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">pull request</th>
                    <th className="font-medium">status</th>
                    <th className="font-medium">findings</th>
                    <th className="font-medium tabular-nums">duration</th>
                    <th className="font-medium tabular-nums">spend</th>
                    <th className="px-3 text-right font-medium tabular-nums">created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {reviews.map((r) => (
                    <tr key={r.id} className="group/row hover:bg-bg-subtle/40 focus-within:bg-accent/[0.07]">
                      <td className="px-3 py-1.5">
                        <Link
                          href={`/app/reviews/${r.id}` as any}
                          data-review-row
                          className="block rounded-sm outline-none ring-accent/60 focus-visible:ring-1"
                        >
                          <div className="text-fg">
                            <span className="text-fg-subtle">#</span>{r.prNumber}
                          </div>
                          <div className="text-[10px] text-fg-subtle">{r.headSha.slice(0, 8)}</div>
                        </Link>
                      </td>
                      <td><StatusPill status={r.status} /></td>
                      <td className="text-fg-muted">
                        <span className="tabular-nums text-fg">{r.openFindings}</span>
                        <span className="tabular-nums text-fg-subtle"> / {r.totalFindings}</span>
                      </td>
                      <td className="tabular-nums text-fg-muted">{formatMs(r.durationMs)}</td>
                      <td className="tabular-nums text-fg-muted">{formatUsd(r.totalCostUsd)}</td>
                      <td className="px-3 text-right tabular-nums text-fg-muted">
                        <LiveRelativeTime iso={r.createdAt} />
                      </td>
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
