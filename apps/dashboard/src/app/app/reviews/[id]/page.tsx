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
import { FindingsKeyNav } from '@/components/review/findings-key-nav';
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
    <div className="space-y-3">
      <FindingsKeyNav />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[11px] text-fg-muted">
            <Link href={'/app/reviews' as any} className="hover:text-fg">reviews</Link>
            <span className="mx-1 text-fg-subtle">/</span>
            <span>{review.owner}/{review.repo}</span>
          </div>
          <h1 className="mt-0.5 truncate font-mono text-lg font-semibold tracking-tight">
            #{review.prNumber} <span className="text-fg-muted">·</span> {review.owner}/{review.repo}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-fg-muted">
            <StatusPill status={review.status} />
            <span className="text-fg">{review.headSha.slice(0, 8)}</span>
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
            className="inline-flex items-center gap-1 font-mono text-[11px] text-fg-muted hover:text-fg"
          >
            <ArrowSquareOut size={12} weight="bold" />
            view pr
          </a>
        </div>
      </div>

      {review.error ? (
        <div className="rounded-md border border-severity-critical/40 bg-severity-critical/5 px-2 py-1.5 font-mono text-xs text-severity-critical">
          <span className="font-medium">review failed.</span> {review.error}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">severity</div>
          </CardHeader>
          <CardBody>
            <SeverityRow counts={sevCounts} total={review.findings.length} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">exports</div>
          </CardHeader>
          <CardBody>
            <div className="flex flex-col gap-0.5 font-mono text-xs">
              <ExportLink href={reviewReportUrl(review.id)} icon={<FileText size={13} weight="bold" />} label="report.md" />
              <ExportLink href={reviewSarifUrl(review.id)} icon={<Code size={13} weight="bold" />} label="sarif (open)" />
              <ExportLink href={reviewCsvUrl(review.id)} icon={<FileCsv size={13} weight="bold" />} label="findings.csv" />
              <ExportLink href={reviewJUnitUrl(review.id)} icon={<DownloadSimple size={13} weight="bold" />} label="junit (open)" />
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">agents</div>
          <div className="font-mono text-[11px] tabular-nums text-fg-muted">{review.agentExecutions.length} runs</div>
        </CardHeader>
        <CardBody>
          {review.agentExecutions.length === 0 ? (
            <div className="font-mono text-xs text-fg-subtle">no runs.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] font-mono text-xs">
                <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                  <tr>
                    <th className="py-1 font-medium">agent</th>
                    <th className="font-medium">status</th>
                    <th className="font-medium">findings</th>
                    <th className="font-medium">duration</th>
                    <th className="font-medium">error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {review.agentExecutions.map((ex) => (
                    <tr key={ex.agent}>
                      <td className="py-1 font-medium text-fg">{ex.agent}</td>
                      <td>
                        <StatusPill status={ex.status === 'ok' ? 'completed' : ex.status === 'error' ? 'failed' : 'queued'} />
                      </td>
                      <td className="tabular-nums text-fg-muted">{ex.findings}</td>
                      <td className="tabular-nums text-fg-muted">{formatMs(ex.durationMs)}</td>
                      <td className="text-fg-muted">{ex.error ?? ''}</td>
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
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">findings</span>
            <span className="font-mono text-[11px] tabular-nums text-fg-muted">{visible.length}/{review.findings.length}</span>
            <Link
              href={`/app/reviews/${review.id}/findings` as any}
              className="font-mono text-[11px] text-fg-muted hover:text-fg hover:underline"
            >
              open filtered view
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
            <FilterLink id={review.id} sp={sp} key1="show" value="all" label="+dismissed" active={showDismissed} />
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
        </CardHeader>
        <CardBody>
          {visible.length === 0 ? (
            <EmptyState
              icon={<FileText size={20} weight="duotone" />}
              title={review.findings.length === 0 ? 'no findings' : 'no matches'}
              description={
                review.findings.length === 0
                  ? 'agents finished clean.'
                  : 'loosen the filters above.'
              }
            />
          ) : (
            <ul className="divide-y divide-border-subtle/60 rounded-sm border border-border-subtle">
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
      className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-fg-muted hover:bg-bg-subtle hover:text-fg"
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
      className={`rounded-sm border px-1.5 py-0.5 lowercase transition-colors ${
        active
          ? 'border-accent/60 bg-accent/20 text-fg'
          : 'border-border bg-bg-subtle/40 text-fg-muted hover:bg-bg-muted hover:text-fg'
      }`}
    >
      {label}
      {typeof count === 'number' ? <span className="ml-1 tabular-nums text-[10px] opacity-70">{count}</span> : null}
    </Link>
  );
}
