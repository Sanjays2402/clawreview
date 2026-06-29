'use client';

import { WarningCircle } from '@phosphor-icons/react/dist/ssr';

export default function TrendsError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-6">
      <div className="flex items-start gap-3">
        <WarningCircle size={24} weight="duotone" className="text-rose-500" />
        <div className="flex-1">
          <div className="font-mono text-sm font-medium text-fg">could not load trends</div>
          <div className="mt-1 font-mono text-xs text-fg-muted">{error.message}</div>
          <button
            type="button"
            onClick={reset}
            className="mt-3 rounded-sm border border-border bg-bg-subtle px-3 py-1.5 font-mono text-xs lowercase text-fg-muted hover:bg-bg-muted"
          >
            try again
          </button>
        </div>
      </div>
    </div>
  );
}
