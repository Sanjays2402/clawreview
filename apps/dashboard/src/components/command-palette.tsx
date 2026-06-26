'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  href?: string;
  action?: () => void;
  /** Grouping bucket for the sectioned list. */
  group: 'navigate' | 'reviews';
  /** Extra haystack text for fuzzy matching (repo slug, sha, etc). */
  keywords?: string;
}

const ROUTES: Cmd[] = [
  { id: 'overview', label: 'go: overview', hint: 'g o', href: '/app', group: 'navigate' },
  { id: 'reviews', label: 'go: reviews', hint: 'g r', href: '/app/reviews', group: 'navigate' },
  { id: 'repos', label: 'go: repos', hint: 'g p', href: '/app/repos', group: 'navigate' },
  { id: 'installations', label: 'go: installations', hint: 'g i', href: '/app/installations', group: 'navigate' },
  { id: 'trends', label: 'go: trends', hint: 'g t', href: '/app/trends', group: 'navigate' },
  { id: 'sla', label: 'go: sla', hint: 'g s', href: '/app/sla', group: 'navigate' },
  { id: 'budget', label: 'go: budget', hint: 'g b', href: '/app/budget', group: 'navigate' },
  { id: 'audit', label: 'go: audit', hint: 'g a', href: '/app/audit', group: 'navigate' },
  { id: 'config', label: 'go: config', hint: 'g c', href: '/app/config', group: 'navigate' },
  { id: 'integrations', label: 'go: integrations', href: '/app/integrations', group: 'navigate' },
  { id: 'team', label: 'go: team', href: '/app/team', group: 'navigate' },
  { id: 'keys', label: 'go: api keys', hint: 'g k', href: '/app/api-keys', group: 'navigate' },
  { id: 'settings', label: 'go: settings', href: '/app/settings', group: 'navigate' },
  { id: 'shortcuts', label: 'shortcuts (page)', href: '/shortcuts', group: 'navigate' },
  { id: 'docs', label: 'docs', href: '/docs', group: 'navigate' },
];

const GROUP_LABEL: Record<Cmd['group'], string> = {
  navigate: 'navigate',
  reviews: 'recent reviews',
};

export interface RecentReviewEntry {
  id: string;
  owner: string;
  repo: string;
  prNumber: number;
  status: string;
}

/**
 * Subsequence fuzzy match: every char of `needle` appears in order in
 * `haystack`. Cheap and good enough for a command palette over a handful of
 * routes + recent reviews. Returns a rough score (lower = tighter match) so
 * exact substring hits float above scattered subsequence hits.
 */
function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  const idx = haystack.indexOf(needle);
  if (idx >= 0) return idx; // contiguous substring: best, ranked by position
  let h = 0;
  let firstAt = -1;
  for (let n = 0; n < needle.length; n++) {
    const c = needle[n]!;
    let found = -1;
    for (; h < haystack.length; h++) {
      if (haystack[h] === c) {
        found = h;
        h++;
        break;
      }
    }
    if (found < 0) return null;
    if (firstAt < 0) firstAt = found;
  }
  // Scattered match ranks below any substring hit (offset by 1000).
  return 1000 + firstAt;
}

export function CommandPalette({ recentReviews = [] }: { recentReviews?: RecentReviewEntry[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const router = useRouter();
  // Per-row DOM handles (keyed by flat index) so arrow-key nav can keep the
  // active row scrolled into view on a long fuzzy-filtered list.
  const rowRefs = useRef<Map<number, HTMLLIElement>>(new Map());

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

  // Build the full command set: static routes + a jump entry per recent review.
  const commands = useMemo<Cmd[]>(() => {
    const reviewCmds: Cmd[] = recentReviews.map((r) => ({
      id: `review-${r.id}`,
      label: `jump: ${r.owner}/${r.repo} #${r.prNumber}`,
      hint: r.status,
      href: `/app/reviews/${r.id}`,
      group: 'reviews',
      keywords: `${r.owner} ${r.repo} ${r.prNumber} #${r.prNumber} ${r.status} ${r.id}`,
    }));
    return [...ROUTES, ...reviewCmds];
  }, [recentReviews]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    const scored: Array<{ cmd: Cmd; score: number }> = [];
    for (const cmd of commands) {
      const hay = `${cmd.label} ${cmd.id} ${cmd.keywords ?? ''}`.toLowerCase();
      const score = fuzzyScore(needle, hay);
      if (score != null) scored.push({ cmd, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.cmd);
  }, [q, commands]);

  // Keep the active row visible as arrow-key / ctrl-n/p nav moves `idx`. The
  // list is a fixed-height scroll container, so `block: 'nearest'` nudges just
  // enough to reveal the row without yanking the whole palette around. Runs on
  // every idx change AND whenever the filtered set shrinks/grows under the cursor.
  useEffect(() => {
    if (!open) return;
    const el = rowRefs.current.get(idx);
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx, open, filtered]);

  if (!open) return null;

  function run(cmd: Cmd) {
    close();
    if (cmd.href) router.push(cmd.href as any);
    else cmd.action?.();
  }

  // Group the (already-ordered) filtered list into sections, preserving order.
  const sections: Array<{ group: Cmd['group']; items: Array<{ cmd: Cmd; flatIndex: number }> }> = [];
  filtered.forEach((cmd, i) => {
    let sec = sections.find((s) => s.group === cmd.group);
    if (!sec) {
      sec = { group: cmd.group, items: [] };
      sections.push(sec);
    }
    sec.items.push({ cmd, flatIndex: i });
  });

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
            const len = filtered.length;
            if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
              e.preventDefault();
              // Wrap past the last row back to the first (standard palette feel).
              setIdx((i) => (len === 0 ? 0 : (i + 1) % len));
            } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
              e.preventDefault();
              // Wrap before the first row to the last.
              setIdx((i) => (len === 0 ? 0 : (i - 1 + len) % len));
            } else if (e.key === 'Home') {
              e.preventDefault();
              setIdx(0);
            } else if (e.key === 'End') {
              e.preventDefault();
              setIdx(len === 0 ? 0 : len - 1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const cmd = filtered[idx];
              if (cmd) run(cmd);
            }
          }}
          placeholder="jump to a page or review..."
          className="w-full border-b border-border-subtle bg-bg px-3 py-2.5 font-mono text-xs text-fg outline-none placeholder:text-fg-subtle"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 font-mono text-xs text-fg-subtle">no matches</li>
          ) : (
            sections.map((sec) => (
              <li key={sec.group}>
                <div className="px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                  {GROUP_LABEL[sec.group]}
                </div>
                <ul>
                  {sec.items.map(({ cmd, flatIndex }) => (
                    <li
                      key={cmd.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(flatIndex, el);
                        else rowRefs.current.delete(flatIndex);
                      }}
                      onMouseEnter={() => setIdx(flatIndex)}
                      onClick={() => run(cmd)}
                      className={`flex cursor-pointer items-center justify-between px-3 py-1.5 font-mono text-xs ${
                        flatIndex === idx ? 'bg-accent/15 text-fg' : 'text-fg-muted'
                      }`}
                    >
                      <span className="truncate">{cmd.label}</span>
                      {cmd.hint ? <span className="ml-2 shrink-0 text-fg-subtle">{cmd.hint}</span> : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-border-subtle bg-bg-subtle/40 px-3 py-1.5 font-mono text-[10px] text-fg-subtle">
          <span>↑↓ wrap · ⤒⤓ ends · ↵ select · esc close</span>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  );
}
