'use client';

import { useMemo, useState } from 'react';
import { EmptyState, LockIcon } from '@clawreview/ui';

import type { AuditEntry } from '@/lib/data';

interface Props {
  entries: AuditEntry[];
}

export function AuditTable({ entries }: Props) {
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<string>('all');

  const actions = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.action);
    return ['all', ...Array.from(set).sort()];
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (action !== 'all' && e.action !== action) return false;
      if (!q) return true;
      return (
        e.actorLogin.toLowerCase().includes(q) ||
        e.action.toLowerCase().includes(q) ||
        (e.subject ?? '').toLowerCase().includes(q)
      );
    });
  }, [entries, query, action]);

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<LockIcon size={28} />}
        title="No entries yet"
        description="Sign in events, dismissals, and config changes will land here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by actor, action, or subject"
          className="h-9 flex-1 min-w-[220px] rounded-md border border-border bg-bg px-3 text-sm text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
        />
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="h-9 rounded-md border border-border bg-bg px-2 text-sm text-fg focus:border-border-strong focus:outline-none"
        >
          {actions.map((a) => (
            <option key={a} value={a}>
              {a === 'all' ? 'All actions' : a}
            </option>
          ))}
        </select>
        <span className="text-xs text-fg-muted">
          {filtered.length} of {entries.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-border bg-bg-subtle/40 px-3 py-6 text-center text-sm text-fg-muted">
          Nothing matches the current filter.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
              <tr>
                <th className="py-2 font-medium">When</th>
                <th className="font-medium">Actor</th>
                <th className="font-medium">Action</th>
                <th className="font-medium">Subject</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap py-2 text-fg-muted">
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td className="font-medium text-fg">{e.actorLogin}</td>
                  <td className="text-fg-muted">{e.action}</td>
                  <td className="text-fg-muted">{e.subject ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
