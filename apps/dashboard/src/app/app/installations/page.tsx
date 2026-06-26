import Link from 'next/link';
import { ArrowRight, Buildings, User, ShieldIcon } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { ListKeyboardNav } from '@/components/list-keyboard-nav';
import { Kbd } from '@/components/ui/kbd';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import { getInstallations } from '@/lib/data';
import { formatUsd } from '@/lib/format';

export default async function InstallationsPage() {
  const items = await getInstallations();

  return (
    <div className="space-y-3">
      <ListKeyboardNav selector="[data-install-row]" enabled={items.length > 0} />
      <PageHeader
        title="installations"
        description="every github account that installed the clawreview app."
        action={
          items.length > 0 ? (
            <div className="hidden items-center gap-1.5 font-mono text-[11px] text-fg-muted sm:flex">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd>
              <span>nav</span>
              <Kbd>↵</Kbd>
              <span>open</span>
            </div>
          ) : undefined
        }
      />

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">accounts</div>
          <div className="font-mono text-[11px] tabular-nums text-fg-muted">
            {items.length} account{items.length === 1 ? '' : 's'}
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {items.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={<ShieldIcon size={20} />}
                title="no installations yet"
                description="install the clawreview github app on an org or user to start reviewing pull requests."
                action={
                  <EmptyStateActions
                    primary={{ label: 'install on github', href: '/login' }}
                    secondary={{ label: 'view docs', href: '/docs', external: true }}
                  />
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] font-mono text-xs">
                <thead className="bg-bg-subtle/50 text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">account</th>
                    <th className="font-medium">type</th>
                    <th className="font-medium tabular-nums">repos</th>
                    <th className="font-medium">spent this month</th>
                    <th className="px-3 text-right font-medium tabular-nums">budget</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {items.map((i) => {
                    const pct = i.monthlyBudgetUsd > 0 ? Math.min(1, i.spentUsd / i.monthlyBudgetUsd) : 0;
                    const barTone =
                      pct >= 1 ? 'bg-severity-critical' : pct > 0.8 ? 'bg-severity-medium' : 'bg-emerald-500';
                    return (
                      <tr key={i.id} className="group/row hover:bg-bg-subtle/40 focus-within:bg-accent/[0.07]">
                        <td className="px-3 py-1.5">
                          <Link
                            href={`/app/installations/${i.id}/settings` as any}
                            data-install-row
                            className="flex items-center gap-1.5 rounded-sm text-fg outline-none ring-accent/60 focus-visible:ring-1"
                          >
                            <span className="truncate">{i.login}</span>
                            <ArrowRight
                              size={11}
                              weight="bold"
                              className="shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover/row:opacity-70"
                            />
                          </Link>
                        </td>
                        <td className="text-fg-muted">
                          <span className="inline-flex items-center gap-1 lowercase">
                            {i.type === 'Organization' ? (
                              <Buildings size={11} weight="duotone" className="text-fg-subtle" />
                            ) : (
                              <User size={11} weight="duotone" className="text-fg-subtle" />
                            )}
                            {i.type === 'Organization' ? 'org' : 'user'}
                          </span>
                        </td>
                        <td className="tabular-nums text-fg-muted">{i.repoCount}</td>
                        <td className="text-fg-muted">
                          <div className="tabular-nums text-fg">{formatUsd(i.spentUsd)}</div>
                          <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-bg-muted">
                            <div className={barTone} style={{ width: `${pct * 100}%`, height: '100%' }} />
                          </div>
                        </td>
                        <td className="px-3 text-right">
                          <Link
                            href={`/app/installations/${i.id}/billing` as any}
                            className="tabular-nums text-fg-muted hover:text-fg"
                          >
                            {formatUsd(i.monthlyBudgetUsd)}
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
    </div>
  );
}
