import Link from 'next/link';
import { GitPullRequest } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { StatusPill } from '@/components/review/status-pill';
import { listReviews, type ReviewStatus } from '@/lib/data';
import { formatMs, formatRelative, formatUsd } from '@/lib/format';

const STATUS_TABS: Array<{ key: ReviewStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'queued', label: 'Queued' },
];

interface PageProps {
  searchParams: Promise<{ status?: string; owner?: string; repo?: string }>;
}

export default async function ReviewsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = (STATUS_TABS.find((t) => t.key === sp.status)?.key ?? 'all') as ReviewStatus | 'all';
  const { items } = await listReviews({
    limit: 50,
    status: status === 'all' ? undefined : status,
    owner: sp.owner,
    repo: sp.repo,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reviews"
        description="Every review across every installation you can see."
      />

      <div className="flex flex-wrap items-center gap-1 border-b border-border-subtle">
        {STATUS_TABS.map((t) => {
          const active = t.key === status;
          const href = t.key === 'all' ? '/app/reviews' : `/app/reviews?status=${t.key}`;
          return (
            <Link
              key={t.key}
              href={href as any}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                active
                  ? 'border-fg text-fg'
                  : 'border-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">{items.length} result{items.length === 1 ? '' : 's'}</div>
            <div className="text-xs text-fg-muted">Newest first</div>
          </div>
        </CardHeader>
        <CardBody>
          {items.length === 0 ? (
            <EmptyState
              icon={<GitPullRequest size={28} weight="duotone" />}
              title="No reviews match"
              description="Try a different status filter, or open a pull request on an installed repo to kick off a review."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="py-2 font-medium">Pull request</th>
                    <th className="font-medium">Status</th>
                    <th className="font-medium">Findings</th>
                    <th className="font-medium">Duration</th>
                    <th className="font-medium">Spend</th>
                    <th className="text-right font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {items.map((r) => (
                    <tr key={r.id} className="hover:bg-bg-subtle/40">
                      <td className="py-3">
                        <Link href={`/app/reviews/${r.id}` as any} className="block">
                          <div className="font-medium text-fg">
                            {r.owner}/{r.repo} <span className="text-fg-muted">#{r.prNumber}</span>
                          </div>
                          <div className="font-mono text-[11px] text-fg-subtle">{r.headSha.slice(0, 8)}</div>
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
