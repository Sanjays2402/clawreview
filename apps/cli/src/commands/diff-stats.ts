import { cwd as getCwd } from 'node:process';

import kleur from 'kleur';
import { parseUnifiedDiff, type DiffFile } from '@clawreview/diff';

import type { ParsedArgs } from '../args.js';
import { detectBase, gitDiff } from '../git.js';

/**
 * `clawreview diff-stats` summarises the file/line shape of a diff WITHOUT
 * running any LLM agents. It is intentionally fast (parser only, no I/O
 * beyond `git diff`) so reviewers can answer "how big is this change?"
 * before paying the cost of a full review run.
 *
 * Modes:
 *   text (default)  human-readable table grouped by language and status
 *   json            machine-readable for piping into other tools or CI gates
 *
 * Sources of diff:
 *   --input <path>  read a unified diff from a file (skip git entirely)
 *   --diff -        read a unified diff from stdin
 *   otherwise       run `git diff <base>...<head>` like `clawreview run`
 *
 * Exit codes:
 *   0   stats printed
 *   2   bad input (empty diff, unreadable file, malformed git refs)
 */
export async function runDiffStats(args: ParsedArgs): Promise<void> {
  const format = String(args.flags.format ?? 'text') as 'text' | 'json';
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;

  const diffText = await loadDiff(args);
  if (!diffText.trim()) {
    process.stderr.write('clawreview diff-stats: diff is empty\n');
    process.exitCode = 2;
    return;
  }

  const parsed = parseUnifiedDiff(diffText);
  const stats = computeDiffStats(parsed.files);

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderDiffStatsText(stats, { noColor }));
}

export interface FileStats {
  path: string;
  status: DiffFile['status'];
  language: string;
  isBinary: boolean;
  hunks: number;
  addedLines: number;
  removedLines: number;
  changedLines: number;
}

export interface DiffStats {
  totals: {
    files: number;
    hunks: number;
    addedLines: number;
    removedLines: number;
    changedLines: number;
    binaryFiles: number;
  };
  byStatus: Record<DiffFile['status'], number>;
  byLanguage: Array<{
    language: string;
    files: number;
    addedLines: number;
    removedLines: number;
    changedLines: number;
  }>;
  largestFiles: FileStats[];
  files: FileStats[];
}

/**
 * Pure computation step. Exposed for tests and for callers (e.g. dashboards)
 * that want to render their own view on top of the same numbers.
 */
export function computeDiffStats(files: DiffFile[]): DiffStats {
  const fileStats: FileStats[] = files.map((file) => {
    let added = 0;
    let removed = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.body.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
        else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
      }
    }
    return {
      path: file.path,
      status: file.status,
      language: file.language ?? 'unknown',
      isBinary: file.isBinary,
      hunks: file.hunks.length,
      addedLines: added,
      removedLines: removed,
      changedLines: added + removed,
    };
  });

  const totals = {
    files: fileStats.length,
    hunks: fileStats.reduce((n, f) => n + f.hunks, 0),
    addedLines: fileStats.reduce((n, f) => n + f.addedLines, 0),
    removedLines: fileStats.reduce((n, f) => n + f.removedLines, 0),
    changedLines: fileStats.reduce((n, f) => n + f.changedLines, 0),
    binaryFiles: fileStats.filter((f) => f.isBinary).length,
  };

  const byStatus: Record<DiffFile['status'], number> = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
  };
  for (const f of fileStats) byStatus[f.status] += 1;

  const byLanguageMap = new Map<
    string,
    { files: number; addedLines: number; removedLines: number; changedLines: number }
  >();
  for (const f of fileStats) {
    const cur = byLanguageMap.get(f.language) ?? {
      files: 0,
      addedLines: 0,
      removedLines: 0,
      changedLines: 0,
    };
    cur.files += 1;
    cur.addedLines += f.addedLines;
    cur.removedLines += f.removedLines;
    cur.changedLines += f.changedLines;
    byLanguageMap.set(f.language, cur);
  }
  const byLanguage = [...byLanguageMap.entries()]
    .map(([language, v]) => ({ language, ...v }))
    .sort((a, b) => b.changedLines - a.changedLines || a.language.localeCompare(b.language));

  const largestFiles = [...fileStats]
    .sort((a, b) => b.changedLines - a.changedLines || a.path.localeCompare(b.path))
    .slice(0, 10);

  return {
    totals,
    byStatus,
    byLanguage,
    largestFiles,
    files: fileStats,
  };
}

export interface RenderOpts {
  noColor?: boolean;
}

export function renderDiffStatsText(stats: DiffStats, opts: RenderOpts = {}): string {
  if (opts.noColor) kleur.enabled = false;
  const lines: string[] = [];
  lines.push(kleur.bold('ClawReview diff stats'));
  const t = stats.totals;
  lines.push(
    `  ${t.files} file${t.files === 1 ? '' : 's'}` +
      ` / ${t.hunks} hunk${t.hunks === 1 ? '' : 's'}` +
      ` / ${kleur.green(`+${t.addedLines}`)} ${kleur.red(`-${t.removedLines}`)}` +
      ` (= ${t.changedLines} changed)` +
      (t.binaryFiles > 0 ? `  ${kleur.gray(`(${t.binaryFiles} binary)`)}` : ''),
  );

  const status = stats.byStatus;
  const statusBits = (['added', 'modified', 'deleted', 'renamed', 'copied'] as const)
    .filter((k) => status[k] > 0)
    .map((k) => `${k} ${status[k]}`);
  if (statusBits.length > 0) {
    lines.push(`  ${kleur.gray(statusBits.join('  '))}`);
  }

  if (stats.byLanguage.length > 0) {
    lines.push('');
    lines.push(kleur.bold('By language'));
    const langPad = Math.max(8, ...stats.byLanguage.map((l) => l.language.length));
    for (const l of stats.byLanguage) {
      lines.push(
        `  ${l.language.padEnd(langPad)}  ${String(l.files).padStart(4)} files  ` +
          `${kleur.green(`+${l.addedLines}`)} ${kleur.red(`-${l.removedLines}`)}  ` +
          `${l.changedLines} changed`,
      );
    }
  }

  if (stats.largestFiles.length > 0) {
    lines.push('');
    lines.push(kleur.bold(`Largest files (top ${stats.largestFiles.length})`));
    for (const f of stats.largestFiles) {
      const tag = f.isBinary ? kleur.gray('binary') : kleur.gray(f.status);
      lines.push(
        `  ${kleur.green(`+${f.addedLines}`.padStart(6))} ${kleur.red(`-${f.removedLines}`.padStart(6))}  ` +
          `${tag.padEnd(10)} ${f.path}`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

async function loadDiff(args: ParsedArgs): Promise<string> {
  // Explicit `--input` wins; it lets CI feed a saved diff back through the
  // same renderer without re-running git.
  if (args.flags.input) {
    const { readFile } = await import('node:fs/promises');
    return readFile(String(args.flags.input), 'utf8');
  }
  // `--diff -` reads from stdin. Mirrors the convention many git tools use.
  if (args.flags.diff === '-' || args.flags.diff === true) {
    return readStdin();
  }
  const cwd = getCwd();
  const base = String(args.flags.base ?? (await detectBase(cwd)));
  const head = String(args.flags.head ?? 'HEAD');
  return gitDiff(base, head, cwd);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}
