import Link from 'next/link';

import { ThemeToggle } from './theme-toggle';

export function TopNav() {
  return (
    <header className="sticky top-0 z-30 border-b border-border-subtle/60 bg-bg/75 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2">
          <Logo />
          <span className="text-sm font-semibold tracking-tight">ClawReview</span>
        </Link>
        <nav className="hidden items-center gap-1 text-sm text-fg-muted md:flex">
          <Link href={'/docs' as any} className="rounded-md px-3 py-1.5 hover:bg-bg-subtle">Docs</Link>
          <Link href={'/changelog' as any} className="rounded-md px-3 py-1.5 hover:bg-bg-subtle">Changelog</Link>
          <Link href={'/app' as any} className="rounded-md px-3 py-1.5 hover:bg-bg-subtle">Dashboard</Link>
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link
            href={'/login' as any}
            className="inline-flex h-9 items-center rounded-lg bg-fg px-3 text-xs font-medium text-bg transition-colors hover:bg-fg/90"
          >
            Sign in
          </Link>
        </div>
      </div>
    </header>
  );
}

function Logo() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M4 7c2-3 6-4 9-3 3 1 5 4 5 7 0 4-3 7-7 7-2 0-4-1-5-2" opacity={0.4} />
      <path d="M4 7c2-3 6-4 9-3 3 1 5 4 5 7 0 4-3 7-7 7-2 0-4-1-5-2" />
      <path d="m8 13 3 3 5-6" />
    </svg>
  );
}
