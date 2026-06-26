import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Coin, Gauge } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, Stat } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { BudgetForm } from '@/components/budget/budget-form';
import { getBudgetSnapshot } from '@/lib/data';
import { formatUsd } from '@/lib/format';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function InstallationBillingPage({ params }: PageProps) {
  const { id } = await params;
  const installationId = Number.parseInt(id, 10);
  if (!Number.isFinite(installationId) || installationId <= 0) notFound();

  const snap = await getBudgetSnapshot(installationId);
  const pct = snap && snap.limitUsd > 0 ? Math.min(1, snap.spentUsd / snap.limitUsd) : 0;

  return (
    <div className="space-y-3">
      <Breadcrumbs
        items={[
          { label: 'installations', href: '/app/installations' },
          { label: `${installationId}`, href: `/app/installations/${installationId}/settings` },
          { label: 'billing' },
        ]}
      />

      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title={`installation ${installationId}`}
          description="monthly spend, budget cap, and overage state."
        />
        <Link
          href={'/app/budget' as any}
          className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-fg-muted hover:text-fg"
        >
          <ArrowLeft size={11} weight="bold" /> budget
        </Link>
      </div>

      {!snap ? (
        <Card>
          <CardBody>
            <div className="font-mono text-[11px] text-fg-muted">
              no budget snapshot yet for this installation. either the id is unknown or the budget
              guard has not seen any spend this period.
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Spent" value={formatUsd(snap.spentUsd)} />
            <Stat label="Limit" value={formatUsd(snap.limitUsd)} />
            <Stat label="Remaining" value={formatUsd(snap.remainingUsd)} />
            <Stat label="Period" value={snap.periodKey} />
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
                <Gauge size={13} weight="duotone" className="text-fg-muted" />
                usage
              </div>
              {snap.overLimit ? (
                <span className="rounded-sm border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium lowercase tracking-wide text-rose-600 dark:text-rose-400">
                  over limit
                </span>
              ) : (
                <span className="font-mono text-[11px] tabular-nums text-fg-muted">
                  {Math.round(pct * 100)}% used
                </span>
              )}
            </CardHeader>
            <CardBody>
              <UsageBar spent={snap.spentUsd} limit={snap.limitUsd} pct={pct} />
              <div className="mt-3 font-mono text-[11px] text-fg-muted">
                {snap.overLimit
                  ? 'new reviews are blocked until the period rolls over or you raise the cap below.'
                  : `${formatUsd(snap.remainingUsd)} left this period.`}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
                <Coin size={13} weight="duotone" className="text-fg-muted" />
                adjust monthly cap
              </div>
            </CardHeader>
            <CardBody>
              <BudgetForm installationId={installationId} currentLimit={snap.limitUsd} />
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

function UsageBar({ spent, limit, pct }: { spent: number; limit: number; pct: number }) {
  const color = pct >= 1 ? 'bg-severity-critical' : pct > 0.8 ? 'bg-severity-medium' : 'bg-emerald-500';
  return (
    <div className="space-y-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-bg-muted">
        <div className={color} style={{ width: `${pct * 100}%`, height: '100%' }} />
      </div>
      <div className="flex justify-between font-mono text-[11px] tabular-nums text-fg-subtle">
        <span>{formatUsd(spent)}</span>
        <span>{formatUsd(limit)}</span>
      </div>
    </div>
  );
}
