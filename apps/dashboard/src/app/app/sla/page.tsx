import { Timer } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState, Stat } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { PolicyForm } from '@/components/sla/policy-form';
import {
  SlaBreachesTable,
  parseSlaSort,
  parseSlaDir,
  parseSlaSeverity,
} from '@/components/sla/sla-breaches-table';
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
  // Policy-override params, echoed back into every in-page filter/sort link so
  // the custom remediation window survives a column sort or severity tab click.
  const policyParams: Record<string, string> = {};
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
      policyParams[k] = String(v);
    }
  }

  const severity = parseSlaSeverity(typeof sp.sev === 'string' ? sp.sev : undefined);
  const sortKey = parseSlaSort(typeof sp.sort === 'string' ? sp.sort : undefined);
  const sortDir = parseSlaDir(typeof sp.dir === 'string' ? sp.dir : undefined, 'desc');

  const report = await getSlaBreaches(qs.toString());

  if (!report) {
    return (
      <div className="space-y-6">
        <PageHeader title="sla breaches" description="open findings past their remediation window." />
        <EmptyState title="sla report unavailable" description="server did not return an sla snapshot. check the api and retry." />
      </div>
    );
  }

  const effective: SlaPolicy = report.policy ?? { ...report.defaultPolicy, ...overrides };
  const customized = Object.keys(overrides).length > 0;
  const breaches = report.breaches;

  return (
    <div className="space-y-3">
      <PageHeader
        title="sla breaches"
        description="open findings whose age exceeds the severity remediation window."
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
          <div className="flex items-center gap-2 text-sm font-medium">
            <Timer size={16} weight="duotone" className="text-fg-muted" />
            Breached findings
          </div>
        </CardHeader>
        <CardBody>
          <SlaBreachesTable
            breaches={breaches}
            totalBreaches={report.totalBreaches}
            severity={severity}
            sortKey={sortKey}
            sortDir={sortDir}
            policyParams={policyParams}
            customized={customized}
            formatHours={formatHours}
          />
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
