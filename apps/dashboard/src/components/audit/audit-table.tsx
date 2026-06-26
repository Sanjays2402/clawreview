import Link from 'next/link';
import { ArrowUp, ArrowDown, X } from '@phosphor-icons/react/dist/ssr';

import { EmptyState, LockIcon } from '@clawreview/ui';

import { ListKeyboardNav } from '@/components/list-keyboard-nav';
import { LiveRelativeTime } from '@/components/ui/live-relative-time';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import type { AuditEntry } from '@/lib/data';

export type AuditSortKey = 'when' | 'actor' | 'action';
export type AuditSortDir = 'asc' | 'desc';

const SORT_KEYS: AuditSortKey[] = ['when', 'actor', 'action'];

export function parseAuditSort(raw: string | undefined): AuditSortKey {
  return SORT_KEYS.includes((raw ?? 'when') as AuditSortKey) ? (raw as AuditSortKey) : 'when';
}
export function parseAuditDir(raw: string | undefined, fallback: AuditSortDir): AuditSortDir {
  return raw === 'asc' || raw === 'desc' ? raw : fallback;
}

function defaultDirFor(key: AuditSortKey): AuditSortDir {
  // Time defaults newest-first; text columns default A-Z.
  return key === 'when' ? 'desc' : 'asc';
}

export function filterAuditEntries(
  entries: AuditEntry[],
  opts: { action: string; query: string },
): AuditEntry[] {
  const q = opts.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (opts.action !== 'all' && e.action !== opts.action) return false;
    if (!q) return true;
    return (
      e.actorLogin.toLowerCase().includes(q) ||
      e.action.toLowerCase().includes(q) ||
      (e.subject ?? '').toLowerCase().includes(q)
    );
  });
}

export function sortAuditEntries(
  entries: AuditEntry[],
  key: AuditSortKey,
  dir: AuditSortDir,
): AuditEntry[] {
  const mult = dir === 'asc' ? 1 : -1;
  const copy = entries.slice();
  copy.sort((a, b) => {
    if (key === 'when') {
      const av = Date.parse(a.createdAt) || 0;
      const bv = Date.parse(b.createdAt) || 0;
      if (av === bv) return a.id.localeCompare(b.id);
      return (av - bv) * mult;
    }
    if (key === 'actor') {
      const c = a.actorLogin.localeCompare(b.actorLogin);
      return (c !== 0 ? c : a.id.localeCompare(b.id)) * (dir === 'asc' ? 1 : -1);
    }
    // action
    const c = a.action.localeCompare(b.action);
    return (c !== 0 ? c : a.id.localeCompare(b.id)) * (dir === 'asc' ? 1 : -1);
  });
  return copy;
}

interface Props {
  entries: AuditEntry[];
  action: string;
  query: string;
  sortKey: AuditSortKey;
  sortDir: AuditSortDir;
}

