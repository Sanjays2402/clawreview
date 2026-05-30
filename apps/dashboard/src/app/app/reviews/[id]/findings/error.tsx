'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm">
      <div className="font-semibold text-fg">Could not load findings</div>
      <div className="mt-1 text-fg-muted">{error.message}</div>
      <button onClick={reset} className="mt-3 rounded-md border border-border bg-bg-subtle px-3 py-1 text-xs">
        Try again
      </button>
    </div>
  );
}
