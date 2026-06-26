import Link from 'next/link';
import { GitBranch, X, ArrowUp, ArrowDown } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { StickyBar } from '@/components/ui/sticky-bar';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import { ListKeyboardNav } from '@/components/list-keyboard-nav';
import { Kbd } from '@/components/ui/kbd';
import { LiveRelativeTime } from '@/components/ui/live-relative-time';
import { getRepoHealthList, type RepoHealth } from '@/lib/data';

type RepoStatus = RepoHealth['status'];
type SortKey = 'repo' | 'failures' | 'lastReview';
type SortDir = 'asc' | 'desc';

const STATUS_TABS: Array<{ key: RepoStatus | 'all'; label: string }> = [
  { key: 'all', label: 'all' },
  { key: 'healthy', label: 'healthy' },
  { key: 'degraded', label: 'degraded' },
  { key: 'paused', label: 'paused' },
];

const SORT_KEYS: SortKey[] = ['repo', 'failures', 'lastReview'];

function statusTone(s: RepoStatus): string {
  if (s === 'healthy') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  if (s === 'degraded') return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400';
  return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400';
}

function repoSlug(r: RepoHealth): string {
  return `${r.owner}__${r.repo}`;
}

function parseSort(raw: string | undefined): SortKey {
  return SORT_KEYS.includes((raw ?? 'repo') as SortKey) ? (raw as SortKey) : 'repo';
}
function parseDir(raw: string | undefined, fallback: SortDir): SortDir {
  return raw === 'asc' || raw === 'desc' ? raw : fallback;
}

function sortItems(items: RepoHealth[], key: SortKey, dir: SortDir): RepoHealth[] {
  const mult = dir === 'asc' ? 1 : -1;
  const copy = items.slice();
  copy.sort((a, b) => {
    if (key === 'repo') {
      return `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`) * mult;
    }
    if (key === 'failures') {
      if (a.failures === b.failures) return `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`);
      return (a.failures - b.failures) * mult;
    }
    // lastReview
    const av = a.lastReviewAt ? Date.parse(a.lastReviewAt) || 0 : 0;
    const bv = b.lastReviewAt ? Date.parse(b.lastReviewAt) || 0 : 0;
    if (av === bv) return `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`);
    return (av - bv) * mult;
  });
  return copy;
}

interface PageProps {
  searchParams: Promise<{ status?: string; sort?: string; dir?: string }>;
}

