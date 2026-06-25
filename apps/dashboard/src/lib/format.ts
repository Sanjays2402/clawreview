export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}

export function formatMs(ms?: number): string {
  if (!ms || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatRelative(iso?: string): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

export function formatPct(n: number): string {
  return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
}

/**
 * Per-bucket day labels for an oldest-first daily series of length `n`.
 * The final bucket is "today", the one before it "yesterday", and the rest
 * "Nd ago". Shared by the overview + trends sparklines so their hover
 * readouts speak the same language.
 */
export function dayLabels(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (i === 0) out.push('today');
    else if (i === 1) out.push('yesterday');
    else out.push(`${i}d ago`);
  }
  return out;
}
