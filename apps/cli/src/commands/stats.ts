import { readFile } from 'node:fs/promises';

import kleur from 'kleur';
import {
  SEVERITY_LABELS,
  SEVERITY_ORDER,
  type Finding,
  type FindingCategory,
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
 * grouping in the text report (kept for symmetry); `agent` and
 * `category` are new ad-hoc slices that operators have been asking
 * for so they can answer "which agent produced most of the noise?" or
 * "what category did we land in most this week?" without running the
 * findings through jq.
 */
export type StatsGroupBy = 'severity' | 'agent' | 'category';
const VALID_GROUPINGS: readonly StatsGroupBy[] = ['severity', 'agent', 'category'] as const;

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
 * from severity (the default) to either `agent` or `category` so an
 * operator can answer "who produced the noise?" without jq. `--by`
 * does NOT affect `--fail-on` -- the gate still keys on severity.
 *
 * `--format json` emits a machine-readable summary instead of the
 * text block (`{ totals, byAgent, byCategory, topFiles, totalCostUsd }`)
 * so dashboards and CI bots can consume the same numbers without
 * scraping the human-formatted output.
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
  const totals = computeTotals(findings, parsed.aggregated?.totals);
  const byAgent = groupCount(findings, (f) => f.agent);
  const byCategory = groupCount(findings, (f) => f.category);

  if (format === 'json') {
    // Top-files block is rendered identically in text and json so a
    // dashboard can render the same hotspot list the operator sees.
    const byFile = groupCount(findings, (f) => f.file);
    const topFiles = sortedEntries(byFile).slice(0, 10).map(([file, count]) => ({ file, count }));
    process.stdout.write(
      `${JSON.stringify(
        {
          totals,
          byAgent,
          byCategory,
          topFiles,
          totalCostUsd: parsed.summary?.totalCostUsd,
          groupBy,
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

  // Primary block depends on --by. Severity stays first by default
  // because it's the most actionable grouping (it's also what
  // --fail-on keys on). agent / category swap in their own block when
  // the user asks for them.
  if (groupBy === 'severity') {
    renderSeverityBlock(lines, totals, c);
    renderAgentCategoryBlocks(lines, byAgent, byCategory);
  } else if (groupBy === 'agent') {
    renderGroupBlock(lines, 'By agent', byAgent);
    renderSeverityBlock(lines, totals, c);
    renderGroupBlock(lines, 'By category', byCategory);
  } else {
    renderGroupBlock(lines, 'By category', byCategory);
    renderSeverityBlock(lines, totals, c);
    renderGroupBlock(lines, 'By agent', byAgent);
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

  // Top files by finding count, so reviewers see hotspots immediately.
  const byFile = groupCount(findings, (f) => f.file);
  const topFiles = sortedEntries(byFile).slice(0, 5);
  if (topFiles.length > 0) {
    lines.push('Top files:');
    for (const [file, n] of topFiles) {
      lines.push(`  ${String(n).padStart(4)}  ${file}`);
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

/**
 * Group findings by an arbitrary key function and return the counts.
 * Kept generic so adding a new --by axis is one line in the dispatch.
 */
function groupCount<T extends string>(findings: Finding[], key: (f: Finding) => T): Record<T, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    const k = key(f);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out as Record<T, number>;
}

/** Sort a count map by descending count, then by key for deterministic output. */
function sortedEntries(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
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

function renderGroupBlock(
  lines: string[],
  title: string,
  counts: Record<string, number>,
): void {
  const entries = sortedEntries(counts);
  if (entries.length === 0) return;
  lines.push(`${title}:`);
  const widest = Math.max(8, ...entries.map(([k]) => k.length));
  for (const [k, n] of entries) {
    lines.push(`  ${k.padEnd(widest)} ${String(n).padStart(4)}`);
  }
  lines.push('');
}

function renderAgentCategoryBlocks(
  lines: string[],
  byAgent: Record<string, number>,
  byCategory: Record<FindingCategory, number>,
): void {
  // Compact secondary blocks under the severity-default rendering, so a
  // user who does NOT pass --by still gets a quick agent / category
  // glance without the dedicated big-block layout.
  const agentEntries = sortedEntries(byAgent);
  if (agentEntries.length > 0) {
    lines.push('By agent:');
    const widest = Math.max(8, ...agentEntries.map(([k]) => k.length));
    for (const [k, n] of agentEntries) {
      lines.push(`  ${k.padEnd(widest)} ${String(n).padStart(4)}`);
    }
    lines.push('');
  }
  const catEntries = sortedEntries(byCategory);
  if (catEntries.length > 0) {
    lines.push('By category:');
    const widest = Math.max(8, ...catEntries.map(([k]) => k.length));
    for (const [k, n] of catEntries) {
      lines.push(`  ${k.padEnd(widest)} ${String(n).padStart(4)}`);
    }
    lines.push('');
  }
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
  reported?: Partial<Record<Severity, number>>,
): Record<Severity, number> {
  const totals: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, nit: 0 };
  // Prefer reported totals if present and consistent, else recompute.
  if (reported && Object.keys(reported).length > 0) {
    for (const sev of Object.keys(totals) as Severity[]) {
      totals[sev] = Number(reported[sev] ?? 0);
    }
    return totals;
  }
  for (const f of findings) totals[f.severity] += 1;
  return totals;
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
