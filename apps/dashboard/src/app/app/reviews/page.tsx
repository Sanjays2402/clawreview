import Link from 'next/link';
import { GitPullRequest } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { StatusPill } from '@/components/review/status-pill';
import { listReviews, type ReviewStatus } from '@/lib/data';
import { formatMs, formatRelative, formatUsd } from '@/lib/format';

const STATUS_TABS: Array<{ key: ReviewStatus | 'all'; label: string }> = [
  { key: 'all', label: 'all' },
  { key: 'running', label: 'running' },
  { key: 'completed', label: 'completed' },
  { key: 'failed', label: 'failed' },
  { key: 'queued', label: 'queued' },
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
    <div className="space-y-3">
      <PageHeader title="reviews" description="every review across installations you can see." />

      <div className="flex flex-wrap items-center gap-px border-b border-border-subtle font-mono text-[11px]">
        {STATUS_TABS.map((t) => {
          const active = t.key === status;
          const href = t.key === 'all' ? '/app/reviews' : `/app/reviews?status=${t.key}`;
          return (
            <Link
              key={t.key}
              href={href as any}
              className={`-mb-px border-b-2 px-2.5 py-1 lowercase transition-colors ${
                active ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
            {items.length} result{items.length === 1 ? '' : 's'}
          </div>
          <div className="font-mono text-[11px] text-fg-muted">newest first</div>
        </CardHeader>
        <CardBody className="p-0">
          {items.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={<GitPullRequest size={20} weight="duotone" />}
                title="no matches"
                description="try a different status, or open a pr on an installed repo."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] font-mono text-xs">
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
                  {items.map((r) => (
                    <tr key={r.id} className="hover:bg-bg-subtle/40">
                      <td className="px-3 py-1.5">
                        <Link href={`/app/reviews/${r.id}` as any} className="block">
                          <div className="text-fg">
                            {r.owner}/{r.repo} <span className="text-fg-subtle">#</span>{r.prNumber}
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
                      <td className="px-3 text-right tabular-nums text-fg-muted">{formatRelative(r.createdAt)}</td>
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
