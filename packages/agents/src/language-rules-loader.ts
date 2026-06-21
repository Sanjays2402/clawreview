import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * In-memory cache of language-rule markdown bodies. Keyed by the
 * normalised language string so the same value is reused across every
 * agent call for that language. Resolution is async-safe: concurrent
 * lookups for the same language coalesce on the same Promise.
 */
const cache = new Map<string, Promise<string | null>>();

/**
 * Manual aliases for cases where one .md file covers several languages
 * that share idioms / hazards. Kept inside the loader so callers do not
 * need to know which file backs which language.
 */
const ALIASES: Record<string, string> = {
  javascript: 'typescript',
};

let rulesDirOverride: string | null = null;

/**
 * Test seam: point the loader at a different directory. Pass `null` to
 * restore the default (the `language-rules/` directory shipped next to
 * this source file). Always clears the cache because rules paths change.
 */
export function __setLanguageRulesDir(dir: string | null): void {
  rulesDirOverride = dir;
  cache.clear();
}

function defaultRulesDir(): string {
  // import.meta.url points at .../packages/agents/src/language-rules-loader.ts
  // The companion directory is `language-rules/` in the same folder.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'language-rules');
}

/**
 * Read the `<language>.md` rule sheet from disk and return its text. The
 * first read for each language is cached forever; subsequent reads for
 * the same language return the cached Promise. Missing files resolve to
 * `null` so callers can decide whether to skip injection or render a
 * generic fallback.
 *
 * `language` is matched after lowercasing and alias resolution, so
 * `JavaScript`, `javascript`, and `typescript` all hit `typescript.md`.
 */
export async function loadLanguageRules(language: string | undefined): Promise<string | null> {
  if (!language) return null;
  const normalised = language.toLowerCase();
  const target = ALIASES[normalised] ?? normalised;

  const cached = cache.get(target);
  if (cached) return cached;

  const promise = (async () => {
    const dir = rulesDirOverride ?? defaultRulesDir();
    const path = join(dir, `${target}.md`);
    try {
      const raw = await readFile(path, 'utf8');
      return raw.trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  })();
  cache.set(target, promise);
  return promise;
}

/**
 * Build the section to append to a prompted agent's system prompt. The
 * fenced "Language-specific rules" header lets the model treat these as
 * additional constraints rather than confusing them with the high-level
 * agent description.
 */
export function formatLanguageRulesBlock(rules: string): string {
  return `\n\nLanguage-specific rules (apply these in addition to your agent goal):\n${rules}`;
}
