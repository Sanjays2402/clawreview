import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t border-border-subtle/60">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-5 font-mono text-[11px] text-fg-muted md:flex-row md:items-center md:justify-between">
        <div>clawreview · mit · build for repos you own.</div>
        <nav className="flex flex-wrap gap-x-4 gap-y-1">
          <Link href={'/docs' as any} className="hover:text-fg">docs</Link>
          <Link href={'/changelog' as any} className="hover:text-fg">changelog</Link>
          <Link href={'/shortcuts' as any} className="hover:text-fg">shortcuts</Link>
          <a href="https://github.com/Sanjays2402/clawreview" className="hover:text-fg" target="_blank" rel="noreferrer">github</a>
          <Link href={'/security' as any} className="hover:text-fg">security</Link>
          <Link href={'/privacy' as any} className="hover:text-fg">privacy</Link>
        </nav>
      </div>
    </footer>
  );
}
