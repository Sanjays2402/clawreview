import Link from 'next/link';

import { ThemeToggle } from './theme-toggle';

export function TopNav() {
  return (
    <header className="sticky top-0 z-30 border-b border-border-subtle bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-10 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-1.5">
          <Logo />
          <span className="font-mono text-[12px] font-semibold tracking-tight">clawreview</span>
        </Link>
        <nav className="hidden items-center gap-1 font-mono text-xs text-fg-muted md:flex">
          <Link href={'/docs' as any} className="rounded px-2 py-1 lowercase hover:bg-bg-subtle hover:text-fg">docs</Link>
          <Link href={'/changelog' as any} className="rounded px-2 py-1 lowercase hover:bg-bg-subtle hover:text-fg">changelog</Link>
          <Link href={'/shortcuts' as any} className="rounded px-2 py-1 lowercase hover:bg-bg-subtle hover:text-fg">shortcuts</Link>
          <Link href={'/app' as any} className="rounded px-2 py-1 lowercase hover:bg-bg-subtle hover:text-fg">dashboard</Link>
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link
            href={'/login' as any}
            className="inline-flex h-7 items-center rounded bg-fg px-2.5 font-mono text-[11px] font-medium text-bg hover:bg-fg/90"
          >
            sign in
          </Link>
        </div>
      </div>
    </header>
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
