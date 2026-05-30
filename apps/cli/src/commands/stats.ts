import { readFile } from 'node:fs/promises';

import kleur from 'kleur';
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
 */
export async function runStats(args: ParsedArgs): Promise<void> {
  const inputPath = args.flags.input ? String(args.flags.input) : '';
  const failOn = args.flags['fail-on'] ? (String(args.flags['fail-on']) as Severity) : null;
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  const c = noColor ? new Proxy({}, { get: () => (s: string) => s }) as typeof kleur : kleur;

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

  const lines: string[] = [];
  lines.push(c.bold('ClawReview report'));
  lines.push('');
  lines.push('Findings by severity:');
  for (const sev of ['critical', 'high', 'medium', 'low', 'nit'] as const) {
    const n = totals[sev];
    const label = `  ${SEVERITY_LABELS[sev].padEnd(8)} ${String(n).padStart(4)}`;
    lines.push(n > 0 ? colorFor(c, sev)(label) : c.gray(label));
  }
  lines.push('');

  // Per-agent breakdown when a summary is present.
  const execs = parsed.summary?.agentExecutions ?? [];
  if (execs.length > 0) {
    lines.push('By agent:');
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
  const byFile = new Map<string, number>();
  for (const f of findings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  const topFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
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

  if (failOn) {
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
      return;
    }
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
