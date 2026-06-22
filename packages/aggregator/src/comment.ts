import type { Finding, Severity } from '@clawreview/types';
import { SEVERITY_LABELS } from '@clawreview/types';

import type { AggregateResult } from './aggregate.js';
import { findingDigest, type FindingDigest } from './digest.js';
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
  /**
   * Cap on the categories surfaced in the header's "By category" line.
   * When set, the renderer derives the top-N categories via the
   * `findingDigest()` helper (the same one the CLI's `stats` consumes)
   * so the PR comment and `clawreview stats --top-categories <n>` agree
   * on the same ordering and the same caller-visible bound.
   *
   * Tail behaviour: when the cap fires, the rendered line ends with
   * `(N more)` so a reviewer can tell the breakdown was truncated and
   * by how much.
   *
   * Default: unset -> render every category that has at least one
   * finding (the existing tick-1 behaviour). The cap is opt-in so
   * existing callers and snapshot tests are unaffected.
   */
  topCategories?: number;
  /**
   * Optional per-agent breakdown block in the comment header. When set,
   * the renderer inserts a "By agent" line (capped at `topAgents`)
   * derived from the same `findingDigest()` helper the CLI uses, so
   * the comment and `clawreview stats --by agent --top-agents <n>`
   * surface byte-identical ordering.
   *
   * Mirrors the existing category line: `agent` rendered in `code`
   * format with the count, joined by ` * ` separators. When the cap
   * fires the line ends with `(N more)`.
   *
   * Default: unset -> no by-agent header line (existing behaviour;
   * the per-agent breakdown still surfaces in the Run summary block
   * when runSummary.agentExecutions is supplied).
   */
  topAgents?: number;
  /**
   * Optional per-tag breakdown block in the comment header. When set,
   * the renderer inserts a "By tag" line (capped at `topTags`) derived
   * from the tick-15 `findingDigest()` topTags slice. The same data
   * the CLI's `stats --by tag --top-tags <n>` (future) and the
   * dashboard's tag panel consume.
   *
   * Mirrors the existing category / agent lines: each entry rendered
   * as `` `tag` count `` joined by ` * `; the truncation annotation
   * `_(N more)_` appears when the cap fires. The synthetic
   * `(untagged)` bucket is surfaced alongside real tags by count --
   * a corpus where most findings have no tags will show
   * `(untagged)` first, which is the intended dashboard signal.
   *
   * Default: unset -> no by-tag header line (existing behaviour --
   * tag rendering is opt-in because not every repo uses tags, and a
   * `(untagged) 47` line would be noise for those repos).
   */
  topTags?: number;
  /**
   * Pre-computed digest. When the caller already ran `findingDigest()`
   * (e.g. the worker reuses the same digest for the dashboard and the
   * comment), pass it here to skip the redundant walk inside this
   * renderer. The renderer only consumes `topAgents` / `topCategories`
   * / `topTags` from this digest -- it does NOT use `topFiles` or
   * `hotspots` (those still resolve via the `hotspots` opt).
   *
   * When unset, the renderer computes a digest internally IFF
   * `topAgents` or `topCategories` or `topTags` is set. When none are
   * set, no digest is built (zero cost on the existing render path).
   */
  digest?: FindingDigest;
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

  // Resolve a digest IF any of the top-N caps was set. Reuse the
  // caller-supplied digest when present (worker hot path passes its
  // own); otherwise build one lazily so the existing cap-unset render
  // path is zero-cost.
  let digest: FindingDigest | undefined;
  const wantsTopCategories = typeof opts.topCategories === 'number' && opts.topCategories > 0;
  const wantsTopAgents = typeof opts.topAgents === 'number' && opts.topAgents > 0;
  const wantsTopTags = typeof opts.topTags === 'number' && opts.topTags > 0;
  if (wantsTopCategories || wantsTopAgents || wantsTopTags) {
    digest =
      opts.digest ??
      findingDigest(result.findings, {
        topCategories: wantsTopCategories ? opts.topCategories : 1,
        topAgents: wantsTopAgents ? opts.topAgents : 1,
        topTags: wantsTopTags ? opts.topTags : 1,
        topFiles: 1,
      });
  }

  // Category line: if topCategories is set, render the digest's
  // already-sorted slice and append `(N more)` when truncated.
  // Otherwise keep the existing unbounded sort-by-count render so
  // existing callers / snapshots stay identical.
  let categoryLine = '';
  if (wantsTopCategories && digest) {
    const totalCategories = Object.keys(digest.byCategory).length;
    const shown = digest.topCategories;
    if (shown.length > 0) {
      const parts = shown.map((c) => `\`${c.category}\` ${c.count}`);
      const tail = totalCategories > shown.length ? ` _(${totalCategories - shown.length} more)_` : '';
      categoryLine = `${parts.join(' · ')}${tail}`;
    }
  } else {
    const categoryEntries = Object.entries(result.categoryTotals)
      .filter(([, n]) => (n ?? 0) > 0)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    if (categoryEntries.length > 0) {
      categoryLine = categoryEntries.map(([cat, n]) => `\`${cat}\` ${n}`).join(' · ');
    }
  }

  // Agent line: opt-in (default off). Mirror the category line shape
  // so a dashboard renderer sees consistent markup. When the cap fires
  // the tail `_(N more)_` annotation mirrors the category convention.
  let agentLine = '';
  if (wantsTopAgents && digest) {
    const totalAgents = Object.keys(digest.byAgent).length;
    const shownAgents = digest.topAgents;
    if (shownAgents.length > 0) {
      const parts = shownAgents.map((a) => `\`${a.agent}\` ${a.count}`);
      const tail = totalAgents > shownAgents.length ? ` _(${totalAgents - shownAgents.length} more)_` : '';
      agentLine = `By agent: ${parts.join(' · ')}${tail}`;
    }
  }

  // Tag line: opt-in (default off). Mirrors the agent line shape with
  // a `By tag:` prefix so a reviewer can pattern-match across the
  // three breakdown lines without re-reading the layout. The
  // `(untagged)` sentinel surfaces alongside real tags ranked by
  // count -- the dashboard reads byte-identical numbers via the same
  // findingDigest helper.
  let tagLine = '';
  if (wantsTopTags && digest) {
    const totalTags = Object.keys(digest.byTag).length;
    const shownTags = digest.topTags;
    if (shownTags.length > 0) {
      const parts = shownTags.map((t) => `\`${t.tag}\` ${t.count}`);
      const tail = totalTags > shownTags.length ? ` _(${totalTags - shownTags.length} more)_` : '';
      tagLine = `By tag: ${parts.join(' · ')}${tail}`;
    }
  }

  const body: string[] = ['### ClawReview', '', summary];
  if (categoryLine) {
    body.push('', categoryLine);
  }
  if (agentLine) {
    body.push('', agentLine);
  }
  if (tagLine) {
    body.push('', tagLine);
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
