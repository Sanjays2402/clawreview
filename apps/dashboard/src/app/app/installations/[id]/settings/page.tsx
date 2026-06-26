import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GitBranch, Stack } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { ListKeyboardNav } from '@/components/list-keyboard-nav';
import { Kbd } from '@/components/ui/kbd';
import { LiveRelativeTime } from '@/components/ui/live-relative-time';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import {
  getBudgetSnapshot,
  getInstallationRepos,
  getInstallations,
} from '@/lib/data';
import { formatUsd } from '@/lib/format';

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
  const budgetTone = budget?.overLimit
    ? 'bg-severity-critical'
    : utilization >= 80
      ? 'bg-severity-medium'
      : 'bg-emerald-500';

  return (
    <div className="space-y-3">
      <ListKeyboardNav selector="[data-repo-row]" enabled={repos.length > 0} />

      <Breadcrumbs
        items={[
          { label: 'installations', href: '/app/installations' },
          { label: installation?.login ?? id },
          { label: 'settings' },
        ]}
      />

      <PageHeader
        title={installation ? `${installation.login} settings` : 'installation settings'}
        description="managed repositories, budget, and per-installation defaults."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardBody>
            <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">account</div>
            <div className="mt-2 font-mono text-sm font-medium text-fg">{installation?.login ?? id}</div>
            <div className="mt-1 font-mono text-[11px] lowercase text-fg-muted">
              {installation?.type ?? 'unknown'}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">managed repos</div>
            <div className="mt-2 font-mono text-2xl font-semibold tabular-nums tracking-tight text-fg">
              {repos.length || installation?.repoCount || 0}
            </div>
            <div className="mt-1 font-mono text-[11px] text-fg-muted">from the github app installation.</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">budget this period</div>
            {budget ? (
              <>
                <div className="mt-2 font-mono text-sm font-medium tabular-nums text-fg">
                  {formatUsd(budget.spentUsd)}
                  <span className="text-fg-muted"> / {formatUsd(budget.limitUsd)}</span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-sm bg-bg-muted">
                  <div className={`h-full ${budgetTone}`} style={{ width: `${utilization}%` }} />
                </div>
                <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-fg-muted">
                  <span className="tabular-nums">{utilization}% used</span>
                  <Link
                    href={`/app/installations/${id}/billing` as any}
                    className="text-fg-subtle hover:text-fg"
                  >
                    manage budget
                  </Link>
                </div>
              </>
            ) : (
              <>
                <div className="mt-2 font-mono text-sm font-medium lowercase text-fg-muted">not set</div>
                <div className="mt-2 font-mono text-[11px] text-fg-muted">
                  <Link
                    href={`/app/installations/${id}/billing` as any}
                    className="text-fg-subtle hover:text-fg"
                  >
                    configure a monthly limit
                  </Link>
                </div>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
            <Stack size={13} weight="duotone" />
            repositories
          </div>
          <div className="flex items-center gap-3">
            {repos.length > 0 ? (
              <span className="hidden items-center gap-1.5 font-mono text-[11px] text-fg-muted sm:inline-flex">
                <Kbd>j</Kbd>
                <Kbd>k</Kbd>
                <span>nav</span>
                <Kbd>↵</Kbd>
                <span>open</span>
              </span>
            ) : null}
            <span className="font-mono text-[11px] tabular-nums text-fg-muted">
              {repos.length} repo{repos.length === 1 ? '' : 's'}
            </span>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {repos.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={<GitBranch size={20} weight="duotone" />}
                title="no repositories yet"
                description="add repos to this installation from the github app settings page to make them reviewable."
                action={
                  <EmptyStateActions
                    primary={{ label: 'open github app', href: '/login' }}
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
                    <th className="px-3 py-1.5 font-medium">repository</th>
                    <th className="font-medium">default branch</th>
                    <th className="font-medium">visibility</th>
                    <th className="px-3 text-right font-medium tabular-nums">last review</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {repos.map((r) => (
                    <tr
                      key={`${r.owner}/${r.repo}`}
                      className="group/row hover:bg-bg-subtle/40 focus-within:bg-accent/[0.07]"
                    >
                      <td className="px-3 py-1.5">
                        <Link
                          href={`/app/repos/${r.owner}__${r.repo}` as any}
                          data-repo-row
                          className="block rounded-sm outline-none ring-accent/60 focus-visible:ring-1"
                        >
                          <span className="text-fg">
                            {r.owner}<span className="text-fg-subtle">/</span>{r.repo}
                          </span>
                          {r.enabled === false ? (
                            <span className="ml-1.5 text-[10px] lowercase text-fg-subtle">(disabled)</span>
                          ) : null}
                        </Link>
                      </td>
                      <td className="text-fg-muted">{r.defaultBranch ?? 'main'}</td>
                      <td className="lowercase text-fg-muted">{r.visibility ?? 'private'}</td>
                      <td className="px-3 text-right tabular-nums text-fg-muted">
                        {r.lastReviewAt ? (
                          <LiveRelativeTime iso={r.lastReviewAt} />
                        ) : (
                          <span className="text-fg-subtle">never</span>
                        )}
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
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">defaults</div>
        </CardHeader>
        <CardBody>
          <p className="text-xs leading-relaxed text-fg-muted">
            per-installation defaults live in{' '}
            <code className="rounded-sm bg-bg-subtle px-1 py-0.5 font-mono text-[11px]">.clawreview.yml</code>{' '}
            in each repo. to override agents, severity gates, or path filters across this whole installation, set them
            under{' '}
            <code className="rounded-sm bg-bg-subtle px-1 py-0.5 font-mono text-[11px]">installation.defaults</code>{' '}
            in the org config.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
