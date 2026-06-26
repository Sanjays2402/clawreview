import Link from 'next/link';
import { GitPullRequest, X, ArrowUp, ArrowDown } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { StatusPill } from '@/components/review/status-pill';
import { ListKeyboardNav } from '@/components/list-keyboard-nav';
import { Kbd } from '@/components/ui/kbd';
import { StickyBar } from '@/components/ui/sticky-bar';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import { LiveRelativeTime } from '@/components/ui/live-relative-time';
import { listReviews, type ReviewListItem, type ReviewStatus } from '@/lib/data';
import { formatMs, formatUsd } from '@/lib/format';

const STATUS_TABS: Array<{ key: ReviewStatus | 'all'; label: string }> = [
  { key: 'all', label: 'all' },
  { key: 'running', label: 'running' },
  { key: 'completed', label: 'completed' },
  { key: 'failed', label: 'failed' },
  { key: 'queued', label: 'queued' },
];

type SortKey = 'created' | 'findings' | 'duration' | 'spend';
type SortDir = 'asc' | 'desc';

interface PageProps {
  searchParams: Promise<{
    status?: string;
    owner?: string;
    repo?: string;
    sort?: string;
    dir?: string;
  }>;
}

const SORT_KEYS: SortKey[] = ['created', 'findings', 'duration', 'spend'];

function parseSort(raw: string | undefined): SortKey {
  return SORT_KEYS.includes((raw ?? 'created') as SortKey) ? (raw as SortKey) : 'created';
}
function parseDir(raw: string | undefined): SortDir {
  return raw === 'asc' ? 'asc' : 'desc';
}

function sortItems(items: ReviewListItem[], key: SortKey, dir: SortDir): ReviewListItem[] {
  const mult = dir === 'asc' ? 1 : -1;
  const copy = items.slice();
  copy.sort((a, b) => {
    let av = 0;
    let bv = 0;
    if (key === 'created') {
      av = Date.parse(a.createdAt) || 0;
      bv = Date.parse(b.createdAt) || 0;
    } else if (key === 'findings') {
      av = a.totalFindings;
      bv = b.totalFindings;
    } else if (key === 'duration') {
      av = a.durationMs ?? 0;
      bv = b.durationMs ?? 0;
    } else if (key === 'spend') {
      av = a.totalCostUsd;
      bv = b.totalCostUsd;
    }
    if (av === bv) return a.id.localeCompare(b.id);
    return (av - bv) * mult;
  });
  return copy;
}