export default async function ReposPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = (STATUS_TABS.find((t) => t.key === sp.status)?.key ?? 'all') as RepoStatus | 'all';
  const sortKey = parseSort(sp.sort);
  // Default direction per column: name asc (A-Z), numerics/time desc.
  const sortDir = parseDir(sp.dir, sortKey === 'repo' ? 'asc' : 'desc');

  const all = await getRepoHealthList();
  const filtered = status === 'all' ? all : all.filter((r) => r.status === status);
  const items = sortItems(filtered, sortKey, sortDir);

  function hrefWith(next: Partial<{ status: string; sort: string; dir: string }>): string {
    const qs = new URLSearchParams();
    const st = next.status ?? (status === 'all' ? '' : status);
    const sr = next.sort ?? sortKey;
    const dr = next.dir ?? sortDir;
    const defaultDir = sr === 'repo' ? 'asc' : 'desc';
    if (st) qs.set('status', st);
    if (sr && sr !== 'repo') qs.set('sort', sr);
    if (dr && dr !== defaultDir) qs.set('dir', dr);
    const tail = qs.toString();
    return `/app/repos${tail ? `?${tail}` : ''}`;
  }

  function sortHref(col: SortKey): string {
    const defaultDir: SortDir = col === 'repo' ? 'asc' : 'desc';
    if (sortKey === col) return hrefWith({ sort: col, dir: sortDir === 'asc' ? 'desc' : 'asc' });
    return hrefWith({ sort: col, dir: defaultDir });
  }

  const chips: Array<{ label: string; href: string }> = [];
  if (status !== 'all') chips.push({ label: `status: ${status}`, href: hrefWith({ status: '' }) });
  const defaultDirForKey: SortDir = sortKey === 'repo' ? 'asc' : 'desc';
  if (sortKey !== 'repo' || sortDir !== defaultDirForKey) {
    chips.push({
      label: `sort: ${sortKey} ${sortDir === 'desc' ? '↓' : '↑'}`,
      href: hrefWith({ sort: 'repo', dir: 'asc' }),
    });
  }

  const counts: Record<RepoStatus | 'all', number> = {
    all: all.length,
    healthy: all.filter((r) => r.status === 'healthy').length,
    degraded: all.filter((r) => r.status === 'degraded').length,
    paused: all.filter((r) => r.status === 'paused').length,
  };

  return (
    <div className="space-y-3">
      <ListKeyboardNav selector="[data-repo-row]" enabled={items.length > 0} />
      <PageHeader
        title="repos"
        description="health, recent activity, pause controls for tracked repos."
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

      <StickyBar backToTop>
        <div className="flex flex-wrap items-center gap-px font-mono text-[11px]">
          {STATUS_TABS.map((t) => {
            const active = t.key === status;
            const href = t.key === 'all' ? hrefWith({ status: '' }) : hrefWith({ status: t.key });
            return (
              <Link
                key={t.key}
                href={href as any}
                className={`-mb-px flex items-center gap-1 border-b-2 px-2.5 py-1 lowercase transition-colors ${
                  active ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'
                }`}
              >
                {t.label}
                <span className="tabular-nums text-fg-subtle">{counts[t.key]}</span>
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
          <Link href={'/app/repos' as any} className="ml-1 text-fg-subtle hover:text-fg lowercase">
            clear all
          </Link>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
            {items.length} repo{items.length === 1 ? '' : 's'}
          </div>
          <div className="font-mono text-[11px] text-fg-muted">
            sorted by {sortKey} {sortDir === 'desc' ? 'desc' : 'asc'}
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {items.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={<GitBranch size={20} weight="duotone" />}
                title={status === 'all' ? 'no repos' : `no ${status} repos`}
                description={
                  status === 'all'
                    ? 'once a pull request opens on an installed repo, its health shows up here.'
                    : 'no tracked repos are in this state right now.'
                }
                action={
                  status === 'all' ? (
                    <EmptyStateActions
                      primary={{ label: 'configure github app', href: '/app/installations' }}
                      secondary={{ label: 'view docs', href: '/docs', external: true }}
                    />
                  ) : (
                    <EmptyStateActions
                      primary={{ label: 'show all repos', href: '/app/repos' }}
                    />
                  )
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] font-mono text-xs">
                <thead className="bg-bg-subtle/50 text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                  <tr>
                    <SortableTh href={sortHref('repo')} active={sortKey === 'repo'} dir={sortDir} className="px-3">
                      repository
                    </SortableTh>
                    <th className="font-medium">status</th>
                    <SortableTh href={sortHref('failures')} active={sortKey === 'failures'} dir={sortDir} numeric>
                      failures
                    </SortableTh>
                    <SortableTh href={sortHref('lastReview')} active={sortKey === 'lastReview'} dir={sortDir} numeric>
                      last review
                    </SortableTh>
                    <th className="px-3 text-right font-medium">action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {items.map((r) => (
                    <tr key={`${r.owner}/${r.repo}`} className="group/row hover:bg-bg-subtle/40 focus-within:bg-accent/[0.07]">
                      <td className="px-3 py-1.5">
                        <Link
                          href={`/app/repos/${repoSlug(r)}` as any}
                          data-repo-row
                          className="block rounded-sm outline-none ring-accent/60 focus-visible:ring-1"
                        >
                          <div className="text-fg">
                            {r.owner}<span className="text-fg-subtle">/</span>{r.repo}
                          </div>
                          {r.pauseReason ? (
                            <div className="text-[10px] text-fg-subtle">{r.pauseReason}</div>
                          ) : null}
                        </Link>
                      </td>
                      <td>
                        <span
                          className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium lowercase ${statusTone(r.status)}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="tabular-nums text-fg-muted">
                        <span className={r.failures > 0 ? 'text-severity-high' : 'text-fg-subtle'}>{r.failures}</span>
                      </td>
                      <td className="tabular-nums text-fg-muted">
                        {r.lastReviewAt ? (
                          <LiveRelativeTime iso={r.lastReviewAt} />
                        ) : (
                          <span className="text-fg-subtle">never</span>
                        )}
                      </td>
                      <td className="px-3 text-right">
                        <Link
                          href={`/app/repos/${repoSlug(r)}` as any}
                          className="text-fg-muted hover:text-fg"
                        >
                          manage
                        </Link>
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
  className,
}: {
  href: string;
  active: boolean;
  dir: SortDir;
  children: React.ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <th className={`font-medium ${numeric ? 'tabular-nums' : ''} ${className ?? ''}`}>
      <Link
        href={href as any}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`group inline-flex items-center gap-0.5 transition-colors ${active ? 'text-fg' : 'hover:text-fg'}`}
      >
        <span>{children}</span>
        <span className={`flex h-3 w-3 items-center justify-center ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}>
          {dir === 'asc' && active ? <ArrowUp size={9} weight="bold" /> : <ArrowDown size={9} weight="bold" />}
        </span>
      </Link>
    </th>
  );
}
