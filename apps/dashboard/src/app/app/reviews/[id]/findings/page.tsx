import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FunnelSimple, Warning } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState, SeverityBadge } from '@clawreview/ui';

import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { PageHeader } from '@/components/layout/page-header';
import { getReview, type Severity, type BulkFindingFilter } from '@/lib/data';

import { BulkFindingsBar } from './bulk-findings-bar';

const SEVERITIES: Array<Severity | 'all'> = ['all', 'critical', 'high', 'medium', 'low', 'nit'];
const STATES: Array<'all' | 'open' | 'dismissed'> = ['all', 'open', 'dismissed'];

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ severity?: string; state?: string; agent?: string }>;
}

export default async function FindingsPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const review = await getReview(id);
  if (!review) notFound();

  const sevFilter = (SEVERITIES.includes((sp.severity ?? 'all') as Severity | 'all')
    ? sp.severity
    : 'all') as Severity | 'all';
  const stateFilter = (STATES.includes((sp.state ?? 'all') as 'all' | 'open' | 'dismissed')
    ? sp.state
    : 'all') as 'all' | 'open' | 'dismissed';
  const agentFilter = sp.agent?.trim() || '';

  const agents = Array.from(new Set(review.findings.map((f) => f.agent))).sort();

  const filtered = review.findings.filter((f) => {
    if (sevFilter !== 'all' && f.severity !== sevFilter) return false;
    if (stateFilter !== 'all' && f.state !== stateFilter) return false;
    if (agentFilter && f.agent !== agentFilter) return false;
    return true;
  });

  function hrefWith(next: Partial<{ severity: string; state: string; agent: string }>): string {
    const qs = new URLSearchParams();
    const sev = next.severity ?? sevFilter;
    const st = next.state ?? stateFilter;
    const ag = next.agent ?? agentFilter;
    if (sev && sev !== 'all') qs.set('severity', sev);
    if (st && st !== 'all') qs.set('state', st);
    if (ag) qs.set('agent', ag);
    const tail = qs.toString();
    return `/app/reviews/${id}/findings${tail ? `?${tail}` : ''}`;
  }

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          { label: 'Reviews', href: '/app/reviews' },
          { label: `${review.owner}/${review.repo} #${review.prNumber}`, href: `/app/reviews/${id}` },
          { label: 'Findings' },
        ]}
      />

      <PageHeader
        title="Findings"
        description={`${review.totalFindings} total, ${review.openFindings} open in this review.`}
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FunnelSimple size={16} weight="duotone" />
              Filters
            </div>
            <form action={`/app/reviews/${id}/findings`} method="get" className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="state" value={stateFilter === 'all' ? '' : stateFilter} />
              <input type="hidden" name="severity" value={sevFilter === 'all' ? '' : sevFilter} />
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                Agent
                <select
                  name="agent"
                  defaultValue={agentFilter}
                  className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg"
                >
                  <option value="">All agents</option>
                  {agents.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="rounded-md border border-border bg-bg-subtle px-3 py-1 text-xs font-medium hover:bg-bg"
              >
                Apply
              </button>
              {(sevFilter !== 'all' || stateFilter !== 'all' || agentFilter) && (
                <Link
                  href={`/app/reviews/${id}/findings` as any}
                  className="text-xs text-fg-muted hover:text-fg hover:underline"
                >
                  Reset
                </Link>
              )}
            </form>
          </div>
        </CardHeader>
        <CardBody>
          <div className="mb-4 flex flex-wrap gap-1 border-b border-border-subtle pb-2">
            {SEVERITIES.map((s) => {
              const active = s === sevFilter;
              return (
                <Link
                  key={s}
                  href={hrefWith({ severity: s }) as any}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-xs capitalize transition-colors ${
                    active ? 'border-fg text-fg' : 'border-transparent text-fg-muted hover:text-fg'
                  }`}
                >
                  {s}
                </Link>
              );
            })}
          </div>

          <div className="mb-4 flex flex-wrap gap-1">
            {STATES.map((s) => {
              const active = s === stateFilter;
              return (
                <Link
                  key={s}
                  href={hrefWith({ state: s }) as any}
                  className={`rounded-full px-3 py-1 text-xs capitalize ${
                    active ? 'bg-fg text-bg' : 'bg-bg-subtle text-fg-muted hover:text-fg'
                  }`}
                >
                  {s}
                </Link>
              );
            })}
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Warning size={28} weight="duotone" />}
              title="No findings match"
              description="Loosen the filter or jump back to the full review to see everything."
            />
          ) : (
            <>
              <BulkFindingsBar
                reviewId={id}
                matchCount={filtered.length}
                stateFilter={stateFilter}
                filter={(() => {
                  const f: BulkFindingFilter = {};
                  if (sevFilter !== 'all') f.severities = [sevFilter as Severity];
                  if (agentFilter) f.agents = [agentFilter];
                  return f;
                })()}
              />
              <ul className="divide-y divide-border-subtle">
              {filtered.map((f) => (
                <li key={f.id} className={`py-3 ${f.state === 'dismissed' ? 'opacity-60' : ''}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={f.severity} />
                        <span className="text-xs text-fg-muted">{f.agent}</span>
                        {f.category && <span className="text-xs text-fg-subtle">· {f.category}</span>}
                      </div>
                      <Link
                        href={`/app/reviews/${id}#finding-${f.id}` as any}
                        className="mt-1 block truncate text-sm font-medium text-fg hover:underline"
                      >
                        {f.title}
                      </Link>
                      <div className="mt-1 truncate font-mono text-[11px] text-fg-subtle">
                        {f.file}{f.line ? `:${f.line}` : ''}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs text-fg-muted">
                      {f.state === 'dismissed' ? 'Dismissed' : 'Open'}
                    </div>
                  </div>
                </li>
              ))}
              </ul>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
