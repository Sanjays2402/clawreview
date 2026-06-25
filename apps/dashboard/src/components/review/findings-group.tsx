'use client';

import { useCallback, useEffect, useState } from 'react';
import { CaretDown, FolderOpen } from '@phosphor-icons/react';

import { FindingRow } from './finding-row';
import type { FindingDto, Severity } from '@/lib/data';

const SEV_BAR: Record<Severity, string> = {
  critical: 'bg-severity-critical',
  high: 'bg-severity-high',
  medium: 'bg-severity-medium',
  low: 'bg-severity-low',
  nit: 'bg-severity-nit',
};

const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'nit'];

export interface FileGroup {
  file: string;
  findings: FindingDto[];
  counts: Record<Severity, number>;
  total: number;
}

export function groupFindingsByFile(findings: FindingDto[]): FileGroup[] {
  const byFile = new Map<string, FindingDto[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  const groups: FileGroup[] = [];
  for (const [file, list] of byFile) {
    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, nit: 0 };
    for (const f of list) counts[f.severity] += 1;
    groups.push({ file, findings: list, counts, total: list.length });
  }
  // Order: highest-severity-first, then by count, then by path
  groups.sort((a, b) => {
    for (const sev of SEV_ORDER) {
      const av = a.counts[sev] ?? 0;
      const bv = b.counts[sev] ?? 0;
      if (av !== bv) return bv - av;
    }
    if (b.total !== a.total) return b.total - a.total;
    return a.file.localeCompare(b.file);
  });
  return groups;
}

function storageKey(reviewId: string): string {
  return `clawreview-findings-expand:${reviewId}`;
}

interface PersistentExpand {
  /** Effective open state: an explicit override if present, else the fallback. */
  isOpen: (file: string, fallback: boolean) => boolean;
  /** True when the file has an explicit stored override (drives the "remembered" dot). */
  hasOverride: (file: string) => boolean;
  /** Flip the file relative to its CURRENT visible state and persist the result. */
  toggle: (file: string, fallback: boolean) => void;
}

/**
 * Per-review file-group expand state, persisted to localStorage so a reload
 * (or navigating back to the review) restores exactly which sections the
 * operator had open. Only explicit user toggles are stored -- a file with no
 * stored entry falls back to its server-rendered default (first N open).
 *
 * SSR-safe: the first paint always uses the defaults (so server / client
 * markup match), then a post-mount effect overlays the stored overrides.
 * Stale keys for files no longer present are pruned on load.
 */
function usePersistentExpand(reviewId: string, files: string[]): PersistentExpand {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let next: Record<string, boolean> = {};
    try {
      const raw = localStorage.getItem(storageKey(reviewId));
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, boolean>;
        const present = new Set(files);
        for (const [k, v] of Object.entries(parsed)) {
          if (present.has(k) && typeof v === 'boolean') next[k] = v;
        }
      }
    } catch {
      next = {};
    }
    setOverrides(next);
    // files identity changes only when the review's file set changes
  }, [reviewId, files.join('\u0000')]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = useCallback(
    (next: Record<string, boolean>) => {
      try {
        if (Object.keys(next).length === 0) localStorage.removeItem(storageKey(reviewId));
        else localStorage.setItem(storageKey(reviewId), JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [reviewId],
  );

  const isOpen = useCallback(
    (file: string, fallback: boolean) => (file in overrides ? overrides[file]! : fallback),
    [overrides],
  );

  const hasOverride = useCallback((file: string) => file in overrides, [overrides]);

  const toggle = useCallback(
    (file: string, fallback: boolean) => {
      setOverrides((prev) => {
        const current = file in prev ? prev[file]! : fallback;
        const next = { ...prev, [file]: !current };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  return { isOpen, hasOverride, toggle };
}

export function FindingsGroupedByFile({
  groups,
  reviewId,
  initiallyOpen = 5,
}: {
  groups: FileGroup[];
  reviewId: string;
  initiallyOpen?: number;
}) {
  const files = groups.map((g) => g.file);
  const { isOpen, hasOverride, toggle } = usePersistentExpand(reviewId, files);

  return (
    <ul className="space-y-1.5">
      {groups.map((g, i) => {
        const fallback = i < initiallyOpen;
        return (
          <FileGroupCard
            key={g.file}
            group={g}
            reviewId={reviewId}
            open={isOpen(g.file, fallback)}
            persisted={hasOverride(g.file)}
            onToggle={() => toggle(g.file, fallback)}
          />
        );
      })}
    </ul>
  );
}

function FileGroupCard({
  group,
  reviewId,
  open,
  onToggle,
  persisted,
}: {
  group: FileGroup;
  reviewId: string;
  open: boolean;
  onToggle: () => void;
  persisted?: boolean;
}) {
  return (
    <li className="overflow-hidden rounded-sm border border-border-subtle">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-bg-subtle/30 px-2.5 py-1.5 text-left transition-colors hover:bg-bg-subtle/60"
      >
        <CaretDown
          size={11}
          weight="bold"
          className={`shrink-0 text-fg-subtle transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <FolderOpen size={12} weight="duotone" className="shrink-0 text-fg-subtle" />
        <span className="mono truncate text-fg" title={group.file}>
          {group.file}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {persisted ? (
            <span
              className="h-1 w-1 rounded-full bg-accent/70"
              aria-hidden
              title="remembered for this review"
            />
          ) : null}
          <SeverityMiniBar counts={group.counts} total={group.total} />
          <span className="font-mono text-[11px] tabular-nums text-fg-muted">
            {group.total}
          </span>
        </span>
      </button>
      {open ? (
        <ul className="divide-y divide-border-subtle/60 border-t border-border-subtle">
          {group.findings.map((f) => (
            <FindingRow key={f.id} finding={f} reviewId={reviewId} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SeverityMiniBar({ counts, total }: { counts: Record<Severity, number>; total: number }) {
  if (total === 0) return null;
  return (
    <span className="flex h-1.5 w-20 overflow-hidden rounded-sm bg-bg-muted">
      {SEV_ORDER.map((sev) => {
        const v = counts[sev] ?? 0;
        if (v === 0) return null;
        const pct = (v / total) * 100;
        return (
          <span
            key={sev}
            className={SEV_BAR[sev]}
            style={{ width: `${pct}%` }}
            title={`${sev}: ${v}`}
          />
        );
      })}
    </span>
  );
}
