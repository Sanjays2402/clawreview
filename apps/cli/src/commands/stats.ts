import { readFile } from 'node:fs/promises';

import kleur from 'kleur';
import {
  findingDigestWithFilterReport,
  type FindingDigest,
  type FindingDigestFilterReport,
} from '@clawreview/aggregator';
import {
  SEVERITY_LABELS,
  SEVERITY_ORDER,
  type Finding,
  type Severity,
} from '@clawreview/types';

import type { ParsedArgs } from '../args.js';

interface StatsReport {
  aggregated?: {
    findings?: Finding[];
    totals?: Partial<Record<Severity, number>>;
  };
  summary?: {
    agentExecutions?: Array<{
      agent: string;
      status: string;
      durationMs: number;
      findings: Finding[];
    }>;
    totalCostUsd?: number;
  };
}

/**
 * Axes the user can pass to `--by`. `severity` mirrors the default
 * grouping in the text report (kept for symmetry); `agent` /
 * `category` / `file` are ad-hoc slices that operators have been
 * asking for so they can answer "which agent produced most of the
 * noise?" / "what category did we land in most this week?" /
 * "which file is the hotspot today?" without running the findings
 * through jq.
 */
export type StatsGroupBy = 'severity' | 'agent' | 'category' | 'file';
const VALID_GROUPINGS: readonly StatsGroupBy[] = [
  'severity',
  'agent',
  'category',
  'file',
] as const;

/**
 * Default cap on the rendered top-files block in text output.
 * Matches the historical hard-coded value so existing scripts keep
 * seeing the same five rows when they omit `--top-files`.
 */
const DEFAULT_TOP_FILES = 5;

/**
 * Default cap on the rendered top-agents / top-categories blocks.
 * Mirror of DEFAULT_TOP_FILES at a slightly looser default (10) since
 * the agent / category cardinality is bounded by AGENT_REGISTRY and
 * the closed FindingCategory union; an operator running --by agent or
 * --by category usually wants to see everything by default.
 *
 * MAX_TOP applies to ALL three --top-* flags so the clamp logic is one
 * constant.
 */
const DEFAULT_TOP_AGENTS = 10;
const DEFAULT_TOP_CATEGORIES = 10;
const MAX_TOP = 200;

/**
 * `clawreview stats` reads a previously generated JSON report (the output of
 * `clawreview run --format json`) and prints a compact summary plus exits
 * non-zero when findings at or above a threshold are present.
 *
 * Designed to be the second half of a two-step CI workflow:
 *
 *   clawreview run --base origin/main --format json > report.json
 *   clawreview stats --input report.json --fail-on high
 *
 * Reading from stdin is also supported:
 *
 *   clawreview run --format json | clawreview stats --fail-on critical
 *
 * `--by <axis>` switches the primary grouping in the rendered output
 * from severity (the default) to `agent`, `category`, or `file` so an
 * operator can answer "who produced the noise?" / "where is the
 * noise?" without jq. `--by` does NOT affect `--fail-on` -- the gate
 * still keys on severity.
 *
 * `--top-files <n>` caps the rendered top-files block in text output
 * AND the `topFiles` array in `--format json`. Clamped into [1, 200]
 * so a misconfigured caller cannot disable or blow up the render.
 * When `--by file` is the primary axis, the cap also drives how many
 * file rows the by-file block prints.
 *
 * `--format json` emits a machine-readable summary instead of the
 * text block (`{ totals, byAgent, byCategory, byFile, topFiles,
 * totalCostUsd }`) so dashboards and CI bots can consume the same
 * numbers without scraping the human-formatted output. Internally the
 * counts now come from `findingDigest()` so this CLI, the worker, and
 * the PR comment header all agree on the same single-pass summary.
 */
