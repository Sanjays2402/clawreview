import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Warning } from '@phosphor-icons/react/dist/ssr';

import { EmptyState } from '@clawreview/ui';

import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { PageHeader } from '@/components/layout/page-header';
import { FindingRow } from '@/components/review/finding-row';
import { FindingsKeyNav } from '@/components/review/findings-key-nav';
import { FindingsGroupedByFile, groupFindingsByFile } from '@/components/review/findings-group';
import { SeverityRow } from '@/components/review/severity-row';
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

  // Windowed paint kicks in only once the list is long enough that skipping
  // off-screen layout/paint is a real win -- below this the rows render plainly
  // (and the `content-visibility` placeholder height would be pure overhead).
  // Rows stay MOUNTED either way, so j/k nav + deep-link focus are unaffected.
  const WINDOW_THRESHOLD = 60;
  const windowed = filtered.length >= WINDOW_THRESHOLD;

  // Severity mix for the summary bar. Counted over the state/agent scope but
  // IGNORING the active severity filter, so every non-empty severity stays a
  // live deep-link -- the bar is a one-click severity *switcher*, not just a
  // readout of the (already severity-narrowed) list. Each segment links into
  // this same view's `?severity=` filter, composing with the active state /
  // agent / group params via hrefWith.
  const sevScope = review.findings.filter((f) => {
    if (stateFilter !== 'all' && f.state !== stateFilter) return false;
    if (agentFilter && f.agent !== agentFilter) return false;
    return true;
  });
  const sevCounts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    nit: 0,
  };
  for (const f of sevScope) sevCounts[f.severity] = (sevCounts[f.severity] ?? 0) + 1;
  const sevScopeTotal = sevScope.length;

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
          <span className="ml-auto flex items-center gap-1.5 tabular-nums text-fg-subtle">
            {/* Windowed-paint hint: when the list is long enough that off-screen
                rows defer their paint (content-visibility, 60+ findings, tick
                45), surface a tiny badge so the perf mode is legible -- and,
                importantly, reassure that every row is PRESENT (j/k nav + deep
                links reach them all), just paint-deferred while off-screen. Not
                a spinner: the work is the browser skipping layout it doesn't
                need, so the badge is a quiet steady-state marker. */}
            {windowed ? (
              <span
                className="hidden items-center gap-1 rounded-sm border border-border-subtle bg-bg-subtle/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted sm:inline-flex"
                title={`long list: off-screen rows defer paint for smoother scrolling (>= ${WINDOW_THRESHOLD} findings). all ${filtered.length} rows are present and keyboard-reachable.`}
              >
                <span className="h-1 w-1 rounded-full bg-accent/70" aria-hidden />
                windowed
              </span>
            ) : null}
            <span>
              {filtered.length} / {review.findings.length}
              {fileGroups ? <span> · {fileGroups.length} files</span> : null}
            </span>
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
              <div className="mb-2 rounded-sm border border-border-subtle bg-bg-subtle/30 px-2.5 py-2">
                <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                  <span>severity mix</span>
                  <span className="tabular-nums text-fg-muted">
                    {sevFilter === 'all'
                      ? `${sevScopeTotal} in scope`
                      : `filtered to ${sevFilter}`}
                  </span>
                </div>
                {sevScopeTotal === 0 ? (
                  <div className="font-mono text-[11px] text-fg-subtle">no findings in scope.</div>
                ) : (
                  <SeverityRow
                    counts={sevCounts}
                    total={sevScopeTotal}
                    hrefFor={(sev) => hrefWith({ severity: sevFilter === sev ? 'all' : sev })}
                  />
                )}
              </div>
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
                <FindingsGroupedByFile groups={fileGroups} reviewId={id} focusId={focusId || undefined} windowed={windowed} />
              ) : (
                <ul className="divide-y divide-border-subtle/60 rounded-sm border border-border-subtle">
                  {filtered.map((f) => (
                    <FindingRow key={f.id} finding={f} reviewId={id} focus={focusId === f.id} windowed={windowed} />
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
