import Link from 'next/link';
import type { ReactNode } from 'react';

export interface EmptyStateCta {
  label: string;
  href: string;
  /** Optional leading glyph. */
  icon?: ReactNode;
  /** External links open in a new tab + get rel=noreferrer. */
  external?: boolean;
}

export interface EmptyStateActionsProps {
  /** Filled accent button — the one thing you most likely want to do. */
  primary?: EmptyStateCta;
  /** Outlined button — the secondary escape hatch (docs, clear filters). */
  secondary?: EmptyStateCta;
}

/**
 * A primary + secondary call-to-action pair for the `action` slot of the
 * shared `EmptyState`. Turns a dead-end empty card into a next step:
 * "configure github app" / "view docs", "clear filters", etc.
 *
 * Internal hrefs render as Next `<Link>`s (client nav, prefetch); external
 * ones render as plain anchors opening in a new tab. Buttons match the
 * dashboard's dense lowercase / mono control language rather than the
 * heavier `@clawreview/ui` Button so they sit naturally inside an empty card.
 */
export function EmptyStateActions({ primary, secondary }: EmptyStateActionsProps) {
  if (!primary && !secondary) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {primary ? <Cta cta={primary} variant="primary" /> : null}
      {secondary ? <Cta cta={secondary} variant="secondary" /> : null}
    </div>
  );
}

function Cta({ cta, variant }: { cta: EmptyStateCta; variant: 'primary' | 'secondary' }) {
  const cls =
    variant === 'primary'
      ? 'border border-accent/50 bg-accent/15 text-fg hover:border-accent/70 hover:bg-accent/25'
      : 'border border-border bg-bg-subtle/60 text-fg-muted hover:bg-bg-muted hover:text-fg';
  const className = `inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 font-mono text-[11px] lowercase transition-colors ${cls}`;
  const inner = (
    <>
      {cta.icon ? <span className="shrink-0">{cta.icon}</span> : null}
      <span>{cta.label}</span>
    </>
  );
  if (cta.external) {
    return (
      <a href={cta.href} target="_blank" rel="noreferrer" className={className}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={cta.href as never} className={className}>
      {inner}
    </Link>
  );
}
