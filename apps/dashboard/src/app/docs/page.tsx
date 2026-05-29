import { TopNav } from '@/components/top-nav';
import { Footer } from '@/components/footer';

export default function DocsPage() {
  return (
    <main>
      <TopNav />
      <article className="prose mx-auto max-w-3xl px-6 py-16 text-fg">
        <h1 className="text-3xl font-semibold tracking-tight">Docs</h1>
        <p className="mt-4 text-fg-muted">
          The fastest way in is the local CLI. The same pipeline that runs in production
          runs against any git diff on your laptop, no GitHub App required.
        </p>

        <h2 className="mt-10 text-xl font-semibold">Quick start</h2>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-bg-subtle p-4 text-xs">
{`pnpm install
pnpm cli -- run --base main --head HEAD`}
        </pre>

        <h2 className="mt-10 text-xl font-semibold">Per-repo config</h2>
        <p className="mt-2 text-fg-muted">
          Drop a <code>.clawreview.yml</code> at the root of any installed repo:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-bg-subtle p-4 text-xs">
{`agents:
  - security
  - performance
  - style
  - secrets
severity_threshold: medium
ignore:
  - "**/*.snap"
  - "**/vendor/**"
budget:
  monthly_usd: 25`}
        </pre>

        <h2 className="mt-10 text-xl font-semibold">Self-host</h2>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-bg-subtle p-4 text-xs">
{`docker compose -f infra/docker/docker-compose.dev.yml up -d
pnpm db:push
pnpm server
pnpm dashboard`}
        </pre>
      </article>
      <Footer />
    </main>
  );
}
