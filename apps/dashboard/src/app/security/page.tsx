import { TopNav } from '@/components/top-nav';
import { Footer } from '@/components/footer';

export default function SecurityPage() {
  return (
    <main>
      <TopNav />
      <article className="mx-auto max-w-3xl px-6 py-16 text-fg">
        <h1 className="text-3xl font-semibold tracking-tight">Security</h1>
        <p className="mt-4 text-fg-muted">
          Report vulnerabilities to security@clawreview.dev. We acknowledge within two business days,
          triage within five, and coordinate disclosure for high severity issues within 30 days.
        </p>
        <p className="mt-2 text-fg-muted">
          Webhook signatures are verified before any work is queued. Secrets never leave the worker
          process. Audit log entries are append-only at the application layer.
        </p>
      </article>
      <Footer />
    </main>
  );
}
