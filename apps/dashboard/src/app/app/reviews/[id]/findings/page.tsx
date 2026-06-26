import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Warning } from '@phosphor-icons/react/dist/ssr';

import { EmptyState } from '@clawreview/ui';

import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { PageHeader } from '@/components/layout/page-header';
import { FindingRow } from '@/components/review/finding-row';
import { FindingsKeyNav } from '@/components/review/findings-key-nav';
import { FindingsGroupedByFile, groupFindingsByFile } from '@/components/review/findings-group';
import { Kbd } from '@/components/ui/kbd';
import { getReview, type Severity, type BulkFindingFilter } from '@/lib/data';

import { BulkFindingsBar } from './bulk-findings-bar';

const SEVERITIES: Array<Severity | 'all'> = ['all', 'critical', 'high', 'medium', 'low', 'nit'];
const STATES: Array<'all' | 'open' | 'dismissed'> = ['all', 'open', 'dismissed'];
const GROUPS: Array<'flat' | 'file'> = ['flat', 'file'];

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ severity?: string; state?: string; agent?: string; group?: string; focus?: string }>;
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
  const groupBy = (GROUPS.includes((sp.group ?? 'flat') as 'flat' | 'file')
    ? sp.group
    : 'flat') as 'flat' | 'file';
  const focusId = sp.focus?.trim() || '';

  const agents = Array.from(new Set(review.findings.map((f) => f.agent))).sort();

  const filtered = review.findings.filter((f) => {
    // Always keep the deep-link target visible even if filters would hide it.
    if (focusId && f.id === focusId) return true;
    if (sevFilter !== 'all' && f.severity !== sevFilter) return false;
    if (stateFilter !== 'all' && f.state !== stateFilter) return false;
    if (agentFilter && f.agent !== agentFilter) return false;
    return true;
  });

  function hrefWith(
    next: Partial<{ severity: string; state: string; agent: string; group: string }>,
  ): string {
    const qs = new URLSearchParams();
    const sev = next.severity ?? sevFilter;
    const st = next.state ?? stateFilter;
    const ag = next.agent ?? agentFilter;
    const gr = next.group ?? groupBy;
    if (sev && sev !== 'all') qs.set('severity', sev);
    if (st && st !== 'all') qs.set('state', st);
    if (ag) qs.set('agent', ag);
    if (gr && gr !== 'flat') qs.set('group', gr);
    const tail = qs.toString();
    return `/app/reviews/${id}/findings${tail ? `?${tail}` : ''}`;
  }

  const fileGroups = groupBy === 'file' ? groupFindingsByFile(filtered) : null;

  return (
    <div className="space-y-3">
      <FindingsKeyNav />
      <Breadcrumbs
        items={[
          { label: 'reviews', href: '/app/reviews' },
          { label: `${review.owner}/${review.repo} #${review.prNumber}`, href: `/app/reviews/${id}` },
          { label: 'findings' },
        ]}
      />

      <PageHeader
        title="findings"
        description={`${review.totalFindings} total · ${review.openFindings} open`}
        action={
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-fg-muted">
            <Kbd>j</Kbd><Kbd>k</Kbd><span>nav</span>
            <Kbd>e</Kbd><span>expand</span>
            <Kbd>x</Kbd><span>dismiss</span>
          </div>
        }
      />

      <div className="rounded-md border border-border">
        {/* Filter strip — sticks under the app header on long file-grouped lists */}
        <div className="sticky top-10 z-20 flex flex-wrap items-center gap-1 rounded-t-md border-b border-border-subtle bg-bg/85 px-2 py-1.5 font-mono text-[11px] backdrop-blur supports-[backdrop-filter]:bg-bg/65">
          <span className="uppercase tracking-wider text-fg-subtle">sev</span>
          {SEVERITIES.map((s) => {
            const active = s === sevFilter;
            return (
              <Link
                key={s}
                href={hrefWith({ severity: s }) as any}
                className={`rounded-sm px-1.5 py-0.5 lowercase ${
                  active ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'
                }`}
              >
                {s}
              </Link>
            );
          })}
          <span className="mx-1 text-fg-subtle">·</span>
          <span className="uppercase tracking-wider text-fg-subtle">state</span>
          {STATES.map((s) => {
            const active = s === stateFilter;
            return (
              <Link
                key={s}
                href={hrefWith({ state: s }) as any}
                className={`rounded-sm px-1.5 py-0.5 lowercase ${
                  active ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'
                }`}
              >
                {s}
              </Link>
            );
          })}
          <span className="mx-1 text-fg-subtle">·</span>
          <form action={`/app/reviews/${id}/findings`} method="get" className="flex items-center gap-1">
            <input type="hidden" name="state" value={stateFilter === 'all' ? '' : stateFilter} />
            <input type="hidden" name="severity" value={sevFilter === 'all' ? '' : sevFilter} />
            <input type="hidden" name="group" value={groupBy === 'flat' ? '' : groupBy} />
            <span className="uppercase tracking-wider text-fg-subtle">agent</span>
            <select
              name="agent"
              defaultValue={agentFilter}
              className="h-5 rounded-sm border border-border bg-bg px-1 text-[11px] text-fg"
            >
              <option value="">all</option>
              {agents.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <button type="submit" className="rounded-sm border border-border bg-bg-subtle px-1.5 py-0.5 hover:bg-bg-muted">apply</button>
          </form>
          <span className="mx-1 text-fg-subtle">·</span>
          <span className="uppercase tracking-wider text-fg-subtle">group</span>
          {GROUPS.map((g) => {
            const active = g === groupBy;
            return (
              <Link
                key={g}
                href={hrefWith({ group: g }) as any}
                className={`rounded-sm px-1.5 py-0.5 lowercase ${
                  active ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'
                }`}
              >
                {g === 'flat' ? 'list' : 'file'}
              </Link>
            );
          })}
          {(sevFilter !== 'all' || stateFilter !== 'all' || agentFilter || groupBy !== 'flat') && (
            <Link href={`/app/reviews/${id}/findings` as any} className="ml-1 text-fg-subtle hover:text-fg">reset</Link>
          )}
          <span className="ml-auto tabular-nums text-fg-subtle">
            {filtered.length} / {review.findings.length}
            {fileGroups ? <span> · {fileGroups.length} files</span> : null}
          </span>
        </div>

        <div className="p-2">
          {filtered.length === 0 ? (
            <EmptyState
              icon={<Warning size={20} weight="duotone" />}
              title="no matches"
              description="loosen the filter or open the full review."
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
              {fileGroups ? (
                <FindingsGroupedByFile groups={fileGroups} reviewId={id} focusId={focusId || undefined} />
              ) : (
                <ul className="divide-y divide-border-subtle/60 rounded-sm border border-border-subtle">
                  {filtered.map((f) => (
                    <FindingRow key={f.id} finding={f} reviewId={id} focus={focusId === f.id} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
