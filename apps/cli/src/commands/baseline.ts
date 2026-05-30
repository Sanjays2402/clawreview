import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import kleur from 'kleur';
import { diffAgainstBaseline, fingerprint } from '@clawreview/aggregator';
import type { Finding } from '@clawreview/types';

import type { ParsedArgs } from '../args.js';

interface ReportShape {
  aggregated?: { findings?: Finding[] };
}

interface BaselineFile {
  version: 1;
  createdAt: string;
  source?: string;
  findings: Array<{ fingerprint: string; finding: Finding }>;
}

const DEFAULT_BASELINE_PATH = '.clawreview/baseline.json';

/**
 * `clawreview baseline` manages a local baseline of findings so CI can fail
 * only on new findings introduced by a PR, instead of every legacy issue
 * the agents pick up on a brownfield codebase.
 *
 * Subcommands:
 *
 *   clawreview baseline save   --input report.json [--output .clawreview/baseline.json]
 *   clawreview baseline diff   --input report.json [--baseline .clawreview/baseline.json]
 *                              [--fail-on-new]
 *
 * Both subcommands read a JSON report produced by `clawreview run --format json`.
 */
export async function runBaseline(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0] ?? '';
  if (sub === 'save') return saveBaseline(args);
  if (sub === 'diff') return diffBaseline(args);
  process.stderr.write(
    'clawreview baseline: expected subcommand "save" or "diff"\n' +
      '  clawreview baseline save  --input report.json [--output path]\n' +
      '  clawreview baseline diff  --input report.json [--baseline path] [--fail-on-new]\n',
  );
  process.exitCode = 2;
}

async function saveBaseline(args: ParsedArgs): Promise<void> {
  const findings = await loadFindings(args);
  if (findings === null) return;
  const outPath = resolve(String(args.flags.output ?? DEFAULT_BASELINE_PATH));
  const baseline: BaselineFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: args.flags.input ? String(args.flags.input) : 'stdin',
    findings: findings.map((f) => ({ fingerprint: fingerprint(f), finding: f })),
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  process.stdout.write(`Saved ${findings.length} findings to ${outPath}\n`);
}

async function diffBaseline(args: ParsedArgs): Promise<void> {
  const current = await loadFindings(args);
  if (current === null) return;
  const baselinePath = resolve(String(args.flags.baseline ?? DEFAULT_BASELINE_PATH));
  let baselineRaw: string;
  try {
    baselineRaw = await readFile(baselinePath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `clawreview baseline diff: cannot read ${baselinePath} (${(err as Error).message})\n` +
        'Run `clawreview baseline save` first to create one.\n',
    );
    process.exitCode = 2;
    return;
  }
  let baselineFile: BaselineFile;
  try {
    baselineFile = JSON.parse(baselineRaw) as BaselineFile;
  } catch (err) {
    process.stderr.write(`clawreview baseline diff: invalid baseline JSON (${(err as Error).message})\n`);
    process.exitCode = 2;
    return;
  }
  if (baselineFile.version !== 1 || !Array.isArray(baselineFile.findings)) {
    process.stderr.write('clawreview baseline diff: unsupported baseline file shape\n');
    process.exitCode = 2;
    return;
  }
  const baseline = baselineFile.findings.map((entry) => entry.finding);
  const delta = diffAgainstBaseline(current, baseline);

  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  const c = noColor ? (new Proxy({}, { get: () => (s: string) => s }) as typeof kleur) : kleur;

  process.stdout.write(c.bold('Baseline diff\n'));
  process.stdout.write(`  Baseline:   ${baselinePath} (${baseline.length} findings)\n`);
  process.stdout.write(`  Current:    ${current.length} findings\n`);
  process.stdout.write(`  ${c.red('New')}:        ${delta.added.length}\n`);
  process.stdout.write(`  ${c.green('Resolved')}:   ${delta.removed.length}\n`);
  process.stdout.write(`  Unchanged:  ${delta.unchanged.length}\n`);

  if (delta.added.length > 0) {
    process.stdout.write('\nNew findings:\n');
    for (const f of delta.added) {
      process.stdout.write(
        `  ${c.red('+')} [${f.severity}] ${f.file}:${f.startLine}  ${f.title}  (${f.agent})\n`,
      );
    }
  }
  if (delta.removed.length > 0) {
    process.stdout.write('\nResolved findings:\n');
    for (const f of delta.removed) {
      process.stdout.write(
        `  ${c.green('-')} [${f.severity}] ${f.file}:${f.startLine}  ${f.title}\n`,
      );
    }
  }

  if (args.flags['fail-on-new'] && delta.added.length > 0) {
    process.exitCode = 1;
  }
}

async function loadFindings(args: ParsedArgs): Promise<Finding[] | null> {
  const inputPath = args.flags.input ? String(args.flags.input) : '';
  let raw: string;
  if (inputPath) {
    try {
      raw = await readFile(resolve(inputPath), 'utf8');
    } catch (err) {
      process.stderr.write(`clawreview baseline: cannot read ${inputPath} (${(err as Error).message})\n`);
      process.exitCode = 2;
      return null;
    }
  } else {
    raw = await readStdin();
  }
  if (!raw.trim()) {
    process.stderr.write('clawreview baseline: empty input\n');
    process.exitCode = 2;
    return null;
  }
  let parsed: ReportShape;
  try {
    parsed = JSON.parse(raw) as ReportShape;
  } catch (err) {
    process.stderr.write(`clawreview baseline: invalid JSON (${(err as Error).message})\n`);
    process.exitCode = 2;
    return null;
  }
  return parsed.aggregated?.findings ?? [];
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
