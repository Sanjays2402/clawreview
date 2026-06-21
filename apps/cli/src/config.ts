import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import YAML from 'yaml';
import {
  ClawReviewConfigSchema,
  DEFAULT_CONFIG,
  getPreset,
  mergePresets,
  resolveExtendsChain,
  type ClawReviewConfig,
  type ConfigPreset,
} from '@clawreview/types';

/**
 * Where project-local presets live, relative to the config's cwd.
 *
 * Any `*.yml` / `*.yaml` file in this directory is loaded with its
 * basename (sans extension) as the preset name. Local presets stack
 * with the built-in ones in a single namespace: if `strict.yml` is
 * present locally it shadows the built-in `strict` preset (with a
 * stderr warning so the override is auditable). Unknown preset names
 * in `extends` are still rejected loudly.
 */
const LOCAL_PRESET_DIR = '.clawreview/presets';

/**
 * Load and validate a clawreview config file.
 *
 * Supports an `extends` field (string or string array) that names one or
 * more presets. Presets are merged in order, then the user's own fields
 * layer on top. Arrays REPLACE; objects MERGE (see `mergePresets`). The
 * semantics intentionally mirror tsconfig `extends`.
 *
 * Preset resolution searches two namespaces in order:
 *   1. Project-local presets under `<cwd>/.clawreview/presets/*.yml`
 *      (per-repo customisations, no install required).
 *   2. Built-in presets shipped with `@clawreview/types`.
 *
 * Errors:
 *   - file missing: returns DEFAULT_CONFIG (caller didn't ship a config).
 *   - YAML parse error: surfaces the YAML library's message.
 *   - unknown preset: surfaces `clawreview: unknown preset '<name>'. Available: ...`
 *   - schema validation: surfaces Zod's structured issues via the caller.
 */
export async function loadConfig(path: string | undefined, cwd: string): Promise<ClawReviewConfig> {
  const target = resolve(cwd, path ?? '.clawreview.yml');
  const localPresets = await loadLocalPresets(cwd);
  try {
    const raw = await readFile(target, 'utf8');
    const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
    const merged = mergeWithExtends(parsed, { localPresets });
    return ClawReviewConfigSchema.parse(merged);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_CONFIG;
    }
    throw err;
  }
}

export interface MergeWithExtendsOptions {
  /**
   * Project-local presets to add to the resolution namespace, keyed by
   * preset name. Local presets shadow built-ins on name collision.
   * Omit to use only the built-ins.
   */
  localPresets?: Record<string, ConfigPreset>;
}

/**
 * Strip `extends`, resolve referenced presets, and deep-merge the user's
 * own fields on top. Exposed for tests so we can verify merge semantics
 * without touching the filesystem.
 */
export function mergeWithExtends(
  raw: Record<string, unknown>,
  opts: MergeWithExtendsOptions = {},
): Record<string, unknown> {
  const ext = raw.extends;
  if (ext === undefined || ext === null) {
    return raw;
  }
  const names = Array.isArray(ext) ? ext.map(String) : [String(ext)];
  const resolver = makeResolver(opts.localPresets);
  const presetChain = resolveExtendsChain(names, resolver);
  const { extends: _drop, ...userFields } = raw;
  return mergePresets(presetChain, userFields as ConfigPreset) as Record<string, unknown>;
}

/**
 * Build the resolver function `resolveExtendsChain` calls per name.
 * Project-local presets take precedence over built-ins on collision so
 * teams can override a built-in without renaming it.
 */
function makeResolver(
  localPresets: Record<string, ConfigPreset> | undefined,
): (name: string) => ConfigPreset | undefined {
  if (!localPresets || Object.keys(localPresets).length === 0) {
    return getPreset;
  }
  return (name) => {
    if (Object.prototype.hasOwnProperty.call(localPresets, name)) {
      return localPresets[name];
    }
    return getPreset(name);
  };
}

/**
 * Discover and parse `<cwd>/.clawreview/presets/*.yml` (and `.yaml`)
 * into a `name -> ConfigPreset` map. Each file is loaded leniently:
 *
 *   - The basename (sans extension) becomes the preset name.
 *   - The YAML body is parsed but NOT schema-validated -- presets are
 *     `Partial<ClawReviewConfig>` by design, so a partial shape is fine.
 *     Validation runs against the merged result in `loadConfig`.
 *   - A YAML parse error in any one file aborts the whole discovery with
 *     a helpful message so the user can fix the offender. We prefer
 *     loud failure over silent skip here.
 *   - `extends:` inside a local preset is RESOLVED at discovery time,
 *     not silently stripped. The resolution walks the same (local +
 *     built-in) namespace `loadConfig` uses, with cycle detection. The
 *     resulting preset is the merge of the chain + the file's own
 *     fields, so a downstream consumer sees a flattened preset and
 *     never has to re-resolve.
 *
 * Returns an empty object when the directory does not exist, so the
 * feature is zero-cost for projects that never adopt it.
 */
