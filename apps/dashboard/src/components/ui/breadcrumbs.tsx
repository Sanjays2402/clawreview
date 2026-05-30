import Link from 'next/link';
export function Breadcrumbs({ items }: { items: Array<{ href?: string; label: string }> }) {
  return (
    <nav className="font-mono text-[11px] text-fg-muted">
      {items.map((item, i) => (
        <span key={i}>
          {i > 0 ? <span className="mx-1 text-fg-subtle">/</span> : null}
          {item.href ? <Link href={item.href as any} className="hover:text-fg">{item.label}</Link> : <span>{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}
