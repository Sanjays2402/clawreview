// Mono uppercase status pill. Colored text + thin border. No fills.
export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'completed' || status === 'resolved'
      ? 'text-emerald-400 border-emerald-500/40'
      : status === 'failed'
        ? 'text-severity-critical border-severity-critical/40'
        : status === 'running'
          ? 'text-accent border-accent/40'
          : status === 'queued'
            ? 'text-severity-medium border-severity-medium/40'
            : status === 'dismissed'
              ? 'text-fg-subtle border-border'
              : status === 'open'
                ? 'text-severity-low border-severity-low/40'
                : 'text-fg-muted border-border';
  return (
    <span className={`pill-mono ${tone}`}>{status.toUpperCase()}</span>
  );
}
