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

export interface CommentOptions {
  prNumber: number;
  headSha: string;
  runId?: string;
  style?: 'compact' | 'detailed';
  dashboardUrl?: string;
}

export function renderPrComment(result: AggregateResult, opts: CommentOptions): string {
  const totals = result.totals;
  const total = Object.values(totals).reduce((a, b) => a + b, 0);

  if (total === 0) {
    return [
      '### ClawReview',
      '',
      'No findings above the configured severity threshold. Nice diff.',
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

  body.push(footer(opts));
  return body.join('\n');
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
