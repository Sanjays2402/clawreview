import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t border-border-subtle/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 md:flex-row md:items-center md:justify-between">
        <div className="text-sm text-fg-muted">
          ClawReview · MIT licensed · built for repos you actually own.
        </div>
        <nav className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-fg-muted">
          <Link href={'/docs' as any} className="hover:text-fg">Docs</Link>
          <Link href={'/changelog' as any} className="hover:text-fg">Changelog</Link>
          <a href="https://github.com/Sanjays2402/clawreview" className="hover:text-fg" target="_blank" rel="noreferrer">GitHub</a>
          <Link href={'/security' as any} className="hover:text-fg">Security</Link>
          <Link href={'/privacy' as any} className="hover:text-fg">Privacy</Link>
        </nav>
      </div>
    </footer>
  );
}