export async function runStats(args: ParsedArgs): Promise<void> {
  const inputPath = args.flags.input ? String(args.flags.input) : '';
  const failOn = args.flags['fail-on'] ? (String(args.flags['fail-on']) as Severity) : null;
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  const c = noColor ? new Proxy({}, { get: () => (s: string) => s }) as typeof kleur : kleur;

  // `--by <axis>` selects the primary grouping in the rendered output.
  // Default keeps the historical severity-first layout.
  const byRaw = args.flags.by ? String(args.flags.by).toLowerCase() : 'severity';
  if (!(VALID_GROUPINGS as readonly string[]).includes(byRaw)) {
    process.stderr.write(
      `clawreview stats: --by must be one of ${VALID_GROUPINGS.join(', ')} (got '${byRaw}')\n`,
    );
    process.exitCode = 2;
    return;
  }
  const groupBy = byRaw as StatsGroupBy;

  const format = args.flags.format ? String(args.flags.format).toLowerCase() : 'text';
  if (format !== 'text' && format !== 'json') {
    process.stderr.write(`clawreview stats: --format must be text|json (got '${format}')\n`);
    process.exitCode = 2;
    return;
  }

  // `--top-files <n>` caps both the text top-files block and the json
  // topFiles array. Default 5 (historical); clamped into [1, 200] so a
  // misconfigured caller can't disable or blow it up. A non-numeric
  // value (e.g. "bogus") falls back to the default; a finite numeric
  // value (including 0 and negatives) clamps into the allowed range.
  const topFiles = parseTopFlag(args.flags['top-files'], DEFAULT_TOP_FILES);
  // `--top-agents <n>` / `--top-categories <n>` mirror --top-files
  // for the agent / category groupings. Default 10 (closed cardinality
  // bounds: AGENT_REGISTRY + FindingCategory union); clamped into
  // [1, 200]. Used to cap BOTH the text render of --by agent / --by
  // category AND the json topAgents / topCategories arrays.
  const topAgents = parseTopFlag(args.flags['top-agents'], DEFAULT_TOP_AGENTS);
  const topCategories = parseTopFlag(args.flags['top-categories'], DEFAULT_TOP_CATEGORIES);

  // Tick 20: --min-confidence <n> and --severity-threshold <s> mirror
  // the worker's cfg.min_confidence + cfg.severity_threshold knobs:
  // both are pre-bucket filters applied by findingDigest BEFORE any
  // counting. Use case: an operator wants to preview "what would my
  // report look like with a 0.6 confidence floor and a 'medium'
  // severity floor?" without editing config / re-running review.
  //
  // The clamping policy is the digest's own: --min-confidence outside
  // [0, 1] clamps to the boundary; --severity-threshold with an
  // unknown / mis-cased value is treated as "no filter" (forgiving
  // back-compat). Both pass through findingDigest's normaliser so the
  // CLI never re-implements the parse contract.
  //
  // The flags compose: passing BOTH applies AND semantics (a finding
  // must clear BOTH floors to be counted). Composes with --by /
  // --top-* too -- the filter runs first, then the digest computes
  // every bucket / slice over the surviving findings.
  //
  // --fail-on still applies AFTER the filters since it keys on the
  // computed totals; so an operator can run
  //   clawreview stats --min-confidence 0.7 --fail-on high
  // to gate ONLY on high-confidence high/critical findings.
  const minConfidenceRaw = args.flags['min-confidence'];
  const minConfidence =
    minConfidenceRaw === undefined ? undefined : Number(String(minConfidenceRaw));
  // Pass the raw string through to the digest helper; the digest's
  // own normaliser handles the case-insensitive / unknown-string
  // arms. This keeps the CLI thin: one source of truth for the
  // filter contract, no risk of the CLI's validation drifting from
  // the digest's.
  const severityThreshold =
    args.flags['severity-threshold'] === undefined
      ? undefined
      : String(args.flags['severity-threshold']);

  let raw: string;
  if (inputPath) {
    raw = await readFile(inputPath, 'utf8');
  } else {
    raw = await readStdin();
  }
  if (!raw.trim()) {
    process.stderr.write('clawreview stats: empty input\n');
    process.exitCode = 2;
    return;
  }

  let parsed: StatsReport;
  try {
    parsed = JSON.parse(raw) as StatsReport;
  } catch (err) {
    process.stderr.write(`clawreview stats: invalid JSON (${(err as Error).message})\n`);
    process.exitCode = 2;
    return;
  }

  const findings = parsed.aggregated?.findings ?? [];
  // findingDigestWithFilterReport is the canonical single-pass summarizer
  // wrapper (lives in @clawreview/aggregator); it computes the same
  // FindingDigest findingDigest() would AND surfaces inputTotal /
  // droppedTotal / appliedFilters so the --filter-summary text header
  // (tick 21) can attribute drops without re-walking findings.
  //
  // Tick 20: pass --min-confidence and --severity-threshold through
  // verbatim. The digest helper handles all normalisation /
  // clamping; we cast severityThreshold to the expected union since
  // we deliberately forward the raw string (the digest's normaliser
  // returns null for unknown values, so a typo is forgiving).
  const filterReport = findingDigestWithFilterReport(findings, {
    topFiles,
    topAgents,
    topCategories,
    minConfidence,
    severityThreshold: severityThreshold as Severity | undefined,
  });
  const digest = filterReport.digest;
  const totals = computeTotals(findings, parsed.aggregated?.totals, digest);

  // Tick 21: --filter-summary (text-mode opt-in) prints a compact
  // one-line header showing which filter(s) applied and how many
  // findings were dropped. Default OFF for back-compat -- existing
  // text output stays unchanged when the flag is absent. JSON
  // output is unaffected: the filter echo on the JSON shape has
  // existed since tick 20 and consumers can compute the drop count
  // themselves; the flag exists for the text surface where a
  // dashboard-style "you're seeing 1 finding (filtered 2 of 3 by
  // min_confidence >= 0.5)" line is the natural UX.
  const showFilterSummary = Boolean(args.flags['filter-summary']);
  // Tick 22: --json-header. When set AND --format json AND
  // --filter-summary is also set, emit a one-line JSON envelope
  // on stdout BEFORE the multi-line JSON report body. The
  // envelope shape is:
  //   { kind: "filterSummary",
  //     showing, inputTotal, droppedTotal,
  //     minConfidence: { raw, normalised, applied },
  //     severityThreshold: { raw, normalised, applied },
  //     any }
  // A downstream tool can `head -1 | jq '.droppedTotal > 0'`
  // to short-circuit without parsing the full report. Default
  // OFF for back-compat -- existing JSON consumers see no diff.
  // Requires --filter-summary so the flag composes the existing
  // opt-in (rather than emitting a header on every JSON call).
  // In text mode the flag is a no-op (the existing text header
  // is already there); we don't error because composition with
  // unrelated text-mode flags should be benign.
  const wantJsonHeader = Boolean(args.flags['json-header']);
  // Tick 23: --jsonl. When set AND --format json AND --json-header
  // is also set, REPLACE the single multi-line report body with a
  // line-delimited stream:
  //   line 1   : { kind: "filterSummary", ... }                (header)
  //   lines 2-6: { kind: "severityBucket", severity, count }   (one per severity)
  //   line 7   : { kind: "reportFooter", totalCostUsd, byAgent,
  //                byCategory, topFiles, topAgents,
  //                topCategories, byFile, groupBy,
  //                minConfidence, severityThreshold }          (catch-all)
  //
  // Use case: a CI pipeline that streams `clawreview stats` through
  // a log aggregator wants ONE JSON object per line (not a multi-line
  // pretty-printed body) so each line can be ingested independently
  // and queries like "show me all severity buckets where count>0"
  // become `jq 'select(.kind=="severityBucket" and .count>0)'`.
  //
  // The severity bucket stream walks the canonical SEVERITY_ORDER
  // (critical, high, medium, low, nit) so a downstream consumer can
  // rely on stable ordering. We emit ALL FIVE buckets regardless of
  // count so a consumer that wants a fixed-shape histogram doesn't
  // have to fill in zeros itself.
  //
  // Requires --json-header (which itself requires --filter-summary)
  // so the flag composes the existing opt-in chain. In text mode
  // it's a silent no-op (same back-compat stance as --json-header).
  // When set WITHOUT --json-header, it's also a no-op -- the body
  // shape only makes sense paired with the header.
  const wantJsonl = Boolean(args.flags['jsonl']);

  if (format === 'json') {
    // Tick 22: opt-in JSON-header line. When --json-header AND
    // --filter-summary are BOTH set, emit a single-line JSON
    // envelope BEFORE the report body so a downstream consumer
    // can `head -1 | jq` to short-circuit on the filter shape.
    // The envelope is byte-identical to renderFilterSummaryJson()
    // so a CI gate that parses it never sees a multi-line JSON
    // object straddling two layers.
    if (wantJsonHeader && showFilterSummary) {
      const header = renderFilterSummaryJson(filterReport);
      process.stdout.write(`${JSON.stringify(header)}\n`);
    }
    // Tick 23: --jsonl line-delimited stream replaces the multi-line
    // body. The header line was already emitted above; we follow it
    // with one severity-bucket line per severity (canonical order)
    // and then a single report-footer line carrying the rest of the
    // payload. Requires the full opt-in chain (--filter-summary +
    // --json-header + --jsonl) so existing JSON consumers see no
    // diff unless they explicitly opt in. When the chain isn't
    // satisfied (any of the three flags absent), fall through to
    // the existing pretty-printed body (back-compat).
    if (wantJsonl && wantJsonHeader && showFilterSummary) {
      // Severity bucket lines: walk SEVERITY_ORDER's canonical
      // ordering (critical..nit) so a downstream consumer relying on
      // line order gets stable results. The renderSeverityBucketLine
      // pure helper is exported for symmetry with renderFilterSummaryJson.
      for (const sev of ['critical', 'high', 'medium', 'low', 'nit'] as const) {
        const line = renderSeverityBucketLine(sev, totals[sev]);
        process.stdout.write(`${JSON.stringify(line)}\n`);
      }
      // Footer: everything that wasn't on the header or per-severity
      // lines. Mirrors the existing multi-line body's shape minus the
      // `totals` field (already conveyed via the severity-bucket
      // lines) -- consumers that just want the per-bucket counts
      // don't have to parse the footer.
      const footer: StatsReportFooter = {
        kind: 'reportFooter',
        byAgent: digest.byAgent,
        byCategory: digest.byCategory,
        byFile: digest.byFile,
        topFiles: digest.topFiles,
        topAgents: digest.topAgents,
        topCategories: digest.topCategories,
        totalCostUsd: parsed.summary?.totalCostUsd,
        groupBy,
        minConfidence: minConfidence === undefined ? null : minConfidence,
        severityThreshold: severityThreshold === undefined ? null : severityThreshold,
      };
      process.stdout.write(`${JSON.stringify(footer)}\n`);
      // --fail-on still applies on JSONL output for the same
      // reason it applies on the legacy body: CI gates expect
      // a non-zero exit code when the gate fails.
      applyFailOn(failOn, totals);
      return;
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          totals,
          byAgent: digest.byAgent,
          byCategory: digest.byCategory,
          byFile: digest.byFile,
          topFiles: digest.topFiles,
          topAgents: digest.topAgents,
          topCategories: digest.topCategories,
          totalCostUsd: parsed.summary?.totalCostUsd,
          groupBy,
          // Tick 20: echo the resolved filters so a JSON consumer
          // (CI dashboard, downstream jq pipeline) can verify the
          // filter actually applied. `null` whenever the operator
          // didn't pass the flag (no filter); the resolved value
          // (clamped / normalised) whenever they did. We use null
          // rather than omitting so the shape stays uniform.
          minConfidence: minConfidence === undefined ? null : minConfidence,
          severityThreshold: severityThreshold === undefined ? null : severityThreshold,
        },
        null,
        2,
      )}\n`,
    );
    // --fail-on still applies on JSON output so CI workflows can pipe
    // `clawreview stats --format json` to a saved artifact AND gate on
    // the exit code in the same step.
    applyFailOn(failOn, totals);
    return;
  }

  const lines: string[] = [];
  lines.push(c.bold('ClawReview report'));
  lines.push('');

  // Tick 21: when --filter-summary is set AND a filter actually
  // applied, surface a one-line summary right after the header so
  // an operator scanning the text output knows the totals are
  // post-filter (not the full report). When neither filter applied
  // (default invocation) the line is omitted to keep the back-
  // compat text shape; when the flag is set but the filter was a
  // no-op (e.g. a typo'd --severity-threshold normalised to null),
  // we still print a "no filters applied" line so the operator
  // sees their intent was acknowledged.
  if (showFilterSummary) {
    const summary = renderFilterSummaryLine(filterReport, c);
    lines.push(summary);
    lines.push('');
  }

  // Primary block depends on --by. Severity stays first by default
  // because it's the most actionable grouping (it's also what
  // --fail-on keys on). agent / category / file swap in their own
  // block when the user asks for them.
  if (groupBy === 'severity') {
    renderSeverityBlock(lines, totals, c);
    renderAgentCategoryBlocks(lines, digest, topAgents, topCategories);
  } else if (groupBy === 'agent') {
    renderAgentBlock(lines, digest, topAgents);
    renderSeverityBlock(lines, totals, c);
    renderCategoryBlock(lines, digest, topCategories);
  } else if (groupBy === 'category') {
    renderCategoryBlock(lines, digest, topCategories);
    renderSeverityBlock(lines, totals, c);
    renderAgentBlock(lines, digest, topAgents);
  } else {
    // --by file: lead with the per-file block capped at top-files,
    // then severity, then agent/category as secondaries so the
    // operator still sees the breakdown without re-running with a
    // different --by.
    renderTopFilesAsBlock(lines, digest, topFiles);
    renderSeverityBlock(lines, totals, c);
    renderAgentCategoryBlocks(lines, digest, topAgents, topCategories);
  }

  // Per-agent EXECUTION breakdown is distinct from the per-agent
  // FINDINGS breakdown above: this one carries duration + status from
  // the pipeline summary, so it's worth keeping even when --by switches
  // the primary grouping.
  const execs = parsed.summary?.agentExecutions ?? [];
  if (execs.length > 0) {
    lines.push('By agent execution:');
    const widest = execs.reduce((m, e) => Math.max(m, e.agent.length), 0);
    for (const e of execs) {
      const n = (e.findings ?? []).length;
      lines.push(
        `  ${e.agent.padEnd(widest)}  ${String(n).padStart(4)} findings  ${e.durationMs}ms  ${e.status}`,
      );
    }
    lines.push('');
  }

  // Top files by finding count. When --by file is already the primary
  // block we skip the secondary print (the same numbers would be
  // duplicated immediately below the header) so the text output stays
  // tight.
  if (groupBy !== 'file' && digest.topFiles.length > 0) {
    lines.push('Top files:');
    for (const { file, count } of digest.topFiles) {
      lines.push(`  ${String(count).padStart(4)}  ${file}`);
    }
    lines.push('');
  }

  if (parsed.summary?.totalCostUsd !== undefined) {
    lines.push(`Total LLM cost:  $${parsed.summary.totalCostUsd.toFixed(4)}`);
    lines.push('');
  }

  process.stdout.write(lines.join('\n') + '\n');

  applyFailOn(failOn, totals);
}

function renderSeverityBlock(
  lines: string[],
  totals: Record<Severity, number>,
  c: typeof kleur,
): void {
  lines.push('Findings by severity:');
  for (const sev of ['critical', 'high', 'medium', 'low', 'nit'] as const) {
    const n = totals[sev];
    const label = `  ${SEVERITY_LABELS[sev].padEnd(8)} ${String(n).padStart(4)}`;
    lines.push(n > 0 ? colorFor(c, sev)(label) : c.gray(label));
  }
  lines.push('');
}

/**
 * Render the `--by agent` primary block (or the secondary block under
 * severity-default rendering). Consumes the digest's already-sorted
 * topAgents slice so the CLI and any other consumer of findingDigest
 * (worker, PR comment header) render byte-identical numbers.
 *
 * The header includes `(top N of M)` when the cap trimmed the list,
 * so the operator notices that --top-agents was effective.
 */
function renderAgentBlock(
  lines: string[],
  digest: FindingDigest,
  topAgents: number,
): void {
  if (digest.topAgents.length === 0) return;
  const totalAgents = Object.keys(digest.byAgent).length;
  const shown = digest.topAgents.length;
  const suffix = totalAgents > shown ? ` (top ${shown} of ${totalAgents})` : '';
  lines.push(`By agent${suffix}:`);
  const widest = Math.max(8, ...digest.topAgents.map(({ agent }) => agent.length));
  for (const { agent, count } of digest.topAgents) {
    lines.push(`  ${agent.padEnd(widest)} ${String(count).padStart(4)}`);
  }
  lines.push('');
  void topAgents;
}

/**
 * Render the `--by category` primary block. Same shape contract as
 * renderAgentBlock; consumes digest.topCategories (already sorted).
 */
function renderCategoryBlock(
  lines: string[],
  digest: FindingDigest,
  topCategories: number,
): void {
  if (digest.topCategories.length === 0) return;
  const totalCategories = Object.keys(digest.byCategory).length;
  const shown = digest.topCategories.length;
  const suffix = totalCategories > shown ? ` (top ${shown} of ${totalCategories})` : '';
  lines.push(`By category${suffix}:`);
  const widest = Math.max(8, ...digest.topCategories.map(({ category }) => category.length));
  for (const { category, count } of digest.topCategories) {
    lines.push(`  ${category.padEnd(widest)} ${String(count).padStart(4)}`);
  }
  lines.push('');
  void topCategories;
}

/**
 * Render the `--by file` primary block. Reuses the digest's already-
 * sorted topFiles array (sliced to the requested cap) so this view and
 * the standalone Top files secondary block stay byte-for-byte
 * consistent.
 */
function renderTopFilesAsBlock(
  lines: string[],
  digest: FindingDigest,
  topFiles: number,
): void {
  if (digest.topFiles.length === 0) return;
  const totalFiles = Object.keys(digest.byFile).length;
  const shown = digest.topFiles.length;
  // Header includes "of N" when we trimmed, so the operator notices
  // that --top-files was effective.
  const suffix = totalFiles > shown ? ` (top ${shown} of ${totalFiles})` : '';
  lines.push(`By file${suffix}:`);
  const widest = Math.max(8, ...digest.topFiles.map(({ file }) => file.length));
  for (const { file, count } of digest.topFiles) {
    lines.push(`  ${file.padEnd(widest)} ${String(count).padStart(4)}`);
  }
  lines.push('');
  // Silence linter: parameter retained for symmetry with other render
  // helpers and so a future refactor can pass the cap through to a
  // pagination hint without changing call sites.
  void topFiles;
}

function renderAgentCategoryBlocks(
  lines: string[],
  digest: FindingDigest,
  topAgents: number,
  topCategories: number,
): void {
  // Compact secondary blocks under the severity-default rendering, so a
  // user who does NOT pass --by still gets a quick agent / category
  // glance without the dedicated big-block layout. We reuse the same
  // capped topAgents / topCategories slices so the secondary blocks
  // honour --top-agents / --top-categories without re-walking the maps.
  renderAgentBlock(lines, digest, topAgents);
  renderCategoryBlock(lines, digest, topCategories);
}

function applyFailOn(
  failOn: Severity | null,
  totals: Record<Severity, number>,
): void {
  if (!failOn) return;
  if (!(failOn in SEVERITY_ORDER)) {
    process.stderr.write(`clawreview stats: unknown severity '${failOn}'\n`);
    process.exitCode = 2;
    return;
  }
  const triggered = (['critical', 'high', 'medium', 'low', 'nit'] as Severity[]).filter(
    (s) => SEVERITY_ORDER[s] <= SEVERITY_ORDER[failOn] && totals[s] > 0,
  );
  if (triggered.length > 0) {
    const total = triggered.reduce((sum, s) => sum + totals[s], 0);
    process.stderr.write(
      `clawreview stats: ${total} finding(s) at or above '${failOn}' (${triggered.join(', ')})\n`,
    );
    process.exitCode = 1;
  }
}

function computeTotals(
  findings: Finding[],
  reported: Partial<Record<Severity, number>> | undefined,
  digest: FindingDigest,
): Record<Severity, number> {
  // Prefer reported totals if present and consistent, else use the
  // digest's totalsBySeverity (which is what every other consumer
  // sees, so the CLI and dashboard agree byte-for-byte).
  if (reported && Object.keys(reported).length > 0) {
    const totals: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, nit: 0 };
    for (const sev of Object.keys(totals) as Severity[]) {
      totals[sev] = Number(reported[sev] ?? 0);
    }
    return totals;
  }
  // Defensive copy so a caller that mutates the returned record (which
  // applyFailOn doesn't, but a future caller might) cannot reach back
  // into the digest. `findings` retained so a future caller that wants
  // to recompute totals from scratch (e.g. when the digest carried a
  // different threshold than the reported totals) still has the
  // primary source on hand.
  void findings;
  return { ...digest.totalsBySeverity };
}

function colorFor(c: typeof kleur, sev: Severity) {
  switch (sev) {
    case 'critical':
      return c.red;
    case 'high':
      return c.magenta;
    case 'medium':
      return c.yellow;
    case 'low':
      return c.cyan;
    case 'nit':
      return c.gray;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse a `--top-* <n>` flag value into a clamped integer.
 *
 *   - undefined input -> the supplied default (back-compat).
 *   - non-numeric / NaN / Infinity -> the default. We deliberately
 *     fall back rather than erroring so a careless `--top-agents bogus`
 *     still produces a useful report; the value is documented in --help.
 *   - finite numeric value (including 0 and negatives) clamps into
 *     [1, MAX_TOP] so a misconfigured caller can't disable or blow up
 *     the render.
 *
 * Exported so the CLI / a future test caller share the contract.
 */
function parseTopFlag(raw: string | boolean | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const parsedNum = Number(raw);
  if (!Number.isFinite(parsedNum)) return defaultValue;
  return Math.max(1, Math.min(MAX_TOP, Math.floor(parsedNum)));
}

/**
 * Tick 21: build the one-line `--filter-summary` text header.
 *
 * Use case: an operator reading `clawreview stats --min-confidence 0.5
 * --filter-summary` should see ONE line that tells them:
 *   - which filter(s) ran;
 *   - what threshold each one resolved to (clamped values, not raw);
 *   - how many findings were dropped vs. kept.
 *
 * Shape examples (uncoloured, for readability):
 *
 *   Showing 3 findings (filtered 0 of 3; no filters applied)
 *   Showing 1 finding (filtered 2 of 3 by min_confidence >= 0.5)
 *   Showing 2 findings (filtered 1 of 3 by severity_threshold >= high)
 *   Showing 1 finding (filtered 2 of 3 by min_confidence >= 0.5 + severity_threshold >= high)
 *
 * The "Showing N findings" prefix uses the post-filter `digest.total`
 * so it matches whatever the rendered totals block shows. The
 * "(filtered M of K)" parenthetical uses inputTotal as K so the
 * operator sees how many findings were on disk before the filter.
 *
 * When neither filter applied (the default invocation), the line
 * collapses to "Showing N findings (no filters applied)" rather than
 * disappearing entirely. That keeps the flag's behaviour
 * predictable: opting in always produces a line.
 *
 * The normalised value is what the digest CONSUMED -- not the raw
 * operator input. So `--min-confidence 1.5` shows ">= 1" (after
 * clamping); a typo'd `--severity-threshold Critical` doesn't fire
 * because applied=false, falling under the "no filters applied"
 * branch.
 *
 * Pure / exported so the test surface can pin every arm.
 */
export function renderFilterSummaryLine(
  report: FindingDigestFilterReport,
  c: typeof kleur,
): string {
  const showing = report.digest.total === 1
    ? '1 finding'
    : `${report.digest.total} findings`;
  const parts: string[] = [];
  if (report.appliedFilters.minConfidence.applied) {
    parts.push(`min_confidence >= ${report.appliedFilters.minConfidence.normalised}`);
  }
  if (report.appliedFilters.severityThreshold.applied) {
    parts.push(`severity_threshold >= ${report.appliedFilters.severityThreshold.normalised}`);
  }
  const dropped = `filtered ${report.droppedTotal} of ${report.inputTotal}`;
  const detail = parts.length === 0
    ? `${dropped}; no filters applied`
    : `${dropped} by ${parts.join(' + ')}`;
  return c.cyan(`Showing ${showing} (${detail})`);
}

/**
 * Tick 22: build the machine-readable JSON envelope for
 * `--filter-summary --json-header`.
 *
 * Use case: a CI pipeline that consumes `clawreview stats --format
 * json --filter-summary --json-header` wants to read JUST the
 * filter summary on the FIRST line of stdout, decide whether to
 * short-circuit (e.g. fail the build immediately if any filter
 * was applied), and only parse the multi-line report body when
 * required. The envelope shape mirrors the text-mode renderer
 * (`renderFilterSummaryLine`) but in a structured form so a `jq`
 * filter never has to scrape "Showing N findings (...)" with a
 * regex.
 *
 * Shape:
 *   - `kind`            -- discriminator string `"filterSummary"`.
 *                          Pinned so a future header variant
 *                          (e.g. `kind: "schemaVersion"`) doesn't
 *                          collide; consumers gate on this string
 *                          before reading the rest.
 *   - `showing`         -- post-filter `digest.total`.
 *   - `inputTotal`      -- pre-filter total (length of findings).
 *   - `droppedTotal`    -- inputTotal - showing. Always >= 0.
 *   - `minConfidence`   -- `{ raw, normalised, applied }` mirror
 *                          of `FindingDigestFilterReport.
 *                          appliedFilters.minConfidence`.
 *   - `severityThreshold` -- same shape for the severity axis.
 *   - `any`             -- true iff EITHER filter applied
 *                          (mirror of appliedFilters.any).
 *
 * Pure / exported so the test surface can pin every arm. The
 * field names are stable; a new field added in a future tick
 * extends the envelope but never renames existing ones (existing
 * consumers stay correct).
 */
export interface StatsFilterSummaryEnvelope {
  kind: 'filterSummary';
  showing: number;
  inputTotal: number;
  droppedTotal: number;
  minConfidence: {
    raw: number | undefined;
    normalised: number;
    applied: boolean;
  };
  severityThreshold: {
    raw: string | undefined;
    normalised: string | null;
    applied: boolean;
  };
  any: boolean;
}

export function renderFilterSummaryJson(
  report: FindingDigestFilterReport,
): StatsFilterSummaryEnvelope {
  return {
    kind: 'filterSummary',
    showing: report.digest.total,
    inputTotal: report.inputTotal,
    droppedTotal: report.droppedTotal,
    minConfidence: {
      raw: report.appliedFilters.minConfidence.raw,
      normalised: report.appliedFilters.minConfidence.normalised,
      applied: report.appliedFilters.minConfidence.applied,
    },
    severityThreshold: {
      raw: report.appliedFilters.severityThreshold.raw,
      normalised: report.appliedFilters.severityThreshold.normalised,
      applied: report.appliedFilters.severityThreshold.applied,
    },
    any: report.appliedFilters.any,
  };
}

/**
 * Tick 23: per-severity-bucket line emitted on the `--jsonl` stream.
 *
 * Shape:
 *   - `kind`     -- discriminator `"severityBucket"`. A downstream
 *                   tool gates on this before reading the rest:
 *                   `jq 'select(.kind=="severityBucket")'`.
 *   - `severity` -- closed enum: critical|high|medium|low|nit.
 *   - `count`    -- post-filter count for the bucket. ALWAYS present
 *                   (zero when no findings landed in that severity)
 *                   so consumers get a fixed-shape histogram without
 *                   filling in zeros themselves.
 *
 * Pure / exported so the test surface can pin every arm.
 */
export interface StatsSeverityBucketLine {
  kind: 'severityBucket';
  severity: Severity;
  count: number;
}

export function renderSeverityBucketLine(
  severity: Severity,
  count: number,
): StatsSeverityBucketLine {
  return { kind: 'severityBucket', severity, count };
}

/**
 * Tick 23: footer line emitted on the `--jsonl` stream after the
 * header + per-severity bucket lines. Carries everything else from
 * the legacy multi-line JSON body minus the `totals` field (already
 * conveyed via the severity bucket stream).
 *
 * Shape: discriminator `"reportFooter"` + the same fields the
 * legacy body had (byAgent/byCategory/byFile/topFiles/topAgents/
 * topCategories/totalCostUsd/groupBy/minConfidence/severityThreshold).
 *
 * Exported as an interface so a test can pin the catch-all field set
 * -- adding a field to the legacy body should ALSO surface here so
 * a JSONL consumer sees the same envelope.
 */
export interface StatsReportFooter {
  kind: 'reportFooter';
  byAgent: Record<string, number>;
  byCategory: Record<string, number>;
  byFile: Record<string, number>;
  topFiles: Array<{ file: string; count: number }>;
  topAgents: Array<{ agent: string; count: number }>;
  topCategories: Array<{ category: string; count: number }>;
  totalCostUsd: number | undefined;
  groupBy: string;
  minConfidence: number | null;
  severityThreshold: string | null;
}
