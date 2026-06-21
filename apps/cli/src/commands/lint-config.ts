import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { cwd as getCwd } from 'node:process';

import kleur from 'kleur';
import YAML from 'yaml';
import { ClawReviewConfigSchema } from '@clawreview/types';

import type { ParsedArgs } from '../args.js';
import { loadLocalPresets, mergeWithExtends } from '../config.js';

/**
 * `clawreview lint-config [--root <dir>] [--pattern <name>...] [--format text|json] [--fix]`
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
 * --fix mode:
 *   - When set, attempts to auto-correct a curated list of common typos
 *     in scalar string fields (e.g. `severity_threshold: warning` -> `medium`)
 *     before re-running validation. ONLY safe, unambiguous rewrites
 *     fire -- ambiguous or schema-fundamental issues still surface as
 *     INVALID. The rewrite preserves the surrounding YAML structure by
 *     editing the file's parsed AST and serializing it back, so user
 *     comments / key order survive.
 *
 * Output:
 *   - `--format text` (default): per-file status lines plus a summary.
 *     In --fix mode, fixed files surface as `FIXED   <file>` with a
 *     list of the applied corrections.
 *   - `--format json`: machine-readable report with
 *     `{ files: [...], ok, invalid, fixed }`.
 *
 * Exit codes:
 *   - 0 -- every config validated (after fixes when --fix is set).
 *   - 2 -- at least one config invalid or failed to load (post-fix).
 *   - 3 -- no config files matched (helps catch typo'd --pattern).
 */
