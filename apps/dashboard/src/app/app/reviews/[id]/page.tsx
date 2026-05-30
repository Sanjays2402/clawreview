import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowSquareOut,
  DownloadSimple,
  FileText,
  Code,
  FileCsv,
} from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { FindingRow } from '@/components/review/finding-row';
import { RerunForm } from '@/components/review/rerun-form';
import { SeverityRow } from '@/components/review/severity-row';
import { StatusPill } from '@/components/review/status-pill';
import {
  getReview,
  reviewCsvUrl,
  reviewJUnitUrl,
  reviewReportUrl,
  reviewSarifUrl,
  type Severity,
} from '@/lib/data';
import { formatMs, formatRelative, formatUsd } from '@/lib/format';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ show?: string; severity?: string; agent?: string }>;
}

export default async function ReviewDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  if (!id) notFound();
  const review = await getReview(id);
  if (!review) notFound();

  const showDismissed = sp.show === 'all';
  const severityFilter = sp.severity as Severity | undefined;
  const agentFilter = sp.agent;

  const visible = review.findings.filter((f) => {
    if (!showDismissed && f.state === 'dismissed') return false;
    if (severityFilter && f.severity !== severityFilter) return false;
    if (agentFilter && f.agent !== agentFilter) return false;
    return true;
  });

  const sevCounts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, nit: 0 };
  for (const f of review.findings) sevCounts[f.severity] += 1;
  const agents = Array.from(new Set(review.findings.map((f) => f.agent))).sort();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs text-fg-muted">
            <Link href={'/app/reviews' as any} className="hover:text-fg">Reviews</Link>
            <span className="mx-1.5 text-fg-subtle">/</span>
            <span>{review.owner}/{review.repo}</span>
          </div>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">
            #{review.prNumber} <span className="text-fg-muted">on</span> {review.owner}/{review.repo}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <StatusPill status={review.status} />
            <span className="font-mono">{review.headSha.slice(0, 8)}</span>
            <span>·</span>
            <span>started {formatRelative(review.createdAt)}</span>
            {review.completedAt ? (
              <>
                <span>·</span>
                <span>completed {formatRelative(review.completedAt)}</span>
              </>
            ) : null}
            <span>·</span>
            <span>{formatMs(review.durationMs)}</span>
            <span>·</span>
            <span>{formatUsd(review.totalCostUsd)}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-3">
          <RerunForm review={review} />
          <a
            href={`https://github.com/${review.owner}/${review.repo}/pull/${review.prNumber}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
          >
            <ArrowSquareOut size={14} weight="duotone" />
            View pull request
          </a>
        </div>
      </div>

      {review.error ? (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          <span className="font-medium">Review failed.</span> {review.error}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="text-sm font-medium">Severity</div>
          </CardHeader>
          <CardBody>
            <SeverityRow counts={sevCounts} total={review.findings.length} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-medium">Exports</div>
          </CardHeader>
          <CardBody>
            <div className="flex flex-col gap-1.5 text-sm">
              <ExportLink href={reviewReportUrl(review.id)} icon={<FileText size={16} weight="duotone" />} label="Report (Markdown)" />
              <ExportLink href={reviewSarifUrl(review.id)} icon={<Code size={16} weight="duotone" />} label="SARIF (open findings)" />
              <ExportLink href={reviewCsvUrl(review.id)} icon={<FileCsv size={16} weight="duotone" />} label="Findings (CSV)" />
              <ExportLink href={reviewJUnitUrl(review.id)} icon={<DownloadSimple size={16} weight="duotone" />} label="JUnit (open findings)" />
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Agents</div>
            <div className="text-xs text-fg-muted">{review.agentExecutions.length} runs</div>
          </div>
        </CardHeader>
        <CardBody>
          {review.agentExecutions.length === 0 ? (
            <div className="text-xs text-fg-subtle">No agent runs recorded.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="py-2 font-medium">Agent</th>
                    <th className="font-medium">Status</th>
                    <th className="font-medium">Findings</th>
                    <th className="font-medium">Duration</th>
                    <th className="font-medium">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {review.agentExecutions.map((ex) => (
                    <tr key={ex.agent}>
                      <td className="py-2 font-medium text-fg">{ex.agent}</td>
                      <td>
                        <StatusPill status={ex.status === 'ok' ? 'completed' : ex.status === 'error' ? 'failed' : 'queued'} />
                      </td>
                      <td className="text-fg-muted">{ex.findings}</td>
                      <td className="text-fg-muted">{formatMs(ex.durationMs)}</td>
                      <td className="text-xs text-fg-muted">{ex.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm font-medium">
              <span>Findings <span className="text-fg-muted">({visible.length} of {review.findings.length})</span></span>
              <Link
                href={`/app/reviews/${review.id}/findings` as any}
                className="text-xs font-normal text-fg-muted hover:text-fg hover:underline"
              >
                Open filtered view
              </Link>
            </div>
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <FilterLink id={review.id} sp={sp} key1="show" value="all" label="Show dismissed" active={showDismissed} />
              {(['critical', 'high', 'medium', 'low', 'nit'] as const).map((sev) => (
                <FilterLink
                  key={sev}
                  id={review.id}
                  sp={sp}
                  key1="severity"
                  value={sev}
                  label={sev}
                  active={severityFilter === sev}
                  count={sevCounts[sev]}
                />
              ))}
              {agents.map((a) => (
                <FilterLink
                  key={a}
                  id={review.id}
                  sp={sp}
                  key1="agent"
                  value={a}
                  label={a}
                  active={agentFilter === a}
                />
              ))}
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {visible.length === 0 ? (
            <EmptyState
              icon={<FileText size={28} weight="duotone" />}
              title={review.findings.length === 0 ? 'No findings' : 'No findings match'}
              description={
                review.findings.length === 0
                  ? 'The agents finished without flagging anything in this diff.'
                  : 'Adjust the filters above to see more findings.'
              }
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {visible.map((f) => (
                <FindingRow key={f.id} finding={f} reviewId={review.id} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function ExportLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-fg-muted hover:bg-bg-subtle hover:text-fg"
    >
      {icon}
      <span>{label}</span>
    </a>
  );
}

function FilterLink({
  id,
  sp,
  key1,
  value,
  label,
  active,
  count,
}: {
  id: string;
  sp: { show?: string; severity?: string; agent?: string };
  key1: 'show' | 'severity' | 'agent';
  value: string;
  label: string;
  active: boolean;
  count?: number;
}) {
  const next = { ...sp };
  if (active) delete next[key1];
  else next[key1] = value;
  const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v) as [string, string][]).toString();
  const href = `/app/reviews/${id}${qs ? `?${qs}` : ''}`;
  return (
    <Link
      href={href as any}
      className={`rounded-md border px-2 py-0.5 capitalize transition-colors ${
        active
          ? 'border-fg bg-fg text-bg'
          : 'border-border bg-bg-subtle text-fg-muted hover:bg-bg-muted'
      }`}
    >
      {label}
      {typeof count === 'number' ? <span className="ml-1 text-[10px] opacity-70">{count}</span> : null}
    </Link>
  );
}
