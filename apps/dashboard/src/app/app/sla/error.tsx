'use client';

import { WarningCircle } from '@phosphor-icons/react/dist/ssr';

export default function SlaError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-6">
      <div className="flex items-start gap-3">
        <WarningCircle size={24} weight="duotone" className="text-rose-500" />
        <div className="flex-1">
          <div className="text-sm font-medium text-fg">Could not load SLA breaches</div>
          <div className="mt-1 text-xs text-fg-muted">{error.message}</div>
          <button
            type="button"
            onClick={reset}
            className="mt-3 rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-muted"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