export default async function ReviewsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = (STATUS_TABS.find((t) => t.key === sp.status)?.key ?? 'all') as ReviewStatus | 'all';
  const sortKey = parseSort(sp.sort);
  const sortDir = parseDir(sp.dir);
  const owner = sp.owner?.trim() || '';
  const repo = sp.repo?.trim() || '';

  const { items: rawItems } = await listReviews({
    limit: 50,
    status: status === 'all' ? undefined : status,
    owner: owner || undefined,
    repo: repo || undefined,
  });
  const items = sortItems(rawItems, sortKey, sortDir);

  function hrefWith(
    next: Partial<{ status: string; owner: string; repo: string; sort: string; dir: string }>,
  ): string {
    const qs = new URLSearchParams();
    const st = next.status ?? (status === 'all' ? '' : status);
    const ow = next.owner ?? owner;
    const rp = next.repo ?? repo;
    const sr = next.sort ?? sortKey;
    const dr = next.dir ?? sortDir;
    if (st) qs.set('status', st);
    if (ow) qs.set('owner', ow);
    if (rp) qs.set('repo', rp);
    if (sr && sr !== 'created') qs.set('sort', sr);
    if (dr && dr !== 'desc') qs.set('dir', dr);
    const tail = qs.toString();
    return `/app/reviews${tail ? `?${tail}` : ''}`;
  }

  function sortHref(col: SortKey): string {
    if (sortKey === col) {
      // toggle direction
      return hrefWith({ sort: col, dir: sortDir === 'desc' ? 'asc' : 'desc' });
    }
    // new column: sensible default direction (desc for numerics, desc for time)
    return hrefWith({ sort: col, dir: 'desc' });
  }

  // Build the active-filters chip row
  const chips: Array<{ label: string; href: string }> = [];
  if (status !== 'all') chips.push({ label: `status: ${status}`, href: hrefWith({ status: '' }) });
  if (owner) chips.push({ label: `owner: ${owner}`, href: hrefWith({ owner: '' }) });
  if (repo) chips.push({ label: `repo: ${repo}`, href: hrefWith({ repo: '' }) });
  if (sortKey !== 'created' || sortDir !== 'desc') {
    chips.push({
      label: `sort: ${sortKey} ${sortDir === 'desc' ? '↓' : '↑'}`,
      href: hrefWith({ sort: 'created', dir: 'desc' }),
    });
  }

  return (
    <div className="space-y-3">
      <ListKeyboardNav selector="[data-review-row]" enabled={items.length > 0} />
      <PageHeader
        title="reviews"
        description="every review across installations you can see."
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

      <StickyBar>
        <div className="flex flex-wrap items-center gap-px font-mono text-[11px]">
          {STATUS_TABS.map((t) => {
            const active = t.key === status;
            const href = t.key === 'all' ? hrefWith({ status: '' }) : hrefWith({ status: t.key });
            return (
              <Link
                key={t.key}
                href={href as any}
                className={`-mb-px border-b-2 px-2.5 py-1 lowercase transition-colors ${
                  active ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </StickyBar>

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
          <Link
            href={'/app/reviews' as any}
            className="ml-1 text-fg-subtle hover:text-fg lowercase"
          >
            clear all
          </Link>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
            {items.length} result{items.length === 1 ? '' : 's'}
          </div>
          <div className="font-mono text-[11px] text-fg-muted">
            sorted by {sortKey} {sortDir === 'desc' ? 'desc' : 'asc'}
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {items.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={<GitPullRequest size={20} weight="duotone" />}
                title={chips.length > 0 ? 'no matches' : 'no reviews yet'}
                description={
                  chips.length > 0
                    ? 'no reviews match the current filters.'
                    : 'install the github app on a repo, then open a pr — the first review lands in seconds.'
                }
                action={
                  chips.length > 0 ? (
                    <EmptyStateActions
                      primary={{ label: 'clear filters', href: '/app/reviews' }}
                      secondary={{ label: 'view docs', href: '/docs', external: true }}
                    />
                  ) : (
                    <EmptyStateActions
                      primary={{ label: 'configure github app', href: '/app/installations' }}
                      secondary={{ label: 'view docs', href: '/docs', external: true }}
                    />
                  )
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] font-mono text-xs">
                <thead className="bg-bg-subtle/50 text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">pull request</th>
                    <th className="font-medium">status</th>
                    <SortableTh href={sortHref('findings')} active={sortKey === 'findings'} dir={sortDir}>
                      findings
                    </SortableTh>
                    <SortableTh href={sortHref('duration')} active={sortKey === 'duration'} dir={sortDir} numeric>
                      duration
                    </SortableTh>
                    <SortableTh href={sortHref('spend')} active={sortKey === 'spend'} dir={sortDir} numeric>
                      spend
                    </SortableTh>
                    <SortableTh
                      href={sortHref('created')}
                      active={sortKey === 'created'}
                      dir={sortDir}
                      numeric
                      align="right"
                      className="px-3"
                    >
                      created
                    </SortableTh>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {items.map((r) => (
                    <tr key={r.id} className="group/row hover:bg-bg-subtle/40 focus-within:bg-accent/[0.07]">
                      <td className="px-3 py-1.5">
                        <Link
                          href={`/app/reviews/${r.id}` as any}
                          data-review-row
                          className="block rounded-sm outline-none ring-accent/60 focus-visible:ring-1"
                        >
                          <div className="text-fg">
                            {r.owner}/{r.repo} <span className="text-fg-subtle">#</span>{r.prNumber}
                          </div>
                          <div className="text-[10px] text-fg-subtle">{r.headSha.slice(0, 8)}</div>
                        </Link>
                      </td>
                      <td><StatusPill status={r.status} /></td>
                      <td className="text-fg-muted">
                        <span className="tabular-nums text-fg">{r.openFindings}</span>
                        <span className="tabular-nums text-fg-subtle"> / {r.totalFindings}</span>
                      </td>
                      <td className="tabular-nums text-fg-muted">{formatMs(r.durationMs)}</td>
                      <td className="tabular-nums text-fg-muted">{formatUsd(r.totalCostUsd)}</td>
                      <td className="px-3 text-right tabular-nums text-fg-muted">
                        <LiveRelativeTime iso={r.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
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
  dir: SortDir;
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
        className={`group inline-flex items-center gap-0.5 ${justify} transition-colors ${
          active ? 'text-fg' : 'hover:text-fg'
        }`}
      >
        <span>{children}</span>
        <span className={`flex h-3 w-3 items-center justify-center ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}>
          {dir === 'asc' && active ? (
            <ArrowUp size={9} weight="bold" />
          ) : (
            <ArrowDown size={9} weight="bold" />
          )}
        </span>
      </Link>
    </th>
  );
}
