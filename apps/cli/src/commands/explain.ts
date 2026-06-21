import { readFile } from 'node:fs/promises';

import kleur from 'kleur';
import { fingerprint } from '@clawreview/aggregator';
import { SEVERITY_LABELS, type Finding } from '@clawreview/types';

import type { ParsedArgs } from '../args.js';

interface ExplainReport {
  aggregated?: {
    findings?: Finding[];
  };
  // Some legacy formats keep findings at the top level; we accept both.
  findings?: Finding[];
}

/**
 * `clawreview explain <fingerprint>` reads a JSON report (produced by
 * `clawreview run --format json`) and prints the full detail of a single
 * finding addressed by its content fingerprint. Useful when CI reports
 * "5 new findings since baseline" and the reviewer wants the rationale,
 * suggested patch, and CWE without re-opening the dashboard.
 *
 * The fingerprint argument can be either the full 16-character hex
 * string or any non-ambiguous prefix. Prefix matches resolve when
 * exactly one finding's fingerprint starts with the supplied prefix;
 * otherwise the command exits 2 with a list of candidates.
 *
 * Input source:
 *   - `--input <path>`  read from a file
 *   - otherwise        read from stdin
 *
 * Exit codes:
 *   0 — finding printed
 *   1 — no matching finding
 *   2 — invalid input / ambiguous prefix / missing argument
 */
export async function runExplain(args: ParsedArgs): Promise<void> {
  const inputPath = args.flags.input ? String(args.flags.input) : '';
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  const c = noColor ? new Proxy({}, { get: () => (s: string) => s }) as typeof kleur : kleur;

  const fpArg = args.positional[0];
  if (!fpArg) {
    process.stderr.write(
      'clawreview explain: missing fingerprint argument\n' +
        'Usage: clawreview explain <fingerprint> [--input <report.json>]\n',
    );
    process.exitCode = 2;
    return;
  }
  const fpNorm = fpArg.toLowerCase().trim();
  if (!/^[0-9a-f]+$/.test(fpNorm)) {
    process.stderr.write(`clawreview explain: '${fpArg}' is not a valid fingerprint\n`);
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
    process.stderr.write('clawreview explain: empty input\n');
    process.exitCode = 2;
    return;
  }

  let parsed: ExplainReport;
  try {
    parsed = JSON.parse(raw) as ExplainReport;
  } catch (err) {
    process.stderr.write(`clawreview explain: invalid JSON (${(err as Error).message})\n`);
    process.exitCode = 2;
    return;
  }
  const findings = parsed.aggregated?.findings ?? parsed.findings ?? [];
  if (findings.length === 0) {
    process.stderr.write('clawreview explain: report contains no findings\n');
    process.exitCode = 1;
    return;
  }

  const matches = findings
    .map((f) => ({ finding: f, fp: fingerprint(f) }))
    .filter((m) => m.fp.startsWith(fpNorm));

  if (matches.length === 0) {
    process.stderr.write(`clawreview explain: no finding matches fingerprint '${fpArg}'\n`);
    process.exitCode = 1;
    return;
  }
  if (matches.length > 1) {
    process.stderr.write(
      `clawreview explain: prefix '${fpArg}' is ambiguous (${matches.length} matches)\n`,
    );
    for (const m of matches.slice(0, 8)) {
      process.stderr.write(
        `  ${m.fp}  ${m.finding.severity.padEnd(8)} ${m.finding.file}:${m.finding.startLine}  ${m.finding.title}\n`,
      );
    }
    if (matches.length > 8) {
      process.stderr.write(`  ... and ${matches.length - 8} more\n`);
    }
    process.exitCode = 2;
    return;
  }

  const { finding, fp } = matches[0]!;
  process.stdout.write(renderExplain(finding, fp, c));
}

/**
 * Pure renderer split out for testing. Returns a Markdown-ish text block
 * suitable for stdout. Uses the supplied `kleur` proxy so colour can be
 * disabled by callers piping into files.
 */
export function renderExplain(f: Finding, fp: string, c: typeof kleur): string {
  const out: string[] = [];
  out.push(c.bold(`Finding ${fp}`));
  out.push('');
  out.push(`  Severity:   ${severityLine(f, c)}`);
  out.push(`  Agent:      ${f.agent}`);
  out.push(`  Category:   ${f.category}`);
  out.push(`  Location:   ${f.file}:${f.startLine}${f.endLine ? `-${f.endLine}` : ''}`);
  out.push(`  Confidence: ${f.confidence.toFixed(2)}`);
  if (f.cwe) out.push(`  CWE:        ${f.cwe}`);
  if (f.tags && f.tags.length > 0) {
    out.push(`  Tags:       ${f.tags.join(', ')}`);
  }
  out.push('');
  out.push(c.bold('Title'));
  out.push(`  ${f.title}`);
  out.push('');
  out.push(c.bold('Rationale'));
  for (const line of f.rationale.split('\n')) {
    out.push(`  ${line}`);
  }
  if (f.suggested) {
    out.push('');
    out.push(c.bold('Suggested change'));
    out.push(`  ${f.suggested.description}`);
    out.push('');
    out.push('  ```diff');
    for (const line of f.suggested.diff.split('\n')) {
      out.push(`  ${line}`);
    }
    out.push('  ```');
  }
  out.push('');
  return out.join('\n');
}

function severityLine(f: Finding, c: typeof kleur): string {
  const label = SEVERITY_LABELS[f.severity];
  switch (f.severity) {
    case 'critical': return c.red(label);
    case 'high':     return c.magenta(label);
    case 'medium':   return c.yellow(label);
    case 'low':      return c.cyan(label);
    case 'nit':      return c.gray(label);
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
