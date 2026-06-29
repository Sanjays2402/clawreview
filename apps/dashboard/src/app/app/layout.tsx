import Link from 'next/link';
import type { ReactNode } from 'react';

import { Footer } from '@/components/footer';
import { CommandPalette, type RecentReviewEntry } from '@/components/command-palette';
import { GlobalNav } from '@/components/global-nav';
import { ShortcutsOverlay } from '@/components/shortcuts-overlay';
import { Toaster } from '@/components/ui/toaster';
import { Tooltip } from '@/components/ui/tooltip';
import { getRecentReviews } from '@/lib/data';

const NAV: Array<{ href: string; label: string }> = [
  { href: '/app', label: 'overview' },
  { href: '/app/reviews', label: 'reviews' },
  { href: '/app/repos', label: 'repos' },
  { href: '/app/installations', label: 'installations' },
  { href: '/app/trends', label: 'trends' },
  { href: '/app/sla', label: 'sla' },
  { href: '/app/budget', label: 'budget' },
  { href: '/app/audit', label: 'audit' },
  { href: '/app/config', label: 'config' },
  { href: '/app/integrations', label: 'integrations' },
  { href: '/app/team', label: 'team' },
  { href: '/app/api-keys', label: 'keys' },
  { href: '/app/settings', label: 'settings' },
];

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Recent reviews power the command palette's "jump to review" entries.
  // Reads are best-effort (data layer returns [] on failure) so the chrome
  // never errors if the API is briefly unreachable.
  const recent = await getRecentReviews(12);
  const recentReviews: RecentReviewEntry[] = recent.map((r) => ({
    id: r.id,
    owner: r.owner,
    repo: r.repo,
    prNumber: r.prNumber,
    status: r.status,
  }));

  // Failed reviews in the recent set get a quiet count badge on the top-nav
  // "reviews" link, so the operator sees there's something to triage without
  // opening the page first -- the overview's "needs attention" idiom carried
  // into the persistent chrome. Running reviews are transient/expected, so only
  // failed (the genuinely actionable state) drives the badge. Hidden at zero.
  const failedCount = recentReviews.filter((r) => r.status === 'failed').length;
  // Running reviews are transient and expected, so they don't warrant the
  // alarm-tinted count. A quiet pulsing accent dot signals "work in flight" so
  // the chrome reads live. It coexists with the failed badge: when both states
  // are present the badge keeps the deep-link + count (the actionable state)
  // and the dot rides alongside, dimmed, like the overview's "needs attention"
  // union -- so a mixed fleet shows triage AND activity at once. Hidden at zero.
  const runningCount = recentReviews.filter((r) => r.status === 'running').length;
  const showRunningDot = runningCount > 0;
  // The failed badge + running dot are visual-only chrome. Mirror them into a
  // single polite aria-live status so a screen reader hears the fleet state on
  // navigation instead of parsing a count glyph + a pulsing dot. Quiet (empty)
  // when nothing needs attention so it never speaks noise.
  const fleetStatus = [
    failedCount > 0 ? `${failedCount} failed review${failedCount === 1 ? '' : 's'}` : '',
    runningCount > 0 ? `${runningCount} running` : '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border-subtle bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-10 max-w-[1400px] items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-4">
            <Link href="/app" className="flex items-center gap-1.5">
              <Logo />
              <span className="font-mono text-[12px] font-semibold tracking-tight">clawreview</span>
            </Link>
            <nav className="flex min-w-0 items-center gap-px overflow-x-auto text-xs text-fg-muted">
              {NAV.map((n) => {
                // The reviews link, when failures exist, deep-links straight to
                // the failed filter + carries a quiet count badge so the
                // actionable state is one click away from anywhere in the app.
                const showBadge = n.href === '/app/reviews' && failedCount > 0;
                const showRunning = n.href === '/app/reviews' && showRunningDot;
                // Failed (actionable) wins the deep-link; running falls back to
                // its own filter only when nothing has failed.
                const reviewsHref = showBadge
                  ? '/app/reviews?status=failed'
                  : showRunning
                    ? '/app/reviews?status=running'
                    : n.href;
                return (
                  <Link
                    key={n.href}
                    href={(n.href === '/app/reviews' ? reviewsHref : n.href) as any}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 font-mono lowercase hover:bg-bg-subtle hover:text-fg"
                  >
                    {n.label}
                    {showBadge ? (
                      <span
                        className="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-severity-critical/20 px-1 text-[9px] font-medium tabular-nums text-severity-critical"
                        title={`${failedCount} failed review${failedCount === 1 ? '' : 's'} need attention`}
                      >
                        {failedCount > 99 ? '99+' : failedCount}
                      </span>
                    ) : null}
                    {/* When failures exist the dot rides alongside the badge,
                        dimmed, so a mixed fleet shows triage + activity at once;
                        when nothing failed it stands alone at full accent. With
                        2+ running, a tiny inline count rides beside the dot at
                        md+ so a busy fleet's depth reads without hovering -- but
                        only when the dot stands alone (no failed badge) so the
                        chrome never stacks two numbers; the count stays single,
                        hidden below md to keep the nav tight on mobile. */}
                    {showRunning ? (
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={`${runningCount} review${runningCount === 1 ? '' : 's'} running`}
                      >
                        <span
                          className={`inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-accent ${showBadge ? 'opacity-50' : ''}`}
                          aria-hidden
                        />
                        {!showBadge && runningCount > 1 ? (
                          <span className="hidden text-[9px] tabular-nums text-accent md:inline">
                            {runningCount > 99 ? '99+' : runningCount}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            {/* Polite live region voicing the failed badge + running dot for
                screen readers; sr-only, empty when the fleet is idle. */}
            <span className="sr-only" role="status" aria-live="polite">
              {fleetStatus ? `${fleetStatus} across recent reviews` : ''}
            </span>
            <Tooltip label="open command palette" placement="bottom">
              <button
                type="button"
                data-cmdk-trigger
                className="hidden items-center gap-1.5 rounded border border-border bg-bg-subtle px-2 py-1 font-mono text-[11px] text-fg-muted hover:bg-bg-muted md:inline-flex"
                aria-label="Open command palette"
              >
                <span>search</span>
                <kbd className="rounded-sm border border-border px-1 text-[10px]">⌘K</kbd>
              </button>
            </Tooltip>
            <span className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[11px]">sanjay</span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-5">{children}</main>
      <Footer />
      <CommandPalette recentReviews={recentReviews} />
      <GlobalNav />
      <ShortcutsOverlay />
      <Toaster />
    </div>
  );
}

function Logo() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="text-accent">
      <path d="M4 7c2-3 6-4 9-3 3 1 5 4 5 7 0 4-3 7-7 7-2 0-4-1-5-2" />
      <path d="m8 13 3 3 5-6" />
    </svg>
  );
}
