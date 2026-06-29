import Link from 'next/link';
import { ArrowUp, ArrowDown, ArrowRight, Timer, X } from '@phosphor-icons/react/dist/ssr';

import { EmptyState, SeverityBadge } from '@clawreview/ui';

import { ListKeyboardNav } from '@/components/list-keyboard-nav';
import { SeverityRow } from '@/components/review/severity-row';
import { StickyBar } from '@/components/ui/sticky-bar';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import type { Severity, SlaBreach } from '@/lib/data';

export type SlaSortKey = 'severity' | 'age' | 'sla' | 'overdue';
export type SlaSortDir = 'asc' | 'desc';

const SORT_KEYS: SlaSortKey[] = ['severity', 'age', 'sla', 'overdue'];
const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'nit'];
// Lower rank = more severe, so an ascending sort surfaces nits first and a
// descending sort surfaces criticals first (the operator-friendly default).
const SEV_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, nit: 0 };

export const SLA_SEVERITY_TABS: Array<{ key: Severity | 'all'; label: string }> = [
  { key: 'all', label: 'all' },
  { key: 'critical', label: 'critical' },
  { key: 'high', label: 'high' },
  { key: 'medium', label: 'medium' },
  { key: 'low', label: 'low' },
  { key: 'nit', label: 'nit' },
];

export function parseSlaSort(raw: string | undefined): SlaSortKey {
  return SORT_KEYS.includes((raw ?? 'overdue') as SlaSortKey) ? (raw as SlaSortKey) : 'overdue';
}
export function parseSlaDir(raw: string | undefined, fallback: SlaSortDir): SlaSortDir {
  return raw === 'asc' || raw === 'desc' ? raw : fallback;
}
// Severity + every numeric column reads most-useful descending first.
function defaultDirFor(_key: SlaSortKey): SlaSortDir {
  return 'desc';
}

export function parseSlaSeverity(raw: string | undefined): Severity | 'all' {
  return SLA_SEVERITY_TABS.some((t) => t.key === raw) ? (raw as Severity | 'all') : 'all';
}

function overdueOf(b: SlaBreach): number {
  return b.overdueHours ?? Math.max(0, b.ageHours - b.slaHours);
}

export function filterSlaBreaches(breaches: SlaBreach[], severity: Severity | 'all'): SlaBreach[] {
  if (severity === 'all') return breaches;
  return breaches.filter((b) => b.severity === severity);
}

export function sortSlaBreaches(breaches: SlaBreach[], key: SlaSortKey, dir: SlaSortDir): SlaBreach[] {
  const mult = dir === 'asc' ? 1 : -1;
  const copy = breaches.slice();
  copy.sort((a, b) => {
    let av = 0;
    let bv = 0;
    if (key === 'severity') {
      av = SEV_RANK[a.severity];
      bv = SEV_RANK[b.severity];
    } else if (key === 'age') {
      av = a.ageHours;
      bv = b.ageHours;
    } else if (key === 'sla') {
      av = a.slaHours;
      bv = b.slaHours;
    } else {
      av = overdueOf(a);
      bv = overdueOf(b);
    }
    if (av === bv) {
      const id = `${a.reviewId}:${a.findingId}`.localeCompare(`${b.reviewId}:${b.findingId}`);
      return id;
    }
    return (av - bv) * mult;
  });
  return copy;
}

export function countSlaBySeverity(breaches: SlaBreach[]): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, nit: 0 };
  for (const b of breaches) out[b.severity] += 1;
  return out;
}

interface Props {
  breaches: SlaBreach[];
  totalBreaches: number;
  severity: Severity | 'all';
  sortKey: SlaSortKey;
  sortDir: SlaSortDir;
  /** Stable policy-override params to preserve across every filter/sort link. */
  policyParams: Record<string, string>;
  customized: boolean;
  formatHours: (h: number) => string;
}

