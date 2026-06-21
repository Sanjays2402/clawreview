import { readFile } from 'node:fs/promises';
import { cwd as getCwd } from 'node:process';

import kleur from 'kleur';
import {
  attributeFindingsToAuthors,
  blameKey,
  parsePorcelainBlame,
  type BlameMap,
} from '@clawreview/aggregator';
import type { Finding, Severity } from '@clawreview/types';
import { SEVERITY_LABELS } from '@clawreview/types';

import type { ParsedArgs } from '../args.js';
import { gitBlameFile } from '../git.js';

/**
 * `clawreview authors` reads a JSON report (produced by `clawreview run
 * --format json`) and attributes the findings to the engineer who last
 * touched each line, via `git blame --line-porcelain`. Useful for
 * answering "whose change introduced this PR's noise?" without
 * re-running blame by hand.
 *
 * Inputs:
 *   --input <path>     read report JSON from a file (skip stdin)
 *   (stdin)            falls back to stdin when --input is absent
 *   --ref <ref>        ref to blame against (defaults to HEAD)
 *   --format <text|json>
 *                      output format. Text is human-readable, JSON is
 *                      machine-readable for piping into other tools.
 *   --top <n>          cap the rendered text output to the top N
 *                      authors (default: 10). JSON output is always
 *                      complete.
 *
 * Exit codes:
 *   0   attribution printed
 *   2   bad input (empty/invalid JSON, no findings)
 */
export async function runAuthors(args: ParsedArgs): Promise<void> {
  const inputPath = args.flags.input ? String(args.flags.input) : '';
  const ref = String(args.flags.ref ?? 'HEAD');
  const format = String(args.flags.format ?? 'text') as 'text' | 'json';
  const top = Math.max(1, Number(args.flags.top) || 10);
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  const c = noColor ? new Proxy({}, { get: () => (s: string) => s }) as typeof kleur : kleur;

  const raw = inputPath ? await readFile(inputPath, 'utf8') : await readStdin();
  if (!raw.trim()) {
    process.stderr.write('clawreview authors: empty input\n');
    process.exitCode = 2;
    return;
  }

  let parsed: { aggregated?: { findings?: Finding[] }; findings?: Finding[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`clawreview authors: invalid JSON (${(err as Error).message})\n`);
    process.exitCode = 2;
    return;
  }
  const findings = parsed.aggregated?.findings ?? parsed.findings ?? [];
  if (findings.length === 0) {
    process.stderr.write('clawreview authors: report contains no findings\n');
    process.exitCode = 2;
    return;
  }

  const blame = await buildBlameMap(findings, ref, getCwd());
  const breakdown = attributeFindingsToAuthors(findings, blame);

  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          attributed: breakdown.attributed,
          unknownCount: breakdown.unknown.length,
          authors: breakdown.authors,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(renderAuthorsText(breakdown, c, { top }));
}

/**
 * Build a blame map covering every (file, line) referenced by the
 * supplied findings. Files are blamed once (porcelain output is parsed
 * and merged into the map) so the overall cost is N spawns, not
 * findings-count spawns. Exposed for tests via dependency injection
 * pattern in `buildBlameMapWith`.
 */
export async function buildBlameMap(
  findings: Finding[],
  ref: string,
  cwd: string,
): Promise<BlameMap> {
  return buildBlameMapWith(findings, ref, (r, f) => gitBlameFile(r, f, cwd));
}

/**
 * Test-friendly variant: pass in your own blame fetcher. Lets unit
 * tests swap git for a string-table without spawning processes.
 */
export async function buildBlameMapWith(
  findings: Finding[],
  ref: string,
  fetchBlame: (ref: string, file: string) => Promise<string>,
): Promise<BlameMap> {
  const map: BlameMap = new Map();
  const seenFiles = new Set<string>();
  for (const f of findings) seenFiles.add(f.file);
  for (const file of seenFiles) {
    const porcelain = await fetchBlame(ref, file);
    if (!porcelain) continue;
    const perLine = parsePorcelainBlame(porcelain);
    for (const [line, entry] of perLine) {
      map.set(blameKey(file, line), entry);
    }
  }
  return map;
}

interface RenderOpts {
  top: number;
}

export function renderAuthorsText(
  breakdown: ReturnType<typeof attributeFindingsToAuthors>,
  c: typeof kleur,
  opts: RenderOpts,
): string {
  const lines: string[] = [];
  lines.push(c.bold('ClawReview findings by author'));
  lines.push(
    `  ${breakdown.authors.length} author${breakdown.authors.length === 1 ? '' : 's'}  /  ${breakdown.attributed} attributed  /  ${breakdown.unknown.length} unknown`,
  );
  lines.push('');

  const rows = breakdown.authors.slice(0, opts.top);
  if (rows.length === 0) {
    lines.push(c.gray('  (no attributable findings)'));
    return `${lines.join('\n')}\n`;
  }
  const namePad = Math.max(
    8,
    ...rows.map((a) => `${a.authorName} <${a.authorEmail}>`.length),
  );

  for (const a of rows) {
    const label = `${a.authorName} <${a.authorEmail}>`.padEnd(namePad);
    const bits = (['critical', 'high', 'medium', 'low', 'nit'] as const)
      .filter((sev) => a.bySeverity[sev] > 0)
      .map((sev) => `${SEVERITY_LABELS[sev]} ${a.bySeverity[sev]}`);
    const worst = severityColor(a.worstSeverity, c)(SEVERITY_LABELS[a.worstSeverity]);
    lines.push(
      `  ${label}  ${String(a.total).padStart(3)}  worst=${worst}  ${c.gray(bits.join('  '))}`,
    );
  }
  if (breakdown.authors.length > opts.top) {
    lines.push(c.gray(`  ... and ${breakdown.authors.length - opts.top} more author(s)`));
  }
  if (breakdown.unknown.length > 0) {
    lines.push('');
    lines.push(c.gray(`  ${breakdown.unknown.length} finding(s) had no blame entry (new files or generated code)`));
  }
  lines.push('');
  return lines.join('\n');
}

function severityColor(sev: Severity, c: typeof kleur): (s: string) => string {
  switch (sev) {
    case 'critical': return c.red;
    case 'high':     return c.magenta;
    case 'medium':   return c.yellow;
    case 'low':      return c.cyan;
    case 'nit':      return c.gray;
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
