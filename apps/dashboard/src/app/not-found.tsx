import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-6">
      <div className="text-center">
        <div className="text-xs uppercase tracking-wide text-fg-subtle">404</div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">We could not find that page</h1>
        <p className="mt-2 text-sm text-fg-muted">Check the URL or head back to the start.</p>
        <Link href="/" className="mt-6 inline-flex h-9 items-center rounded-lg bg-fg px-4 text-xs font-medium text-bg">Go home</Link>
      </div>
    </main>
  );
}
