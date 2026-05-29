import { TopNav } from '@/components/top-nav';
import { Footer } from '@/components/footer';

export default function ChangelogPage() {
  return (
    <main>
      <TopNav />
      <article className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Changelog</h1>
        <ol className="mt-8 space-y-8">
          <li>
            <div className="text-xs uppercase tracking-wide text-fg-subtle">Unreleased</div>
            <h2 className="text-lg font-semibold">Initial public scaffold</h2>
            <p className="mt-1 text-sm text-fg-muted">
              Monorepo, server, dashboard, CLI, six reviewer agents, aggregator, Docker stack, and Helm chart.
            </p>
          </li>
        </ol>
      </article>
      <Footer />
    </main>
  );
}
