import type { Finding, Severity } from '@clawreview/types';
import { SEVERITY_LABELS } from '@clawreview/types';

import type { AggregateResult } from './aggregate.js';

const SEV_EMOJI: Record<Severity, string> = {
  critical: '🛑',
  high: '🔺',
  medium: '🟠',
  low: '🟡',
  nit: '🔹',
};

export interface CommentRunSummary {
  /** Total review wall-clock time in milliseconds. */
  durationMs?: number;
  /** Total estimated LLM cost in USD. */
  totalCostUsd?: number;
  /** Per-agent timings/findings for the breakdown table. */
  agentExecutions?: Array<{
    agent: string;
    status?: 'ok' | 'error' | 'skipped';
    durationMs: number;
    findings: number;
    error?: string;
  }>;
  /** Files skipped during selection (binary, oversize, generated, ...). */
  skippedCount?: number;
}

export interface CommentOptions {
  prNumber: number;
  headSha: string;
  runId?: string;
  style?: 'compact' | 'detailed';
  dashboardUrl?: string;
  /**
   * Optional summary of the review run. When supplied, renders a "Run summary"
   * footer block (timings, cost, skipped count, per-agent breakdown) below
   * the findings. Designed to be cheap for reviewers to skim without scrolling.
   */
  runSummary?: CommentRunSummary;
}

export function renderPrComment(result: AggregateResult, opts: CommentOptions): string {
  const totals = result.totals;
  const total = Object.values(totals).reduce((a, b) => a + b, 0);

  if (total === 0) {
    return [
      '### ClawReview',
      '',
      'No findings above the configured severity threshold. Nice diff.',
      ...renderRunSummaryBlock(opts.runSummary),
      '',
      footer(opts),
    ].join('\n');
  }

  const summary = (['critical', 'high', 'medium', 'low', 'nit'] as Severity[])
    .filter((s) => totals[s] > 0)
    .map((s) => `${SEV_EMOJI[s]} ${totals[s]} ${SEVERITY_LABELS[s]}`)
    .join(' · ');

  const categoryEntries = Object.entries(result.categoryTotals)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const categoryLine =
    categoryEntries.length > 0
      ? categoryEntries.map(([cat, n]) => `\`${cat}\` ${n}`).join(' · ')
      : '';

  const body: string[] = ['### ClawReview', '', summary];
  if (categoryLine) {
    body.push('', categoryLine);
  }
  body.push('');

  for (const group of result.groupedByFile) {
    body.push(`<details><summary><code>${escapeMd(group.file)}</code> (${group.findings.length})</summary>`);
    body.push('');
    for (const f of group.findings) {
      body.push(renderFinding(f, opts));
    }
    body.push('</details>');
    body.push('');
  }

  body.push(...renderRunSummaryBlock(opts.runSummary));
  body.push(footer(opts));
  return body.join('\n');
}

function renderRunSummaryBlock(rs: CommentRunSummary | undefined): string[] {
  if (!rs) return [];
  const lines: string[] = [];
  // The header is collapsed by default so the comment scans cleanly even
  // when the run produced a lot of agent executions.
  lines.push('<details><summary>Run summary</summary>');
  lines.push('');
  const meta: string[] = [];
  if (typeof rs.durationMs === 'number') {
    meta.push(`Duration: ${formatDuration(rs.durationMs)}`);
  }
  if (typeof rs.totalCostUsd === 'number') {
    meta.push(`Cost: $${rs.totalCostUsd.toFixed(4)}`);
  }
  if (typeof rs.skippedCount === 'number' && rs.skippedCount > 0) {
    meta.push(`Skipped files: ${rs.skippedCount}`);
  }
  if (meta.length > 0) {
    lines.push(meta.join(' · '));
    lines.push('');
  }

  const execs = rs.agentExecutions ?? [];
  if (execs.length > 0) {
    lines.push('| Agent | Status | Findings | Duration |');
    lines.push('|---|---|---|---|');
    for (const e of execs) {
      const status = e.status === 'error'
        ? `error${e.error ? `: ${truncate(e.error, 60)}` : ''}`
        : (e.status ?? 'ok');
      lines.push(
        `| \`${escapeMd(e.agent)}\` | ${status} | ${e.findings} | ${formatDuration(e.durationMs)} |`,
      );
    }
    lines.push('');
  }

  lines.push('</details>');
  lines.push('');
  return lines;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function renderFinding(f: Finding, _opts: CommentOptions): string {
  const lines = [
    `**${SEV_EMOJI[f.severity]} ${SEVERITY_LABELS[f.severity]} · ${f.category} · ${f.agent}**`,
    `\`${escapeMd(f.file)}:${f.startLine}${f.endLine ? `-${f.endLine}` : ''}\``,
    '',
    f.title,
    '',
    f.rationale,
  ];
  if (f.cwe) lines.push('', `Reference: ${f.cwe}`);
  if (f.suggested) {
    lines.push('', `_Suggested change: ${f.suggested.description}_`, '```diff', f.suggested.diff, '```');
  }
  lines.push('');
  return lines.join('\n');
}

function footer(opts: CommentOptions): string {
  const dashboard = opts.dashboardUrl
    ? ` · [Open in dashboard](${opts.dashboardUrl})`
    : '';
  return `<sub>ClawReview · PR #${opts.prNumber} · ${opts.headSha.slice(0, 7)}${dashboard}</sub>`;
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}\[\]()#+\-.!])/g, '\\$1');
}
