import Link from 'next/link';
import { Timer, ArrowRight } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState, SeverityBadge, Stat } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { PolicyForm } from '@/components/sla/policy-form';
import { getSlaBreaches, type SlaPolicy } from '@/lib/data';

const POLICY_KEYS = ['critical_hours', 'high_hours', 'medium_hours', 'low_hours', 'nit_hours'] as const;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parsePositive(raw: string | string[] | undefined): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function formatHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(h < 24 * 14 ? 1 : 0)}d`;
}

export default async function SlaPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const overrides: Partial<SlaPolicy> = {};
  const qs = new URLSearchParams();
  qs.set('limit', '200');
  const keyToField: Record<(typeof POLICY_KEYS)[number], keyof SlaPolicy> = {
    critical_hours: 'critical',
    high_hours: 'high',
    medium_hours: 'medium',
    low_hours: 'low',
    nit_hours: 'nit',
  };
  for (const k of POLICY_KEYS) {
    const v = parsePositive(sp[k]);
    if (v !== undefined) {
      overrides[keyToField[k]] = v;
      qs.set(k, String(v));
    }
  }

  const report = await getSlaBreaches(qs.toString());

  if (!report) {
    return (
      <div className="space-y-6">
        <PageHeader title="SLA breaches" description="Open findings past their remediation window." />
        <EmptyState title="SLA report unavailable" description="The server did not return an SLA snapshot. Check that the API is reachable and try again." />
      </div>
    );
  }

  const effective: SlaPolicy = report.policy ?? { ...report.defaultPolicy, ...overrides };
  const customized = Object.keys(overrides).length > 0;
  const breaches = report.breaches;

  return (
    <div className="space-y-8">
      <PageHeader
        title="SLA breaches"
        description="Open findings whose age exceeds their severity remediation window."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Reviews scanned" value={report.reviewsScanned.toLocaleString()} />
        <Stat label="Total breaches" value={report.totalBreaches.toLocaleString()} />
        <Stat
          label="Critical / High"
          value={`${(report.bySeverity.critical ?? 0).toLocaleString()} / ${(report.bySeverity.high ?? 0).toLocaleString()}`}
        />
        <Stat label="Policy" value={customized ? 'Custom' : 'Default'} />
      </div>

      <PolicyForm defaultPolicy={report.defaultPolicy} current={overrides} />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Timer size={16} weight="duotone" className="text-fg-muted" />
              Breached findings
            </div>
            <div className="text-xs tabular-nums text-fg-muted">
              showing {breaches.length} of {report.totalBreaches}
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {breaches.length === 0 ? (
            <EmptyState
              title="No SLA breaches"
              description={
                customized
                  ? 'No open findings exceed the custom policy you applied.'
                  : 'Every open finding is within its remediation window. Nice.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-[10px] uppercase tracking-wide text-fg-muted">
                    <th className="py-2 pr-3 font-medium">Severity</th>
                    <th className="py-2 pr-3 font-medium">Finding</th>
                    <th className="py-2 pr-3 font-medium">Repo / PR</th>
                    <th className="py-2 pr-3 font-medium">Location</th>
                    <th className="py-2 pr-3 text-right font-medium">Age</th>
                    <th className="py-2 pr-3 text-right font-medium">SLA</th>
                    <th className="py-2 pr-3 text-right font-medium">Overdue</th>
                    <th className="py-2 pl-3 font-medium" aria-label="open" />
                  </tr>
                </thead>
                <tbody>
                  {breaches.map((b) => {
                    const overdue = b.overdueHours ?? Math.max(0, b.ageHours - b.slaHours);
                    return (
                      <tr key={`${b.reviewId}:${b.findingId}`} className="border-b border-border-subtle/60 last:border-0">
                        <td className="py-2 pr-3 align-top">
                          <SeverityBadge severity={b.severity} />
                        </td>
                        <td className="py-2 pr-3 align-top">
                          <Link
                            href={`/app/reviews/${encodeURIComponent(b.reviewId)}/findings#${encodeURIComponent(b.findingId)}` as any}
                            className="font-medium hover:underline"
                          >
                            {b.title}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 align-top text-fg-muted">
                          <span className="tabular-nums">{b.owner}/{b.repo}</span>
                          <span className="px-1 text-fg-muted/60">#</span>
                          <span className="tabular-nums">{b.prNumber}</span>
                        </td>
                        <td className="py-2 pr-3 align-top text-xs text-fg-muted">
                          {b.file ? (
                            <span className="tabular-nums">{b.file}{typeof b.startLine === 'number' ? `:${b.startLine}` : ''}</span>
                          ) : (
                            <span>unknown</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right align-top tabular-nums">{formatHours(b.ageHours)}</td>
                        <td className="py-2 pr-3 text-right align-top tabular-nums text-fg-muted">{formatHours(b.slaHours)}</td>
                        <td className="py-2 pr-3 text-right align-top tabular-nums font-medium text-rose-500">
                          {formatHours(overdue)}
                        </td>
                        <td className="py-2 pl-3 align-top">
                          <Link
                            href={`/app/reviews/${encodeURIComponent(b.reviewId)}` as any}
                            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 text-xs text-fg-muted hover:bg-bg-muted"
                          >
                            Open
                            <ArrowRight size={12} weight="bold" />
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
          <div className="text-sm font-medium">Effective policy</div>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            {(['critical', 'high', 'medium', 'low', 'nit'] as const).map((k) => (
              <div key={k} className="rounded-md border border-border-subtle bg-bg-subtle/30 px-3 py-2">
                <dt className="text-[10px] uppercase tracking-wide text-fg-muted">{k}</dt>
                <dd className="mt-0.5 tabular-nums">{formatHours(effective[k])}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
