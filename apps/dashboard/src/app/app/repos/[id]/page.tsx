import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, GitPullRequest } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { StatusPill } from '@/components/review/status-pill';
import { ListKeyboardNav } from '@/components/list-keyboard-nav';
import { Kbd } from '@/components/ui/kbd';
import { LiveRelativeTime } from '@/components/ui/live-relative-time';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import { getRepoHealth, listReviews, type RepoHealth } from '@/lib/data';
import { formatMs, formatUsd } from '@/lib/format';

import { pauseRepoAction, resumeRepoAction } from './actions';
import { RepoPauseControls } from './repo-pause-controls';
import { RepoTrendCard } from './repo-trend-card';

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

  // Per-review trends. `listReviews` returns newest-first; reverse to
  // chronological (oldest -> newest) so the sparkline reads left-to-right like
  // every other chart in the dashboard. Each point is one review, labelled by
  // PR number so the hover readout is legible. The card toggles between the
  // findings series and the spend series over the same x-axis. Only worth
  // drawing when there are at least two reviews to connect.
  const chronological = reviews.slice().reverse();
  const findingsSeries = chronological.map((r) => r.totalFindings);
  const spendSeries = chronological.map((r) => r.totalCostUsd);
  const findingsLabels = chronological.map((r) => `#${r.prNumber}`);
  const showTrend = chronological.length >= 2;

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
          <RepoPauseControls
            owner={slug.owner}
            repo={slug.repo}
            isPaused={isPaused}
            pauseAction={pauseRepoAction}
            resumeAction={resumeRepoAction}
          />
        </CardBody>
      </Card>

      {showTrend ? (
        <RepoTrendCard
          findings={findingsSeries}
          spend={spendSeries}
          labels={findingsLabels}
        />
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