export async function loadLocalPresets(cwd: string): Promise<Record<string, ConfigPreset>> {
  const dir = resolve(cwd, LOCAL_PRESET_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
  // Load every file's RAW body first (no resolution yet). We need the
  // full namespace available before we can resolve any one preset's
  // extends chain, because a preset can reference another local preset
  // declared in a different file.
  const raw: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yml' && ext !== '.yaml') continue;
    const name = entry.slice(0, entry.length - ext.length);
    if (!name) continue;
    const filePath = resolve(dir, entry);
    let body: unknown;
    let rawText: string;
    try {
      rawText = await readFile(filePath, 'utf8');
    } catch (err) {
      // File appeared in readdir but cannot be read; surface, don't skip.
      throw new Error(
        `clawreview: failed to read local preset '${name}' at ${filePath}: ${(err as Error).message}`,
      );
    }
    try {
      body = YAML.parse(rawText);
    } catch (err) {
      throw new Error(
        `clawreview: invalid YAML in local preset '${name}' at ${filePath}: ${(err as Error).message}`,
      );
    }
    if (body === null || body === undefined) {
      // An empty file resolves to an empty preset.
      raw[name] = {};
      continue;
    }
    if (typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(
        `clawreview: local preset '${name}' at ${filePath} must be a YAML mapping, got ${Array.isArray(body) ? 'array' : typeof body}`,
      );
    }
    raw[name] = body as Record<string, unknown>;
  }

  // Resolve `extends:` for each local preset, walking through both
  // local and built-in namespaces. Cycle detection runs PER preset
  // resolution so two presets that legitimately extend the same base
  // don't trip each other (the cycle set is reset between top-level
  // resolutions, not shared).
  const out: Record<string, ConfigPreset> = {};
  for (const [name, body] of Object.entries(raw)) {
    out[name] = resolveLocalPresetExtends(name, body, raw);
  }
  return out;
}

/**
 * Resolve `extends:` for a single local preset, recursively. Walks the
 * combined (local + built-in) namespace so a local preset can extend
 * another local preset OR a built-in. Local presets shadow built-ins
 * on name collision, consistent with how `mergeWithExtends` resolves
 * them at the top-level.
 *
 * Cycle detection is local to one resolution: a preset cannot
 * (transitively) extend itself. The error message names the cycle so
 * users can find it quickly.
 *
 * Exported for tests so the recursion contract can be exercised
 * without touching the filesystem.
 */
export function resolveLocalPresetExtends(
  presetName: string,
  body: Record<string, unknown>,
  localRaw: Record<string, Record<string, unknown>>,
): ConfigPreset {
  const visiting = new Set<string>();
  return resolveOne(presetName, body, localRaw, visiting);
}

function resolveOne(
  presetName: string,
  body: Record<string, unknown>,
  localRaw: Record<string, Record<string, unknown>>,
  visiting: Set<string>,
): ConfigPreset {
  if (visiting.has(presetName)) {
    const chain = [...visiting, presetName].join(' -> ');
    throw new Error(`clawreview: local preset extends cycle: ${chain}`);
  }
  visiting.add(presetName);

  const ext = body.extends;
  const { extends: _drop, ...own } = body;
  if (ext === undefined || ext === null) {
    visiting.delete(presetName);
    return own as ConfigPreset;
  }

  const names = Array.isArray(ext) ? ext.map(String) : [String(ext)];
  let merged: ConfigPreset = {};
  for (const referenced of names) {
    let resolved: ConfigPreset;
    if (Object.prototype.hasOwnProperty.call(localRaw, referenced)) {
      // Local extends local: recurse so transitive chains flatten too.
      resolved = resolveOne(
        referenced,
        localRaw[referenced]!,
        localRaw,
        visiting,
      );
    } else {
      const builtin = getPreset(referenced);
      if (!builtin) {
        const localNames = Object.keys(localRaw).sort();
        throw new Error(
          `clawreview: local preset '${presetName}' references unknown preset '${referenced}'.` +
            ` Available local: ${localNames.length > 0 ? localNames.join(', ') : '(none)'}.`,
        );
      }
      resolved = builtin;
    }
    merged = mergePresets(merged, resolved);
  }
  // Layer the preset's own fields on top, then leave the visiting set
  // so a sibling top-level resolution can reuse the same name.
  const final = mergePresets(merged, own as ConfigPreset);
  visiting.delete(presetName);
  return final;
}
