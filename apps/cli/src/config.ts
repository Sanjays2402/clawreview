import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import YAML from 'yaml';
import {
  ClawReviewConfigSchema,
  DEFAULT_CONFIG,
  mergePresets,
  resolveExtendsChain,
  type ClawReviewConfig,
  type ConfigPreset,
} from '@clawreview/types';

/**
 * Load and validate a clawreview config file.
 *
 * Supports an `extends` field (string or string array) that names one or
 * more built-in presets. Presets are merged in order, then the user's own
 * fields layer on top. Arrays REPLACE; objects MERGE (see
 * `mergePresets`). The semantics intentionally mirror tsconfig `extends`.
 *
 * Errors:
 *   - file missing: returns DEFAULT_CONFIG (caller didn't ship a config).
 *   - YAML parse error: surfaces the YAML library's message.
 *   - unknown preset: surfaces `clawreview: unknown preset '<name>'. Available: ...`
 *   - schema validation: surfaces Zod's structured issues via the caller.
 */
export async function loadConfig(path: string | undefined, cwd: string): Promise<ClawReviewConfig> {
  const target = resolve(cwd, path ?? '.clawreview.yml');
  try {
    const raw = await readFile(target, 'utf8');
    const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
    const merged = mergeWithExtends(parsed);
    return ClawReviewConfigSchema.parse(merged);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_CONFIG;
    }
    throw err;
  }
}

/**
 * Strip `extends`, resolve referenced presets, and deep-merge the user's
 * own fields on top. Exposed for tests so we can verify merge semantics
 * without touching the filesystem.
 */
export function mergeWithExtends(raw: Record<string, unknown>): Record<string, unknown> {
  const ext = raw.extends;
  if (ext === undefined || ext === null) {
    return raw;
  }
  const names = Array.isArray(ext) ? ext.map(String) : [String(ext)];
  const presetChain = resolveExtendsChain(names);
  const { extends: _drop, ...userFields } = raw;
  return mergePresets(presetChain, userFields as ConfigPreset) as Record<string, unknown>;
}
