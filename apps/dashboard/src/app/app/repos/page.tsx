import Link from 'next/link';
import { GitBranch } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { getRepoHealthList, type RepoHealth } from '@/lib/data';
import { formatRelative } from '@/lib/format';

function statusTone(s: RepoHealth['status']): string {
  if (s === 'healthy') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  if (s === 'degraded') return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
  return 'bg-rose-500/10 text-rose-600 dark:text-rose-400';
}

function repoSlug(r: RepoHealth): string {
  return `${r.owner}__${r.repo}`;
}

export default async function ReposPage() {
  const items = await getRepoHealthList();
  const sorted = [...items].sort((a, b) => {
    const order = { paused: 0, degraded: 1, healthy: 2 } as const;
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`);
  });

  return (
    <div className="space-y-3">
      <PageHeader
        title="repos"
        description="health, recent activity, pause controls for tracked repos."
      />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              {sorted.length} repo{sorted.length === 1 ? '' : 's'}
            </div>
            <div className="text-xs text-fg-muted">Paused and degraded first</div>
          </div>
        </CardHeader>
        <CardBody>
          {sorted.length === 0 ? (
            <EmptyState
              icon={<GitBranch size={28} weight="duotone" />}
              title="No repos yet"
              description="Once a pull request opens on an installed repo, its health will show up here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="py-2 font-medium">Repository</th>
                    <th className="font-medium">Status</th>
                    <th className="font-medium">Failures</th>
                    <th className="font-medium">Last review</th>
                    <th className="text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {sorted.map((r) => (
                    <tr key={`${r.owner}/${r.repo}`} className="hover:bg-bg-subtle/40">
                      <td className="py-3">
                        <Link href={`/app/repos/${repoSlug(r)}` as any} className="block">
                          <div className="font-medium text-fg">
                            {r.owner}/{r.repo}
                          </div>
                          {r.pauseReason ? (
                            <div className="text-[11px] text-fg-subtle">{r.pauseReason}</div>
                          ) : null}
                        </Link>
                      </td>
                      <td>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(r.status)}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="text-fg-muted">{r.failures}</td>
                      <td className="text-fg-muted">
                        {r.lastReviewAt ? formatRelative(r.lastReviewAt) : 'never'}
                      </td>
                      <td className="text-right">
                        <Link
                          href={`/app/repos/${repoSlug(r)}` as any}
                          className="text-xs font-medium text-fg hover:underline"
                        >
                          Manage
                        </Link>
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