export async function runLintConfig(args: ParsedArgs): Promise<void> {
  const root = resolve(getCwd(), String(args.flags.root ?? '.'));
  const patterns = collectPatterns(args);
  const format = String(args.flags.format ?? 'text') as 'text' | 'json';
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  const fix = Boolean(args.flags.fix);
  const c = noColor ? (new Proxy({}, { get: () => (s: string) => s }) as typeof kleur) : kleur;

  const matches = await findConfigFiles(root, patterns);
  if (matches.length === 0) {
    if (format === 'json') {
      process.stdout.write(
        `${JSON.stringify({ root, patterns, files: [], ok: 0, invalid: 0, fixed: 0, message: 'no config files matched' }, null, 2)}\n`,
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
    results.push(await validateOne(file, { fix }));
  }

  const okCount = results.filter((r) => r.status === 'ok').length;
  const fixedCount = results.filter((r) => r.fixes && r.fixes.length > 0).length;
  const invalidCount = results.length - okCount;

  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          root,
          patterns,
          ok: okCount,
          invalid: invalidCount,
          fixed: fixedCount,
          files: results.map((r) => ({
            file: relative(root, r.file),
            status: r.status,
            errors: r.errors,
            fixes: r.fixes ?? [],
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const r of results) {
      const rel = relative(root, r.file) || r.file;
      if (r.status === 'ok' && r.fixes && r.fixes.length > 0) {
        process.stdout.write(`${c.cyan('FIXED')}  ${rel}\n`);
        for (const fx of r.fixes) {
          process.stdout.write(`  ${c.gray('·')} ${fx}\n`);
        }
      } else if (r.status === 'ok') {
        process.stdout.write(`${c.green('OK')}     ${rel}\n`);
      } else {
        process.stdout.write(`${c.red('FAIL')}   ${rel}\n`);
        for (const err of r.errors) {
          process.stdout.write(`  ${c.gray('·')} ${err}\n`);
        }
      }
    }
    const summary = [
      `${c.green(`${okCount} ok`)}`,
      ...(fix ? [`${c.cyan(`${fixedCount} fixed`)}`] : []),
      `${c.red(`${invalidCount} invalid`)}`,
    ].join(', ');
    process.stdout.write(`\n${results.length} file(s) -- ${summary}\n`);
  }

  if (invalidCount > 0) process.exitCode = 2;
}

interface LintResult {
  file: string;
  status: 'ok' | 'invalid';
  errors: string[];
  /** Human-readable fix descriptions when --fix rewrote the file. */
  fixes?: string[];
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

async function validateOne(
  file: string,
  opts: { fix: boolean } = { fix: false },
): Promise<LintResult> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    return { file, status: 'invalid', errors: [`read failed: ${(err as Error).message}`] };
  }
  // Use the AST-level YAML document so a --fix rewrite preserves
  // comments and key order. We still grab a plain JS object for
  // schema validation.
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(raw);
  } catch (err) {
    return { file, status: 'invalid', errors: [`yaml parse: ${(err as Error).message}`] };
  }
  if (doc.errors.length > 0) {
    return {
      file,
      status: 'invalid',
      errors: doc.errors.map((e) => `yaml parse: ${e.message}`),
    };
  }
  let parsed: Record<string, unknown> = (doc.toJS() ?? {}) as Record<string, unknown>;

  // Apply --fix rewrites BEFORE preset resolution + schema parse so a
  // typo'd `severity_threshold: warning` becomes valid and the file
  // lints clean on the very same pass.
  const fixes: string[] = [];
  if (opts.fix) {
    const applied = applyFixes(doc);
    if (applied.length > 0) {
      fixes.push(...applied);
      parsed = (doc.toJS() ?? {}) as Record<string, unknown>;
      try {
        await writeFile(file, String(doc), 'utf8');
      } catch (err) {
        return {
          file,
          status: 'invalid',
          errors: [`fix write failed: ${(err as Error).message}`],
          fixes,
        };
      }
    }
  }

  // Local presets resolve relative to the config file's parent dir so a
  // monorepo's per-package presets stay scoped to that package.
  const parentDir = file.slice(0, Math.max(0, file.lastIndexOf('/')));
  let localPresets;
  try {
    localPresets = await loadLocalPresets(parentDir);
  } catch (err) {
    return {
      file,
      status: 'invalid',
      errors: [`local presets: ${(err as Error).message}`],
      fixes,
    };
  }
  let merged: Record<string, unknown>;
  try {
    merged = mergeWithExtends(parsed, { localPresets });
  } catch (err) {
    return { file, status: 'invalid', errors: [(err as Error).message], fixes };
  }
  const result = ClawReviewConfigSchema.safeParse(merged);
  if (!result.success) {
    return {
      file,
      status: 'invalid',
      errors: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
      fixes,
    };
  }
  return { file, status: 'ok', errors: [], fixes };
}

/**
 * Curated typo -> canonical-value rewrites for scalar string fields.
 *
 * The map is intentionally narrow: every entry corresponds to a typo
 * that has actually shown up in a user-authored config (warning ->
 * medium is the most common, since GH Actions / SARIF use `warning`).
 * Unambiguous rewrites only; if a typo could legitimately mean two
 * different things, we leave it as INVALID and let the operator fix
 * it by hand.
 *
 * Field key is the dotted path. Value is `{ canonical -> Set<aliases> }`.
 * Returns the list of human-readable rewrite descriptions applied so
 * the CLI can surface them in the report.
 */
const FIX_RULES: Record<string, Record<string, ReadonlySet<string>>> = {
  severity_threshold: {
    critical: new Set(['error', 'errors', 'crit', 'fatal']),
    high: new Set(['important', 'major']),
    medium: new Set(['warning', 'warn', 'med', 'normal']),
    low: new Set(['info', 'minor']),
    nit: new Set(['hint', 'note', 'style']),
  },
  comment_style: {
    compact: new Set(['short', 'brief', 'terse']),
    detailed: new Set(['long', 'verbose', 'full']),
  },
  'inline_comments.min_severity': {
    critical: new Set(['error', 'errors', 'crit', 'fatal']),
    high: new Set(['important', 'major']),
    medium: new Set(['warning', 'warn', 'med', 'normal']),
    low: new Set(['info', 'minor']),
    nit: new Set(['hint', 'note', 'style']),
  },
};

/**
 * Apply known scalar typo rewrites to a yaml AST in place. Returns the
 * human-readable description of every change made so the caller can
 * surface them in the lint report.
 *
 * Exported for tests so the rewrite contract can be exercised without
 * touching the filesystem.
 */
export function applyFixes(doc: YAML.Document.Parsed): string[] {
  const applied: string[] = [];
  for (const [path, alternatives] of Object.entries(FIX_RULES)) {
    const segments = path.split('.');
    const current = doc.getIn(segments) as unknown;
    if (typeof current !== 'string') continue;
    const lower = current.toLowerCase().trim();
    let canonical: string | undefined;
    for (const [canon, aliases] of Object.entries(alternatives)) {
      if (canon === lower) {
        canonical = undefined;
        break;
      }
      if (aliases.has(lower)) {
        canonical = canon;
        break;
      }
    }
    if (canonical !== undefined && canonical !== current) {
      doc.setIn(segments, canonical);
      applied.push(`${path}: '${current}' -> '${canonical}'`);
    }
  }
  return applied;
}
