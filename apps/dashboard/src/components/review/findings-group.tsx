'use client';

import { useState } from 'react';
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

export function FindingsGroupedByFile({
  groups,
  reviewId,
  initiallyOpen = 5,
}: {
  groups: FileGroup[];
  reviewId: string;
  initiallyOpen?: number;
}) {
  return (
    <ul className="space-y-1.5">
      {groups.map((g, i) => (
        <FileGroupCard
          key={g.file}
          group={g}
          reviewId={reviewId}
          defaultOpen={i < initiallyOpen}
        />
      ))}
    </ul>
  );
}

function FileGroupCard({
  group,
  reviewId,
  defaultOpen,
}: {
  group: FileGroup;
  reviewId: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li className="overflow-hidden rounded-sm border border-border-subtle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
