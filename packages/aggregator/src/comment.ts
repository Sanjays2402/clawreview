import type { Finding, Severity } from '@clawreview/types';
import { SEVERITY_LABELS } from '@clawreview/types';

import type { AggregateResult } from './aggregate.js';
import { detectHotspots, renderHotspotLine, type HotspotOptions } from './hotspots.js';
import {
  attributeFindingsToAuthors,
  type AuthorAttribution,
  type BlameMap,
} from './authors.js';

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

/**
 * Optional author attribution block for the PR comment.
 *
 * Two shapes are supported because the worker may either (a) already have
 * computed the breakdown (the dashboard worker has cached blame) or
 * (b) hold a raw blame map and want the renderer to compute it. Either way
 * the renderer emits a compact "Top contributors by severity" list,
 * collapsed inside a <details> so it doesn't dominate the comment.
 *
 * Use `top` to cap the rendered list (default: 3). Authors with zero
 * findings are silently dropped.
 */
export interface CommentAuthorsBlock {
  /** Pre-computed breakdown (sorted worst-first by `attributeFindingsToAuthors`). */
  breakdown?: { authors: AuthorAttribution[]; unknown?: { length: number } };
  /**
   * Raw blame map — when supplied (and `breakdown` is absent) the renderer
   * runs `attributeFindingsToAuthors` against the aggregate's findings.
   */
  blame?: BlameMap;
  /** Cap on rendered author rows. Default: 3. */
  top?: number;
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
  /**
   * Optional hotspot detection. When provided, the renderer inserts a
   * "Hotspots" block between the totals summary and the per-file detail.
   * Pass `false` (or omit) to disable, `true` for defaults, or an options
   * object to tune `windowLines` / `minFindings` / `limit`.
   */
  hotspots?: boolean | HotspotOptions;
  /**
   * Optional author attribution. When supplied (and yields >=1 author),
   * appends a collapsed "Top contributors by severity" block to the
   * comment so reviewers know who likely introduced the noise. Silent
   * no-op when blame is empty or only the unknown bucket has entries.
   */
  authors?: CommentAuthorsBlock;
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
      ...renderAuthorsBlock(result.findings, opts.authors),
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

  if (opts.hotspots) {
    const hotspotOpts: HotspotOptions = opts.hotspots === true ? {} : opts.hotspots;
    const hotspots = detectHotspots(result.findings, hotspotOpts);
    if (hotspots.length > 0) {
      body.push('**Hotspots**');
      body.push('');
      for (const h of hotspots) body.push(`- ${renderHotspotLine(h)}`);
      body.push('');
    }
  }

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
  body.push(...renderAuthorsBlock(result.findings, opts.authors));
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

/**
 * Render the "Top contributors by severity" block.
 *
 * Resolves whichever shape the caller supplied:
 *   - `authors.breakdown` — already computed, used as-is.
 *   - `authors.blame` — raw map; we compute the breakdown here.
 *
 * Returns `[]` (renders nothing) when:
 *   - `authors` is unset
 *   - the resolved breakdown is empty
 *   - only the unknown bucket has entries
 */
function renderAuthorsBlock(
  findings: readonly Finding[],
  authors: CommentAuthorsBlock | undefined,
): string[] {
  if (!authors) return [];

  let authorRows: AuthorAttribution[];
  let unknownCount = 0;
  if (authors.breakdown) {
    authorRows = authors.breakdown.authors;
    unknownCount = authors.breakdown.unknown?.length ?? 0;
  } else if (authors.blame) {
    const computed = attributeFindingsToAuthors([...findings], authors.blame);
    authorRows = computed.authors;
    unknownCount = computed.unknown.length;
  } else {
    return [];
  }

  if (authorRows.length === 0) return [];

  const cap = Math.max(1, authors.top ?? 3);
  const rows = authorRows.slice(0, cap);

  const lines: string[] = [];
  lines.push('<details><summary>Top contributors by severity</summary>');
  lines.push('');
  lines.push('| Author | Findings | Worst | Breakdown |');
  lines.push('|---|---|---|---|');
  for (const a of rows) {
    const breakdown = (['critical', 'high', 'medium', 'low', 'nit'] as Severity[])
      .filter((sev) => a.bySeverity[sev] > 0)
      .map((sev) => `${SEVERITY_LABELS[sev]} ${a.bySeverity[sev]}`)
      .join(' · ');
    lines.push(
      `| ${escapeMd(a.authorName)} | ${a.total} | ${SEV_EMOJI[a.worstSeverity]} ${SEVERITY_LABELS[a.worstSeverity]} | ${breakdown} |`,
    );
  }
  if (authorRows.length > cap) {
    lines.push('');
    lines.push(`_… and ${authorRows.length - cap} more author(s)_`);
  }
  if (unknownCount > 0) {
    lines.push('');
    lines.push(`_${unknownCount} finding(s) had no blame entry (new or generated files)_`);
  }
  lines.push('');
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
