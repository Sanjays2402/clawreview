'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  href?: string;
  action?: () => void;
}

const ROUTES: Cmd[] = [
  { id: 'overview', label: 'go: overview', hint: 'g o', href: '/app' },
  { id: 'reviews', label: 'go: reviews', hint: 'g r', href: '/app/reviews' },
  { id: 'repos', label: 'go: repos', href: '/app/repos' },
  { id: 'installations', label: 'go: installations', href: '/app/installations' },
  { id: 'trends', label: 'go: trends', href: '/app/trends' },
  { id: 'sla', label: 'go: sla', href: '/app/sla' },
  { id: 'budget', label: 'go: budget', href: '/app/budget' },
  { id: 'audit', label: 'go: audit', href: '/app/audit' },
  { id: 'config', label: 'go: config', href: '/app/config' },
  { id: 'integrations', label: 'go: integrations', href: '/app/integrations' },
  { id: 'team', label: 'go: team', href: '/app/team' },
  { id: 'keys', label: 'go: api keys', href: '/app/api-keys' },
  { id: 'settings', label: 'go: settings', href: '/app/settings' },
  { id: 'shortcuts', label: 'shortcuts (page)', href: '/shortcuts' },
  { id: 'docs', label: 'docs', href: '/docs' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const router = useRouter();

  const close = useCallback(() => {
    setOpen(false);
    setQ('');
    setIdx(0);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    }
    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-cmdk-trigger]')) {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [open, close, router]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return ROUTES;
    return ROUTES.filter((c) => c.label.toLowerCase().includes(needle) || c.id.includes(needle));
  }, [q]);

  if (!open) return null;

  function run(cmd: Cmd) {
    close();
    if (cmd.href) router.push(cmd.href as any);
    else cmd.action?.();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-md border border-border bg-bg shadow-2xl">
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
              e.preventDefault();
              setIdx((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
              e.preventDefault();
              setIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const cmd = filtered[idx];
              if (cmd) run(cmd);
            }
          }}
          placeholder="type a command..."
          className="w-full border-b border-border-subtle bg-bg px-3 py-2.5 font-mono text-xs text-fg outline-none placeholder:text-fg-subtle"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 font-mono text-xs text-fg-subtle">no matches</li>
          ) : (
            filtered.map((c, i) => (
              <li
                key={c.id}
                onMouseEnter={() => setIdx(i)}
                onClick={() => run(c)}
                className={`flex cursor-pointer items-center justify-between px-3 py-1.5 font-mono text-xs ${
                  i === idx ? 'bg-accent/15 text-fg' : 'text-fg-muted'
                }`}
              >
                <span>{c.label}</span>
                {c.hint ? <span className="text-fg-subtle">{c.hint}</span> : null}
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-border-subtle bg-bg-subtle/40 px-3 py-1.5 font-mono text-[10px] text-fg-subtle">
          <span>↑↓ navigate · ↵ select · esc close</span>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  );
}
