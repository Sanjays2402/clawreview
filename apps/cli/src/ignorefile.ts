import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseIgnoreFile, type IgnoreRule } from '@clawreview/diff';

/**
 * Default filename for the project-level ignore file. Mirrors the
 * `.gitignore` / `.dockerignore` convention so contributors do not have
 * to learn a new pattern syntax.
 */
export const DEFAULT_IGNORE_FILENAME = '.clawreviewignore';

/**
 * Outcome of attempting to load a `.clawreviewignore` file. We always
 * return a structured result so the caller can log how many patterns
 * were applied (useful for CI debugging) without re-parsing.
 */
export interface LoadedIgnoreFile {
  /** Absolute path read, or `null` when the file did not exist. */
  source: string | null;
  /** Raw glob patterns ready to feed into `filterIgnored`. */
  patterns: string[];
  /** Parsed rules (preserves negation), for callers that need the structured form. */
  rules: IgnoreRule[];
}

/**
 * Read and parse `<cwd>/<filename>` (default `.clawreviewignore`).
 *
 * Returns an empty patterns/rules list when the file is missing. ENOENT
 * is the only swallowed error so a misspelled file path, permission
 * issue, or partial read still surfaces to the caller.
 *
 * The parser is the same one used by the diff package's `filterIgnored`,
 * so the syntax matches `.gitignore` semantics exactly: comments, blank
 * lines, leading `!` for re-include, trailing `/` for directory, leading
 * `/` for repo-root anchoring, bare names match anywhere.
 */
export async function loadClawreviewIgnore(
  cwd: string,
  filename: string = DEFAULT_IGNORE_FILENAME,
): Promise<LoadedIgnoreFile> {
  const target = resolve(cwd, filename);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { source: null, patterns: [], rules: [] };
    }
    throw err;
  }
  const rules = parseIgnoreFile(raw);
  const patterns = rules.map((r) => (r.negate ? `!${r.pattern}` : r.pattern));
  return { source: target, patterns, rules };
}

/**
 * Merge `.clawreviewignore` patterns onto a config's existing `ignore`
 * list. Config-level patterns appear first so they act as the baseline,
 * with the file-level patterns layered on top (later rules win in the
 * underlying `filterIgnored` evaluator). De-duplicates by string value to
 * keep the resulting list compact when the file and config repeat each
 * other.
 */
export function mergeIgnorePatterns(
  configPatterns: readonly string[],
  filePatterns: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...configPatterns, ...filePatterns]) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
