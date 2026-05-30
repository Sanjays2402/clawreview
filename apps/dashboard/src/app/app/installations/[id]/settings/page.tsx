import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GitBranch, Stack } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import {
  getBudgetSnapshot,
  getInstallationRepos,
  getInstallations,
} from '@/lib/data';
import { formatRelative, formatUsd } from '@/lib/format';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function InstallationSettingsPage({ params }: PageProps) {
  const { id } = await params;
  const installations = await getInstallations();
  const installation = installations.find((i) => String(i.id) === id);
  if (!installation && installations.length > 0) notFound();

  const numericId = Number(id);
  const [repos, budget] = await Promise.all([
    getInstallationRepos(id),
    Number.isFinite(numericId) ? getBudgetSnapshot(numericId) : Promise.resolve(null),
  ]);

  const utilization = budget && budget.limitUsd > 0
    ? Math.min(100, Math.round((budget.spentUsd / budget.limitUsd) * 100))
    : 0;

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          { label: 'Installations', href: '/app/installations' },
          { label: installation?.login ?? id },
          { label: 'Settings' },
        ]}
      />

      <PageHeader
        title={installation ? `${installation.login} settings` : 'Installation settings'}
        description="Managed repositories, budget, and per-installation defaults."
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader><div className="text-sm font-medium">Account</div></CardHeader>
          <CardBody>
            <div className="text-xl font-semibold">{installation?.login ?? id}</div>
            <div className="mt-1 text-xs text-fg-muted">{installation?.type ?? 'Unknown'}</div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><div className="text-sm font-medium">Managed repos</div></CardHeader>
          <CardBody>
            <div className="text-xl font-semibold">{repos.length || installation?.repoCount || 0}</div>
            <div className="mt-1 text-xs text-fg-muted">From the GitHub App installation.</div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><div className="text-sm font-medium">Budget this period</div></CardHeader>
          <CardBody>
            {budget ? (
              <>
                <div className="text-xl font-semibold">
                  {formatUsd(budget.spentUsd)}
                  <span className="text-sm font-normal text-fg-muted"> / {formatUsd(budget.limitUsd)}</span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle">
                  <div
                    className={`h-full ${budget.overLimit ? 'bg-red-500' : utilization > 80 ? 'bg-amber-500' : 'bg-fg'}`}
                    style={{ width: `${utilization}%` }}
                  />
                </div>
                <div className="mt-2 text-xs text-fg-muted">
                  <Link href={`/app/installations/${id}/billing` as any} className="hover:underline">
                    Manage budget
                  </Link>
                </div>
              </>
            ) : (
              <>
                <div className="text-xl font-semibold text-fg-muted">Not set</div>
                <div className="mt-2 text-xs text-fg-muted">
                  <Link href={`/app/installations/${id}/billing` as any} className="hover:underline">
                    Configure a monthly limit
                  </Link>
                </div>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Stack size={16} weight="duotone" />
              Repositories
            </div>
            <div className="text-xs text-fg-muted">{repos.length} repo{repos.length === 1 ? '' : 's'}</div>
          </div>
        </CardHeader>
        <CardBody>
          {repos.length === 0 ? (
            <EmptyState
              icon={<GitBranch size={28} weight="duotone" />}
              title="No repositories yet"
              description="Add repos to this installation from the GitHub App settings page to make them reviewable."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="py-2 font-medium">Repository</th>
                    <th className="font-medium">Default branch</th>
                    <th className="font-medium">Visibility</th>
                    <th className="text-right font-medium">Last review</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {repos.map((r) => (
                    <tr key={`${r.owner}/${r.repo}`} className="hover:bg-bg-subtle/40">
                      <td className="py-3 font-medium text-fg">
                        <Link
                          href={`/app/repos/${encodeURIComponent(r.owner)}%2F${encodeURIComponent(r.repo)}` as any}
                          className="hover:underline"
                        >
                          {r.owner}/{r.repo}
                        </Link>
                      </td>
                      <td className="font-mono text-xs text-fg-muted">{r.defaultBranch ?? 'main'}</td>
                      <td className="text-fg-muted">{r.visibility ?? 'private'}</td>
                      <td className="text-right text-fg-muted">
                        {r.lastReviewAt ? formatRelative(r.lastReviewAt) : 'Never'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><div className="text-sm font-medium">Defaults</div></CardHeader>
        <CardBody>
          <p className="text-sm text-fg-muted">
            Per-installation defaults live in <code className="rounded bg-bg-subtle px-1 py-0.5 font-mono text-xs">.clawreview.yml</code>{' '}
            in each repo. To override agents, severity gates, or path filters across this whole installation, set them under{' '}
            <code className="rounded bg-bg-subtle px-1 py-0.5 font-mono text-xs">installation.defaults</code> in the org config.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
