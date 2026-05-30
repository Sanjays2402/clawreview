import Link from 'next/link';
import type { ReactNode } from 'react';

import { Footer } from '@/components/footer';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border-subtle bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <Link href="/app" className="text-sm font-semibold tracking-tight">ClawReview</Link>
            <nav className="flex flex-wrap items-center gap-1 text-sm text-fg-muted">
              <Link href={'/app' as any} className="rounded-md px-3 py-1.5 hover:bg-bg-subtle">Overview</Link>
              <Link href={'/app/installations' as any} className="rounded-md px-3 py-1.5 hover:bg-bg-subtle">Installations</Link>
              <Link href={'/app/repos' as any} className="rounded-md px-3 py-1.5 hover:bg-bg-subtle">Repos</Link>
              <Link href={'/app/reviews' as any} className="rounded-md px-3 py-1.5 hover:bg-bg-subtle">Reviews</Link>
              <Link href={'/app/budget' as any} className="rounded-md px-3 py-1.5 hover:bg-bg-subtle">Budget</Link>
              <Link href={'/app/audit' as any} className="rounded-md px-3 py-1.5 hover:bg-bg-subtle">Audit log</Link>
              <Link href={'/app/settings' as any} className="rounded-md px-3 py-1.5 hover:bg-bg-subtle">Settings</Link>
            </nav>
          </div>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span className="hidden md:inline">Signed in as</span>
            <span className="rounded-md border border-border bg-bg-subtle px-2 py-1">sanjay</span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      <Footer />
    </div>
  );
}
