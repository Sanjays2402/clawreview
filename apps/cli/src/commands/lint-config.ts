import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { cwd as getCwd } from 'node:process';

import kleur from 'kleur';
import YAML from 'yaml';
import { ClawReviewConfigSchema } from '@clawreview/types';

import type { ParsedArgs } from '../args.js';
import { loadLocalPresets, mergeWithExtends } from '../config.js';

/**
 * `clawreview lint-config [--root <dir>] [--pattern <name>...] [--format text|json]`
 *
 * Find every clawreview config file under <root> and schema-validate
 * each one. Useful for monorepos with per-package configs ("each app
 * ships its own .clawreview.yml -- did anyone break one?").
 *
 * Discovery:
 *   - Recursively walks `<root>` (default: cwd).
 *   - A file matches when its basename equals any `--pattern` arg
 *     (default: `.clawreview.yml`). Repeat the flag for more patterns,
 *     e.g. `--pattern .clawreview.yml --pattern clawreview.config.yml`.
 *   - Skips `node_modules`, `.git`, `dist`, `build`, `.next`, and any
 *     directory under a `.clawreview/presets/` subtree (presets are
 *     validated as part of the file that extends them, not on their own).
 *
 * Validation:
 *   - Resolves `extends:` against the SAME `(built-in + local)` namespace
 *     the runtime uses, scoped per config file's parent directory so a
 *     monorepo where each package ships its own `.clawreview/presets/`
 *     works correctly.
 *   - Reports each file as OK, INVALID (schema errors), or LOAD-FAIL
 *     (YAML parse / unknown preset / I/O error).
 *
 * Output:
 *   - `--format text` (default): per-file status lines plus a summary.
 *   - `--format json`: machine-readable report with `{ files: [...], ok, invalid }`.
 *
 * Exit codes:
 *   - 0 -- every config validated.
 *   - 2 -- at least one config invalid or failed to load.
 *   - 3 -- no config files matched (helps catch typo'd --pattern).
 */
export async function runLintConfig(args: ParsedArgs): Promise<void> {
  const root = resolve(getCwd(), String(args.flags.root ?? '.'));
  const patterns = collectPatterns(args);
  const format = String(args.flags.format ?? 'text') as 'text' | 'json';
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  const c = noColor ? (new Proxy({}, { get: () => (s: string) => s }) as typeof kleur) : kleur;

  const matches = await findConfigFiles(root, patterns);
  if (matches.length === 0) {
    if (format === 'json') {
      process.stdout.write(
        `${JSON.stringify({ root, patterns, files: [], ok: 0, invalid: 0, message: 'no config files matched' }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(
        `clawreview lint-config: no config files matched under ${root} (patterns: ${patterns.join(', ')})\n`,
      );
    }
    process.exitCode = 3;
    return;
  }

  const results: LintResult[] = [];
  for (const file of matches) {
    results.push(await validateOne(file));
  }

  const okCount = results.filter((r) => r.status === 'ok').length;
  const invalidCount = results.length - okCount;

  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          root,
          patterns,
          ok: okCount,
          invalid: invalidCount,
          files: results.map((r) => ({
            file: relative(root, r.file),
            status: r.status,
            errors: r.errors,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const r of results) {
      const rel = relative(root, r.file) || r.file;
      if (r.status === 'ok') {
        process.stdout.write(`${c.green('OK')}     ${rel}\n`);
      } else {
        process.stdout.write(`${c.red('FAIL')}   ${rel}\n`);
        for (const err of r.errors) {
          process.stdout.write(`  ${c.gray('·')} ${err}\n`);
        }
      }
    }
    process.stdout.write(`\n${results.length} file(s) -- ${c.green(`${okCount} ok`)}, ${c.red(`${invalidCount} invalid`)}\n`);
  }

  if (invalidCount > 0) process.exitCode = 2;
}

interface LintResult {
  file: string;
  status: 'ok' | 'invalid';
  errors: string[];
}

function collectPatterns(args: ParsedArgs): string[] {
  // Repeated --pattern flags aren't natively de-duplicated by the
  // simple parseArgs (last write wins), so accept the common cases:
  // a comma-separated string or a single name.
  const raw = args.flags.pattern;
  if (raw === undefined || raw === true) return ['.clawreview.yml'];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage']);

/**
 * Recursive directory walk with skip rules. Async-iterates rather than
 * returning an array so very large monorepos don't blow up memory.
 * Returns absolute paths.
 */
export async function findConfigFiles(root: string, patterns: string[]): Promise<string[]> {
  const matched: string[] = [];
  const patternSet = new Set(patterns);
  await walk(root, patternSet, matched);
  matched.sort();
  return matched;
}

async function walk(dir: string, patterns: Set<string>, out: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      // Skip the presets subtree -- presets are validated through the
      // config files that extend them, not on their own (they're
      // partial-shape by design).
      if (entry === 'presets' && dir.endsWith('.clawreview')) continue;
      await walk(full, patterns, out);
    } else if (s.isFile() && patterns.has(entry)) {
      out.push(full);
    }
  }
}

async function validateOne(file: string): Promise<LintResult> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    return { file, status: 'invalid', errors: [`read failed: ${(err as Error).message}`] };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
  } catch (err) {
    return { file, status: 'invalid', errors: [`yaml parse: ${(err as Error).message}`] };
  }
  // Local presets resolve relative to the config file's parent dir so a
  // monorepo's per-package presets stay scoped to that package.
  const parentDir = file.slice(0, Math.max(0, file.lastIndexOf('/')));
  let localPresets;
  try {
    localPresets = await loadLocalPresets(parentDir);
  } catch (err) {
    return { file, status: 'invalid', errors: [`local presets: ${(err as Error).message}`] };
  }
  let merged: Record<string, unknown>;
  try {
    merged = mergeWithExtends(parsed, { localPresets });
  } catch (err) {
    return { file, status: 'invalid', errors: [(err as Error).message] };
  }
  const result = ClawReviewConfigSchema.safeParse(merged);
  if (!result.success) {
    return {
      file,
      status: 'invalid',
      errors: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }
  return { file, status: 'ok', errors: [] };
}
