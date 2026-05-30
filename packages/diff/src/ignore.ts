import { minimatch } from './minimatch.js';

/**
 * Default patterns we always skip. Reviewers rarely want a model burning
 * tokens on lockfiles, build artifacts, or generated bundles.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = Object.freeze([
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/target/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/Cargo.lock',
  '**/go.sum',
  '**/poetry.lock',
  '**/Pipfile.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
]);

export interface IgnoreRule {
  pattern: string;
  negate: boolean;
}

export interface IgnoreOptions {
  includeDefaults?: boolean;
}

/**
 * Parse a .clawreviewignore / .gitignore style payload into rules.
 * Honors:
 *   - blank lines and `#` comments
 *   - leading `!` to negate (re-include) a path
 *   - trailing `/` to mean directory (rewritten as `dir/**`)
 *   - leading `/` to anchor at repo root (rewritten without the slash;
 *     all patterns are matched against repo-root relative paths)
 */
export function parseIgnoreFile(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let pattern = line;
    let negate = false;
    if (pattern.startsWith('!')) {
      negate = true;
      pattern = pattern.slice(1);
    }
    let anchored = false;
    if (pattern.startsWith('/')) {
      anchored = true;
      pattern = pattern.slice(1);
    }
    if (pattern.endsWith('/')) {
      pattern = `${pattern}**`;
    }
    if (!anchored && !pattern.includes('/') && !pattern.startsWith('**/')) {
      // bare names match anywhere in the tree, like gitignore
      pattern = `**/${pattern}`;
    }
    rules.push({ pattern, negate });
  }
  return rules;
}

/**
 * Apply rules to a path. Rules are evaluated in order; later rules win.
 * Returns true when the path should be excluded from review.
 */
export function isIgnored(path: string, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (minimatch(path, rule.pattern)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

/**
 * Filter changed files / hunks by path. Caller supplies user-defined patterns
 * (from `.clawreviewignore` or repo config). Default patterns are layered in
 * unless `includeDefaults: false`.
 */
export function filterIgnored<T extends { path: string }>(
  items: T[],
  patterns: readonly string[] | readonly IgnoreRule[],
  options: IgnoreOptions = {},
): T[] {
  const rules = compileRules(patterns, options);
  if (rules.length === 0) return items;
  return items.filter((item) => !isIgnored(item.path, rules));
}

function compileRules(
  patterns: readonly string[] | readonly IgnoreRule[],
  options: IgnoreOptions,
): IgnoreRule[] {
  const userRules: IgnoreRule[] = patterns.map((p) =>
    typeof p === 'string' ? { pattern: p, negate: false } : p,
  );
  if (options.includeDefaults === false) return userRules;
  const defaults: IgnoreRule[] = DEFAULT_IGNORE_PATTERNS.map((pattern) => ({
    pattern,
    negate: false,
  }));
  // defaults first so user negations can re-include
  return [...defaults, ...userRules];
}