export function SlaBreachesTable({
  breaches,
  totalBreaches,
  severity,
  sortKey,
  sortDir,
  policyParams,
  customized,
  formatHours,
}: Props) {
  const counts = countSlaBySeverity(breaches);
  const filtered = filterSlaBreaches(breaches, severity);
  const items = sortSlaBreaches(filtered, sortKey, sortDir);

  // Overdue-outlier emphasis: the overdue column is uniformly critical text,
  // so in a long list the single 40-day breach reads the same as a 2-hour
  // one. Add a proportional bar (normalised to the worst breach in the
  // current view) so relative severity is glanceable, and brighten the worst
  // decile of rows so the breaches that most need attention pop regardless of
  // the active sort. Only worth it with enough rows AND real spread -- a
  // handful of similarly-overdue breaches has no meaningful "worst" to flag.
  const overdueVals = items.map(overdueOf);
  const maxOverdue = overdueVals.length > 0 ? Math.max(...overdueVals) : 0;
  const minOverdue = overdueVals.length > 0 ? Math.min(...overdueVals) : 0;
  const worstCount = Math.max(1, Math.ceil(items.length * 0.1));
  const sortedDesc = overdueVals.slice().sort((a, b) => b - a);
  const worstThreshold = sortedDesc[worstCount - 1] ?? Infinity;
  const overdueEmphasisOn = items.length >= 4 && maxOverdue > minOverdue;
  const isWorstOverdue = (v: number) => overdueEmphasisOn && v >= worstThreshold;

  // Age-outlier emphasis: a DISTINCT axis from overdue. A breach can be very
  // overdue but young (a tight SLA blown by hours) or only mildly overdue but
  // ancient (a loose SLA on a finding that has sat for weeks) -- the age column
  // is uniformly muted, so the oldest breaches don't stand out under any sort
  // that isn't `age`. Brighten the worst decile BY AGE with a quiet text bump
  // (text-fg, not the critical tint the overdue column uses) AND draw a quiet
  // proportional age bar (normalised to the oldest in view, neutral fg-subtle
  // track, not the overdue critical track) so relative age reads at a glance
  // like overdue already does. Same worst-decile idiom; same guard.
  const ageVals = items.map((b) => b.ageHours);
  const maxAge = ageVals.length > 0 ? Math.max(...ageVals) : 0;
  const minAge = ageVals.length > 0 ? Math.min(...ageVals) : 0;
  const sortedAgeDesc = ageVals.slice().sort((a, b) => b - a);
  const worstAgeThreshold = sortedAgeDesc[worstCount - 1] ?? Infinity;
  const ageEmphasisOn = items.length >= 4 && maxAge > minAge;
  const isOldest = (v: number) => ageEmphasisOn && v >= worstAgeThreshold;

  function hrefWith(next: Partial<{ sev: string; sort: string; dir: string }>): string {
    const qs = new URLSearchParams();
    // Policy overrides are always preserved -- they drive which findings breach.
    for (const [k, v] of Object.entries(policyParams)) qs.set(k, v);
    const sv = next.sev ?? (severity === 'all' ? '' : severity);
    const sr = next.sort ?? sortKey;
    const dr = next.dir ?? sortDir;
    if (sv) qs.set('sev', sv);
    if (sr && sr !== 'overdue') qs.set('sort', sr);
    if (dr && dr !== defaultDirFor(sr as SlaSortKey)) qs.set('dir', dr);
    const tail = qs.toString();
    return `/app/sla${tail ? `?${tail}` : ''}`;
  }

  function sortHref(col: SlaSortKey): string {
    if (sortKey === col) return hrefWith({ sort: col, dir: sortDir === 'asc' ? 'desc' : 'asc' });
    return hrefWith({ sort: col, dir: defaultDirFor(col) });
  }

  const chips: Array<{ label: string; href: string }> = [];
  if (severity !== 'all') chips.push({ label: `sev: ${severity}`, href: hrefWith({ sev: '' }) });
  if (sortKey !== 'overdue' || sortDir !== defaultDirFor('overdue')) {
    chips.push({
      label: `sort: ${sortKey} ${sortDir === 'desc' ? '↓' : '↑'}`,
      href: hrefWith({ sort: 'overdue', dir: 'desc' }),
    });
  }

  return (
    <div className="space-y-3">
      <ListKeyboardNav selector="[data-sla-row]" enabled={items.length > 0} />

      {/* Severity filter tabs with live counts — pinned on long breach lists */}
      <StickyBar top="top-10" className="-mx-3 px-3" backToTop>
        <div className="flex flex-wrap items-center gap-px font-mono text-[11px]">
          {SLA_SEVERITY_TABS.map((t) => {
            const active = t.key === severity;
            const count = t.key === 'all' ? breaches.length : counts[t.key];
            return (
              <Link
                key={t.key}
                href={(t.key === 'all' ? hrefWith({ sev: '' }) : hrefWith({ sev: t.key })) as any}
                className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-2.5 py-1 lowercase transition-colors ${
                  active ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'
                }`}
              >
                <span>{t.label}</span>
                <span
                  className={`rounded-sm px-1 text-[10px] tabular-nums ${
                    active ? 'bg-accent/20 text-fg' : 'bg-bg-muted text-fg-subtle'
                  }`}
                >
                  {count}
                </span>
              </Link>
            );
          })}
        </div>
      </StickyBar>

      {/* Severity-mix bar: proportions across ALL breaches (ignores the active
          sev filter so every segment stays a live switcher, like the findings
          page). Each segment deep-links to its ?sev= tab; clicking the active
          severity toggles back to all. Only worth drawing with 2+ severities
          present -- a single-severity bar is just the tab count restated. */}
      {(() => {
        const present = SEV_ORDER.filter((s) => counts[s] > 0).length;
        if (breaches.length === 0 || present < 2) return null;
        return (
          <div className="rounded-sm border border-border-subtle bg-bg-subtle/30 px-2.5 py-2">
            <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
              <span>severity mix</span>
              <span className="tabular-nums text-fg-muted">
                {severity === 'all' ? `${breaches.length} breaches` : `filtered to ${severity}`}
              </span>
            </div>
            <SeverityRow
              counts={counts}
              total={breaches.length}
              hrefFor={(sev) => hrefWith({ sev: severity === sev ? '' : sev })}
            />
          </div>
        );
      })()}

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
          <span className="uppercase tracking-wider text-fg-subtle">active</span>
          {chips.map((c) => (
            <Link
              key={c.label}
              href={c.href as any}
              className="group inline-flex items-center gap-1 rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 lowercase text-fg transition-colors hover:border-accent/70 hover:bg-accent/20"
            >
              <span>{c.label}</span>
              <X size={9} weight="bold" className="text-fg-muted group-hover:text-fg" />
            </Link>
          ))}
          <Link href={hrefWith({ sev: '', sort: 'overdue', dir: 'desc' }) as any} className="ml-1 lowercase text-fg-subtle hover:text-fg">
            clear all
          </Link>
        </div>
      ) : null}

      {breaches.length === 0 ? (
        <EmptyState
          icon={<Timer size={20} weight="duotone" />}
          title="no sla breaches"
          description={
            customized
              ? 'no open findings exceed the custom policy you applied.'
              : 'every open finding is within its remediation window. nice.'
          }
          action={
            <EmptyStateActions
              primary={{ label: 'view all reviews', href: '/app/reviews' }}
              secondary={{ label: 'sla docs', href: '/docs', external: true }}
            />
          }
        />
      ) : items.length === 0 ? (
        <div className="rounded-sm border border-border bg-bg-subtle/40 px-3 py-6 text-center font-mono text-xs text-fg-muted">
          no {severity} breaches. <Link href={hrefWith({ sev: '' }) as any} className="text-accent hover:underline">show all</Link>
        </div>
      ) : (
        <>
        {/* Worst-row legend: both numeric columns brighten their worst decile,
            but on two DISTINCT axes -- age (text-fg) and overdue (critical). In
            a long list the brightening is easy to read as "random bold rows".
            Key it: oldest = open longest, most overdue = furthest past SLA, and
            a row can be one without the other. Only shown once an axis is
            actually on (the same guard the columns use), sm:+ to spare mobile. */}
        {ageEmphasisOn || overdueEmphasisOn ? (
          <div className="hidden flex-wrap items-center gap-x-3 gap-y-1 px-1 font-mono text-[10px] text-fg-subtle sm:flex">
            <span className="uppercase tracking-wider">brightest</span>
            {ageEmphasisOn ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-fg-subtle" aria-hidden />
                <span className="font-medium text-fg">oldest</span> open longest
              </span>
            ) : null}
            {overdueEmphasisOn ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-severity-critical" aria-hidden />
                <span className="font-medium text-severity-critical">most overdue</span> furthest past sla
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="overflow-x-auto rounded-sm border border-border-subtle">
          <table className="w-full min-w-[760px] font-mono text-xs">
            <thead className="sticky top-0 z-10 border-b border-border-subtle bg-bg-subtle text-left text-[10px] uppercase tracking-wider text-fg-subtle">
              <tr>
                <SortableTh href={sortHref('severity')} active={sortKey === 'severity'} dir={sortDir} className="px-3">
                  severity
                </SortableTh>
                <th className="font-medium">finding</th>
                <th className="font-medium">repo / pr</th>
                <th className="font-medium">location</th>
                <SortableTh href={sortHref('age')} active={sortKey === 'age'} dir={sortDir} numeric align="right">
                  age
                </SortableTh>
                <SortableTh href={sortHref('sla')} active={sortKey === 'sla'} dir={sortDir} numeric align="right">
                  sla
                </SortableTh>
                <SortableTh href={sortHref('overdue')} active={sortKey === 'overdue'} dir={sortDir} numeric align="right">
                  overdue
                </SortableTh>
                <th className="px-3 font-medium" aria-label="open" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {items.map((b) => {
                const overdue = overdueOf(b);
                const worst = isWorstOverdue(overdue);
                // Bar width is this breach's overdue time as a fraction of the
                // worst in view, so the longest breach fills the track and the
                // rest read proportionally. Min 4% keeps a tiny breach visible.
                const overduePct = maxOverdue > 0 ? Math.max((overdue / maxOverdue) * 100, 4) : 0;
                return (
                  <tr key={`${b.reviewId}:${b.findingId}`} className="group/row hover:bg-bg-subtle/40 focus-within:bg-accent/[0.07]">
                    <td className="px-3 py-1.5 align-top">
                      <SeverityBadge severity={b.severity} />
                    </td>
                    <td className="py-1.5 align-top">
                      <Link
                        href={`/app/reviews/${encodeURIComponent(b.reviewId)}/findings#${encodeURIComponent(b.findingId)}` as any}
                        data-sla-row
                        className="block rounded-sm text-fg outline-none ring-accent/60 hover:underline focus-visible:ring-1"
                      >
                        {b.title}
                      </Link>
                    </td>
                    <td className="py-1.5 align-top text-fg-muted">
                      <span className="tabular-nums">{b.owner}/{b.repo}</span>
                      <span className="px-1 text-fg-subtle">#</span>
                      <span className="tabular-nums">{b.prNumber}</span>
                    </td>
                    <td className="py-1.5 align-top text-fg-muted">
                      {b.file ? (
                        <span className="tabular-nums">{b.file}{typeof b.startLine === 'number' ? `:${b.startLine}` : ''}</span>
                      ) : (
                        <span className="text-fg-subtle">unknown</span>
                      )}
                    </td>
                    <td className="py-1.5 align-top">
                      <span className="flex items-center justify-end gap-2">
                        {ageEmphasisOn ? (
                          <span className="relative hidden h-1.5 w-14 shrink-0 overflow-hidden rounded-sm bg-bg-muted sm:block" aria-hidden>
                            <span
                              className={`absolute inset-y-0 left-0 ${isOldest(b.ageHours) ? 'bg-fg-subtle' : 'bg-fg-subtle/40'}`}
                              style={{ width: `${maxAge > 0 ? Math.max((b.ageHours / maxAge) * 100, 4) : 0}%` }}
                            />
                          </span>
                        ) : null}
                        {isOldest(b.ageHours) ? (
                          <span
                            className="w-12 shrink-0 text-right tabular-nums font-medium text-fg"
                            title="among the oldest breaches in view"
                          >
                            {formatHours(b.ageHours)}
                          </span>
                        ) : (
                          <span className="w-12 shrink-0 text-right tabular-nums text-fg-muted">{formatHours(b.ageHours)}</span>
                        )}
                      </span>
                    </td>
                    <td className="py-1.5 text-right align-top tabular-nums text-fg-subtle">{formatHours(b.slaHours)}</td>
                    <td className="py-1.5 align-top">
                      <span className="flex items-center justify-end gap-2">
                        {overdueEmphasisOn ? (
                          <span className="relative hidden h-1.5 w-14 shrink-0 overflow-hidden rounded-sm bg-bg-muted sm:block" aria-hidden>
                            <span
                              className={`absolute inset-y-0 left-0 ${worst ? 'bg-severity-critical' : 'bg-severity-critical/45'}`}
                              style={{ width: `${overduePct}%` }}
                            />
                          </span>
                        ) : null}
                        <span
                          className={`w-12 shrink-0 text-right tabular-nums font-medium ${
                            worst ? 'text-severity-critical' : 'text-severity-critical/80'
                          }`}
                          title={worst ? 'among the most overdue breaches in view' : undefined}
                        >
                          {formatHours(overdue)}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 align-top">
                      <Link
                        href={`/app/reviews/${encodeURIComponent(b.reviewId)}` as any}
                        className="inline-flex h-6 items-center gap-1 rounded-sm border border-border bg-bg px-1.5 text-fg-muted hover:bg-bg-muted hover:text-fg"
                        aria-label={`open review ${b.owner}/${b.repo} #${b.prNumber}`}
                      >
                        open
                        <ArrowRight size={11} weight="bold" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      {items.length > 0 ? (
        <div className="text-right font-mono text-[11px] tabular-nums text-fg-subtle">
          showing {items.length} of {totalBreaches}
          {severity !== 'all' ? ` (${severity})` : ''}
        </div>
      ) : null}
    </div>
  );
}

function SortableTh({
  href,
  active,
  dir,
  children,
  numeric,
  align,
  className,
}: {
  href: string;
  active: boolean;
  dir: SlaSortDir;
  children: React.ReactNode;
  numeric?: boolean;
  align?: 'left' | 'right';
  className?: string;
}) {
  const justify = align === 'right' ? 'justify-end' : 'justify-start';
  return (
    <th className={`font-medium ${numeric ? 'tabular-nums' : ''} ${className ?? ''}`}>
      <Link
        href={href as any}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`group inline-flex items-center gap-0.5 ${justify} transition-colors ${active ? 'text-fg' : 'hover:text-fg'}`}
      >
        <span>{children}</span>
        <span className={`flex h-3 w-3 items-center justify-center ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}>
          {dir === 'asc' && active ? <ArrowUp size={9} weight="bold" /> : <ArrowDown size={9} weight="bold" />}
        </span>
      </Link>
    </th>
  );
}
