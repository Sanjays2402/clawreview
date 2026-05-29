import { notFound } from 'next/navigation';

import { Card, CardBody, CardHeader, SeverityBadge } from '@clawreview/ui';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ReviewDetailPage({ params }: PageProps) {
  const { id } = await params;
  if (!id) notFound();

  // Real data would be loaded from /api/reviews/:id; we render the structure
  // so the contract is firm and Playwright has stable selectors.
  const review = {
    id,
    repo: 'sanjay/clawreview',
    prNumber: 142,
    title: 'feat: add per-repo budget guard',
    status: 'completed',
    findings: [
      { id: 'f1', agent: 'security', file: 'src/auth.ts', line: 42, severity: 'high' as const, title: 'Token compared with ==', rationale: 'Use timingSafeEqual to avoid leaking the secret through latency.' },
      { id: 'f2', agent: 'performance', file: 'src/users.ts', line: 87, severity: 'medium' as const, title: 'N+1 query inside getUsersWithRoles', rationale: 'Batch with a single join or DataLoader.' },
      { id: 'f3', agent: 'style', file: 'src/utils.ts', line: 12, severity: 'low' as const, title: 'Unused parameter `_ctx`', rationale: 'Drop the parameter or rename to `_`.' },
    ],
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-fg-muted">{review.repo}</div>
        <h1 className="text-2xl font-semibold tracking-tight">PR #{review.prNumber} · {review.title}</h1>
        <p className="mt-1 text-sm text-fg-muted">Status: {review.status} · review id {review.id}</p>
      </div>

      <Card>
        <CardHeader>
          <div className="text-sm font-medium">Findings</div>
        </CardHeader>
        <CardBody>
          <ul className="divide-y divide-border-subtle">
            {review.findings.map((f) => (
              <li key={f.id} className="py-4">
                <div className="flex items-center gap-3">
                  <SeverityBadge severity={f.severity} />
                  <span className="font-mono text-xs text-fg-muted">{f.file}:{f.line}</span>
                  <span className="text-xs text-fg-subtle">{f.agent}</span>
                </div>
                <div className="mt-1 font-medium text-fg">{f.title}</div>
                <div className="mt-1 text-sm text-fg-muted">{f.rationale}</div>
                <div className="mt-2 flex gap-2 text-xs">
                  <button className="rounded-md border border-border bg-bg-subtle px-2 py-1 text-fg-muted hover:bg-bg-muted">Dismiss</button>
                  <button className="rounded-md border border-border bg-bg-subtle px-2 py-1 text-fg-muted hover:bg-bg-muted">Open in editor</button>
                </div>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
