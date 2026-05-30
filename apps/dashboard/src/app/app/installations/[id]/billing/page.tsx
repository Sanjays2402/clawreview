import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Coin, Gauge } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, Stat } from '@clawreview/ui';

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

  return (
    <div className="space-y-6">
      <div>
        <Link href={'/app/budget' as any} className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
          <ArrowLeft size={14} weight="duotone" />
          Back to budget
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Installation {installationId}</h1>
        <p className="mt-1 text-sm text-fg-muted">Monthly spend, budget cap, and overage state.</p>
      </div>

      {!snap ? (
        <Card>
          <CardBody>
            <div className="text-sm text-fg-muted">No budget snapshot yet for this installation. Either the id is unknown or the budget guard has not seen any spend this period.</div>
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
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Gauge size={16} weight="duotone" />
                  Usage
                </div>
                {snap.overLimit ? (
                  <span className="rounded-md border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300">
                    Over limit
                  </span>
                ) : null}
              </div>
            </CardHeader>
            <CardBody>
              <UsageBar spent={snap.spentUsd} limit={snap.limitUsd} />
              <div className="mt-3 text-xs text-fg-muted">
                {snap.overLimit
                  ? 'New reviews are blocked until the period rolls over or you raise the cap below.'
                  : `${formatUsd(snap.remainingUsd)} left this period.`}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2 text-sm font-medium">
                <Coin size={16} weight="duotone" />
                Adjust monthly cap
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

function UsageBar({ spent, limit }: { spent: number; limit: number }) {
  const pct = limit > 0 ? Math.min(1, spent / limit) : 0;
  const color = pct >= 1 ? 'bg-rose-500' : pct > 0.8 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="space-y-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-bg-subtle">
        <div className={color} style={{ width: `${pct * 100}%`, height: '100%' }} />
      </div>
      <div className="flex justify-between text-[11px] text-fg-subtle">
        <span>{formatUsd(spent)}</span>
        <span>{formatUsd(limit)}</span>
      </div>
    </div>
  );
}
