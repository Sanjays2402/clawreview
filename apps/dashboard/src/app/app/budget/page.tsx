import Link from 'next/link';
import { ShieldCheck, Warning, PauseCircle, PlayCircle } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState, Stat } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { BudgetLookupForm } from '@/components/budget/budget-lookup-form';
import { getInstallations, getRepoHealthList, getWeeklyStats } from '@/lib/data';
import { formatRelative, formatUsd } from '@/lib/format';

export default async function BudgetPage() {
  const [installs, health, weekly] = await Promise.all([
    getInstallations(),
    getRepoHealthList(),
    getWeeklyStats(30),
  ]);

  const healthy = health.filter((h) => h.status === 'healthy').length;
  const degraded = health.filter((h) => h.status === 'degraded').length;
  const paused = health.filter((h) => h.status === 'paused').length;

  return (
    <div className="space-y-3">
      <PageHeader
        title="budget + health"
        description="per-installation spend over last 30d. live health for every monitored repo."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="30d spend" value={formatUsd(weekly.totalCostUsd)} />
        <Stat label="Healthy repos" value={healthy} />
        <Stat label="Degraded" value={degraded} />
        <Stat label="Paused" value={paused} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="text-sm font-medium">Installations</div>
          </CardHeader>
          <CardBody>
            {installs.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck size={28} weight="duotone" />}
                title="No installations on this account"
                description="Install the ClawReview GitHub App on an org or user to start tracking spend here."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                    <tr>
                      <th className="py-2 font-medium">Account</th>
                      <th className="font-medium">Repos</th>
                      <th className="font-medium">Spent</th>
                      <th className="font-medium">Limit</th>
                      <th className="text-right font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {installs.map((i) => {
                      const pct = i.monthlyBudgetUsd > 0 ? Math.min(1, i.spentUsd / i.monthlyBudgetUsd) : 0;
                      return (
                        <tr key={i.id}>
                          <td className="py-3 font-medium text-fg">{i.login}</td>
                          <td className="text-fg-muted">{i.repoCount}</td>
                          <td className="text-fg-muted">
                            <div>{formatUsd(i.spentUsd)}</div>
                            <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-bg-subtle">
                              <div
                                className={pct >= 1 ? 'bg-rose-500' : pct > 0.8 ? 'bg-amber-500' : 'bg-emerald-500'}
                                style={{ width: `${pct * 100}%`, height: '100%' }}
                              />
                            </div>
                          </td>
                          <td className="text-fg-muted">{formatUsd(i.monthlyBudgetUsd)}</td>
                          <td className="text-right">
                            <Link
                              href={`/app/installations/${i.id}/billing` as any}
                              className="text-xs text-fg-muted hover:text-fg"
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-medium">Look up by installation id</div>
          </CardHeader>
          <CardBody>
            <BudgetLookupForm />
            <p className="mt-3 text-xs text-fg-subtle">
              Paste the numeric GitHub App installation id to view the live budget snapshot for that tenant.
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Repo health</div>
            <div className="text-xs text-fg-muted">{health.length} tracked</div>
          </div>
        </CardHeader>
        <CardBody>
          {health.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck size={28} weight="duotone" />}
              title="No repos tracked yet"
              description="Repo health updates as reviews land. Open a PR on an installed repo to populate this list."
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {health.map((h) => (
                <li key={`${h.owner}/${h.repo}`} className="grid grid-cols-12 items-center gap-3 py-3">
                  <div className="col-span-12 sm:col-span-5">
                    <div className="font-medium text-fg">{h.owner}/{h.repo}</div>
                    {h.pauseReason ? (
                      <div className="text-xs text-fg-muted">Paused: {h.pauseReason}</div>
                    ) : null}
                  </div>
                  <div className="col-span-4 sm:col-span-2">
                    <HealthPill status={h.status} />
                  </div>
                  <div className="col-span-4 text-xs text-fg-muted sm:col-span-2">
                    {h.failures} failure{h.failures === 1 ? '' : 's'}
                  </div>
                  <div className="col-span-4 text-right text-xs text-fg-muted sm:col-span-3">
                    {h.lastReviewAt ? `last ${formatRelative(h.lastReviewAt)}` : 'never reviewed'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function HealthPill({ status }: { status: 'healthy' | 'degraded' | 'paused' }) {
  const map = {
    healthy: { tone: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', icon: <ShieldCheck size={12} weight="duotone" /> },
    degraded: { tone: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300', icon: <Warning size={12} weight="duotone" /> },
    paused: { tone: 'border-zinc-400/30 bg-zinc-400/10 text-fg-muted', icon: <PauseCircle size={12} weight="duotone" /> },
  } as const;
  const m = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${m.tone}`}>
      {m.icon}
      {status}
    </span>
  );
}

// Suppress unused-import warning when paused/play icons are referenced via map only.
void PlayCircle;
