import type { Finding, Severity } from '@clawreview/types';
import { SEVERITY_LABELS, compareSeverity } from '@clawreview/types';

const SEV_BADGE: Record<Severity, string> = {
  critical: '🛑',
  high: '🔺',
  medium: '🟠',
  low: '🟡',
  nit: '🔹',
};

export interface ReportMetadata {
  reviewId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  totalCostUsd: number;
  agentExecutions: Array<{
    agent: string;
    status: 'ok' | 'error' | 'skipped';
    durationMs: number;
    findings: number;
    error?: string;
  }>;
}

export interface ReportOptions {
  /** Include suggested patches inline. Default true. */
  includeSuggestedPatches?: boolean;
  /** Include dismissed findings in their own section. Default false. */
  includeDismissed?: boolean;
}

export interface ReportFinding extends Finding {
  state?: 'open' | 'dismissed';
  dismissReason?: string;
  autoDismissed?: boolean;
}

/**
 * Render a standalone Markdown report for a review. Unlike renderPrComment
 * this is not anchored to a GitHub PR; it is meant for download, archival,
 * pasting into Slack/Notion, or emailing to a reviewer who is offline.
 */
export function renderReviewReport(
  meta: ReportMetadata,
  findings: ReportFinding[],
  opts: ReportOptions = {},
): string {
  const includePatches = opts.includeSuggestedPatches ?? true;
  const includeDismissed = opts.includeDismissed ?? false;

  const open = findings.filter((f) => (f.state ?? 'open') === 'open');
  const dismissed = findings.filter((f) => f.state === 'dismissed');

  const totals: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    nit: 0,
  };
  for (const f of open) totals[f.severity] += 1;

  const lines: string[] = [];
  lines.push(`# ClawReview report for ${meta.owner}/${meta.repo}#${meta.prNumber}`);
  lines.push('');
  lines.push(`Review \`${meta.reviewId}\` against commit \`${meta.headSha.slice(0, 12)}\`` +
    ` (base \`${meta.baseSha.slice(0, 12)}\`).`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Status | ${meta.status} |`);
  lines.push(`| Created | ${meta.createdAt} |`);
  if (meta.completedAt) lines.push(`| Completed | ${meta.completedAt} |`);
  if (meta.durationMs !== undefined) {
    lines.push(`| Duration | ${Math.round(meta.durationMs / 1000)}s |`);
  }
  lines.push(`| LLM cost | $${meta.totalCostUsd.toFixed(4)} |`);
  lines.push(`| Open findings | ${open.length} |`);
  if (dismissed.length > 0) {
    lines.push(`| Dismissed | ${dismissed.length} |`);
  }
  lines.push('');

  lines.push('## Severity totals');
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|---|---|');
  for (const sev of ['critical', 'high', 'medium', 'low', 'nit'] as Severity[]) {
    lines.push(`| ${SEV_BADGE[sev]} ${SEVERITY_LABELS[sev]} | ${totals[sev]} |`);
  }
  lines.push('');

  if (meta.agentExecutions.length > 0) {
    lines.push('## Agents');
    lines.push('');
    lines.push('| Agent | Status | Duration (ms) | Findings |');
    lines.push('|---|---|---|---|');
    for (const ex of meta.agentExecutions) {
      const status = ex.status === 'error' ? `error: ${ex.error ?? ''}` : ex.status;
      lines.push(`| ${ex.agent} | ${status} | ${ex.durationMs} | ${ex.findings} |`);
    }
    lines.push('');
  }

  if (open.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('No open findings. Nice diff.');
    lines.push('');
  } else {
    lines.push('## Findings');
    lines.push('');
    const grouped = groupByFile(open);
    for (const { file, items } of grouped) {
      lines.push(`### \`${file}\``);
      lines.push('');
      for (const f of items) {
        lines.push(
          `- ${SEV_BADGE[f.severity]} **${SEVERITY_LABELS[f.severity]}** ` +
            `\`${f.agent}\` line ${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ''}: ` +
            `${escapeInline(f.title)}`,
        );
        lines.push(`  ${escapeInline(f.rationale)}`);
        if (f.cwe) lines.push(`  Reference: ${f.cwe}.`);
        if (includePatches && f.suggested) {
          lines.push('  Suggested patch:');
          lines.push('  ```diff');
          for (const patchLine of f.suggested.diff.split('\n')) {
            lines.push(`  ${patchLine}`);
          }
          lines.push('  ```');
        }
      }
      lines.push('');
    }
  }

  if (includeDismissed && dismissed.length > 0) {
    lines.push('## Dismissed findings');
    lines.push('');
    for (const f of dismissed) {
      const tag = f.autoDismissed ? ' (auto)' : '';
      const reason = f.dismissReason ? `: ${escapeInline(f.dismissReason)}` : '';
      lines.push(
        `- ${SEV_BADGE[f.severity]} \`${f.file}\` line ${f.startLine}: ` +
          `${escapeInline(f.title)}${tag}${reason}`,
      );
    }
    lines.push('');
  }

  lines.push('Generated by ClawReview.');
  return lines.join('\n');
}

function groupByFile(findings: Finding[]): Array<{ file: string; items: Finding[] }> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = map.get(f.file) ?? [];
    list.push(f);
    map.set(f.file, list);
  }
  // Sort findings inside each file by severity then line.
  for (const list of map.values()) {
    list.sort((a, b) => {
      const s = compareSeverity(a.severity, b.severity);
      if (s !== 0) return s;
      return a.startLine - b.startLine;
    });
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, items]) => ({ file, items }));
}

function escapeInline(s: string): string {
  // Keep markdown safe-ish: collapse newlines and escape pipe so tables and
  // bullet lines don't break. We deliberately do not over-escape; this is a
  // human-readable report, not raw HTML.
  return s.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}