export function AuditTable({ entries, action, query, sortKey, sortDir }: Props) {
  const actions = (() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.action);
    return ['all', ...Array.from(set).sort()];
  })();

  const filtered = filterAuditEntries(entries, { action, query });
  const items = sortAuditEntries(filtered, sortKey, sortDir);

  function hrefWith(next: Partial<{ action: string; q: string; sort: string; dir: string }>): string {
    const qs = new URLSearchParams();
    const ac = next.action ?? (action === 'all' ? '' : action);
    const qq = next.q ?? query;
    const sr = next.sort ?? sortKey;
    const dr = next.dir ?? sortDir;
    if (ac) qs.set('action', ac);
    if (qq) qs.set('q', qq);
    if (sr && sr !== 'when') qs.set('sort', sr);
    if (dr && dr !== defaultDirFor(sr as AuditSortKey)) qs.set('dir', dr);
    const tail = qs.toString();
    return `/app/audit${tail ? `?${tail}` : ''}`;
  }

  function sortHref(col: AuditSortKey): string {
    if (sortKey === col) return hrefWith({ sort: col, dir: sortDir === 'asc' ? 'desc' : 'asc' });
    return hrefWith({ sort: col, dir: defaultDirFor(col) });
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<LockIcon size={24} />}
        title="no entries yet"
        description="sign-in events, dismissals, and config changes land here."
        action={
          <EmptyStateActions
            primary={{ label: 'view reviews', href: '/app/reviews' }}
            secondary={{ label: 'view docs', href: '/docs', external: true }}
          />
        }
      />
    );
  }

  const chips: Array<{ label: string; href: string }> = [];
  if (action !== 'all') chips.push({ label: `action: ${action}`, href: hrefWith({ action: '' }) });
  if (query) chips.push({ label: `search: ${query}`, href: hrefWith({ q: '' }) });
  if (sortKey !== 'when' || sortDir !== defaultDirFor('when')) {
    chips.push({
      label: `sort: ${sortKey} ${sortDir === 'desc' ? '↓' : '↑'}`,
      href: hrefWith({ sort: 'when', dir: 'desc' }),
    });
  }

  return (
    <div className="space-y-3">
      <ListKeyboardNav selector="[data-audit-row]" enabled={items.length > 0} />

      {/* Search + action filter row (GET form -> server-side filter) */}
      <form action="/app/audit" method="get" className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
        {/* preserve sort across a new search */}
        {sortKey !== 'when' ? <input type="hidden" name="sort" value={sortKey} /> : null}
        {sortDir !== defaultDirFor(sortKey) ? <input type="hidden" name="dir" value={sortDir} /> : null}
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="filter by actor, action, or subject"
          className="h-6 min-w-[220px] flex-1 rounded-sm border border-border bg-bg px-2 text-[11px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
        />
        <select
          name="action"
          defaultValue={action === 'all' ? '' : action}
          className="h-6 rounded-sm border border-border bg-bg px-1 text-[11px] text-fg focus:border-accent focus:outline-none"
        >
          {actions.map((a) => (
            <option key={a} value={a === 'all' ? '' : a}>
              {a === 'all' ? 'all actions' : a}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="h-6 rounded-sm border border-border bg-bg-subtle px-2 text-fg-muted hover:bg-bg-muted hover:text-fg"
        >
          apply
        </button>
        <span className="tabular-nums text-fg-subtle">
          {items.length} / {entries.length}
        </span>
      </form>

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
          <Link href={'/app/audit' as any} className="ml-1 lowercase text-fg-subtle hover:text-fg">
            clear all
          </Link>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-sm border border-border bg-bg-subtle/40 px-3 py-6 text-center font-mono text-xs text-fg-muted">
          nothing matches the current filter.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-sm border border-border-subtle">
          <table className="w-full min-w-[640px] font-mono text-xs">
            <thead className="bg-bg-subtle/50 text-left text-[10px] uppercase tracking-wider text-fg-subtle">
              <tr>
                <SortableTh href={sortHref('when')} active={sortKey === 'when'} dir={sortDir} className="px-3">
                  when
                </SortableTh>
                <SortableTh href={sortHref('actor')} active={sortKey === 'actor'} dir={sortDir}>
                  actor
                </SortableTh>
                <SortableTh href={sortHref('action')} active={sortKey === 'action'} dir={sortDir}>
                  action
                </SortableTh>
                <th className="px-3 font-medium">subject</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {items.map((e) => (
                <tr key={e.id} className="group/row hover:bg-bg-subtle/40 focus-within:bg-accent/[0.07]">
                  <td className="px-3 py-1.5">
                    <span
                      data-audit-row
                      tabIndex={0}
                      title={new Date(e.createdAt).toLocaleString()}
                      className="block rounded-sm tabular-nums text-fg-muted outline-none ring-accent/60 focus-visible:ring-1"
                    >
                      <LiveRelativeTime iso={e.createdAt} />
                    </span>
                  </td>
                  <td className="font-medium text-fg">{e.actorLogin}</td>
                  <td className="text-fg-muted">{e.action}</td>
                  <td className="px-3 text-fg-muted">{e.subject ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SortableTh({
  href,
  active,
  dir,
  children,
  className,
}: {
  href: string;
  active: boolean;
  dir: AuditSortDir;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`font-medium ${className ?? ''}`}>
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
