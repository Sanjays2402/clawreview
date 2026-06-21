import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { cwd as getCwd } from 'node:process';

import kleur from 'kleur';
import YAML from 'yaml';
import {
  getPreset,
  listPresets,
  mergePresets,
  resolveExtendsChain,
  type ConfigPreset,
} from '@clawreview/types';

import type { ParsedArgs } from '../args.js';
import { loadLocalPresets } from '../config.js';

/**
 * `clawreview presets list [--root <dir>] [--format text|json]`
 *
 * Print every preset available in the (built-in + local) namespace,
 * including the declared `extends:` chain for local presets. This is
 * the discoverability surface for tick-6's transitive-extends feature:
 * an operator can now answer "what presets can I extend in this repo?"
 * and "what does `web-strict` actually compose?" without cracking open
 * package source.
 *
 * Discovery:
 *   - Built-in presets come from `@clawreview/types` (always present).
 *   - Local presets come from `<root>/.clawreview/presets/*.yml`
 *     (defaults to cwd). Same resolver `loadConfig` uses, so the
 *     surface matches runtime behaviour.
 *   - On name collision, local shadows built-in -- matches runtime
 *     resolution. The shadowed built-in is hidden from the list and
 *     the local entry is annotated.
 *
 * Output:
 *   - `--format text` (default): one block per preset showing source,
 *     extends chain (if any), and the populated keys.
 *   - `--format json`: `{ presets: [{ name, source, extends, fields }] }`
 *     for tooling / dashboard consumption.
 *
 * Exit code: always 0 unless `--root` cannot be read.
 */
export async function runPresetsList(args: ParsedArgs): Promise<void> {
  const root = String(args.flags.root ?? getCwd());
  const format = String(args.flags.format ?? 'text') as 'text' | 'json';
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  if (noColor) kleur.enabled = false;

  // Resolve both namespaces. The flattened `localPresets` powers the
  // "populated keys" list; the raw extends map gives us the declared
  // chain to render. Two passes keep the rendering logic clean.
  const localPresets = await loadLocalPresets(root);
  const localExtendsByName = await loadLocalPresetDeclaredExtends(root);
  const builtinNames = listPresets();
  const localNames = Object.keys(localPresets).sort();

  // Build the rendered list. Locals shadow built-ins on the same name
  // (matching runtime resolution) so we drop the built-in entry when
  // a local of the same name exists.
  const entries: PresetEntry[] = [];
  const localSet = new Set(localNames);
  for (const name of builtinNames) {
    if (localSet.has(name)) continue;
    const preset = getPreset(name);
    if (!preset) continue;
    entries.push({
      name,
      source: 'builtin',
      extends: [],
      fields: populatedKeys(preset),
    });
  }
  for (const name of localNames) {
    const preset = localPresets[name];
    if (!preset) continue;
    entries.push({
      name,
      source: 'local',
      extends: localExtendsByName[name] ?? [],
      fields: populatedKeys(preset),
      shadowsBuiltin: builtinNames.includes(name),
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          root,
          builtinCount: builtinNames.length,
          localCount: localNames.length,
          presets: entries,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  // Text output: one block per preset. Render is intentionally compact
  // so an operator skimming this in a terminal can spot the preset
  // they want quickly.
  process.stdout.write(
    `${kleur.bold(`ClawReview presets`)}  ${kleur.gray(
      `(${builtinNames.length} built-in, ${localNames.length} local at ${root})`,
    )}\n\n`,
  );
  if (entries.length === 0) {
    process.stdout.write(kleur.gray('  (no presets)\n'));
    return;
  }
  for (const e of entries) {
    const tag =
      e.source === 'local'
        ? e.shadowsBuiltin
          ? kleur.yellow('local (shadows built-in)')
          : kleur.cyan('local')
        : kleur.green('built-in');
    process.stdout.write(`  ${kleur.bold(e.name)}  ${tag}\n`);
    if (e.extends.length > 0) {
      process.stdout.write(`    extends: ${e.extends.join(' -> ')}\n`);
    }
    if (e.fields.length > 0) {
      process.stdout.write(`    sets:    ${e.fields.join(', ')}\n`);
    }
    process.stdout.write('\n');
  }
}

interface PresetEntry {
  name: string;
  source: 'builtin' | 'local';
  /** Declared `extends:` chain (left-to-right). Empty for built-ins. */
  extends: string[];
  /** Top-level field names that the preset (after resolution) populates. */
  fields: string[];
  /** Only set on locals: true if a built-in with the same name exists. */
  shadowsBuiltin?: boolean;
}

/**
 * `clawreview presets show <name> [--root <dir>] [--format text|yaml|json]`
 *
 * Print the fully-resolved (extends-flattened) preset body for a single
 * name, so an operator can preview exactly what fields a config would
 * inherit before adopting it. Built on top of the same resolver
 * `loadConfig` uses, so what `show` prints is what `extends: [name]`
 * would actually produce in `.clawreview.yml`.
 *
 * Discovery:
 *   - Local presets under `<root>/.clawreview/presets/*.yml` (default
 *     root: cwd). Local shadows built-in on name collision -- the
 *     resolution emits a stderr note so the override is auditable.
 *   - Built-in presets shipped with `@clawreview/types`.
 *   - For locals, `extends:` is recursively resolved (transitive chains
 *     are flattened) before printing so the operator sees the final
 *     composed body, not the literal file body.
 *
 * Output:
 *   - `--format yaml` (default): the merged body as YAML, suitable for
 *     pasting into `.clawreview.yml`.
 *   - `--format json`: { name, source, extends, body, fields } for
 *     tooling consumption.
 *   - `--format text`: human-readable, key: value, color-tagged. Best
 *     for skimming in a terminal.
 *
 * Exit codes:
 *   - 0 on success
 *   - 1 when `<name>` does not exist in either namespace. The error
 *     message includes the available names so the operator can correct
 *     a typo without re-running `presets list`.
 *   - 2 when `--format` is invalid.
 */
export async function runPresetsShow(args: ParsedArgs): Promise<void> {
  const name = args.positional[1];
  if (!name) {
    process.stderr.write('clawreview presets show: missing <name> argument\n');
    process.exitCode = 2;
    return;
  }
  const root = String(args.flags.root ?? getCwd());
  const formatRaw = String(args.flags.format ?? 'yaml').toLowerCase();
  if (formatRaw !== 'yaml' && formatRaw !== 'json' && formatRaw !== 'text') {
    process.stderr.write(
      `clawreview presets show: --format must be yaml|json|text (got '${formatRaw}')\n`,
    );
    process.exitCode = 2;
    return;
  }
  const format = formatRaw as 'yaml' | 'json' | 'text';
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  if (noColor) kleur.enabled = false;

  const localPresets = await loadLocalPresets(root);
  const localExtendsByName = await loadLocalPresetDeclaredExtends(root);
  const builtinNames = listPresets();

  // Resolution: local shadows built-in on the same name (matches how
  // loadConfig resolves them). We still surface BOTH the source and
  // (when shadowing) a note so the operator can tell which one they're
  // reading.
  const localHit = Object.prototype.hasOwnProperty.call(localPresets, name)
    ? localPresets[name]
    : undefined;
  const builtinHit = builtinNames.includes(name) ? getPreset(name) : undefined;
  const resolved = localHit ?? builtinHit;
  if (!resolved) {
    const allNames = Array.from(new Set([...builtinNames, ...Object.keys(localPresets)])).sort();
    process.stderr.write(
      `clawreview presets show: unknown preset '${name}'.` +
        ` Available: ${allNames.length > 0 ? allNames.join(', ') : '(none)'}.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const source: 'builtin' | 'local' = localHit ? 'local' : 'builtin';
  const shadowsBuiltin = source === 'local' && builtinNames.includes(name);
  const ext = source === 'local' ? (localExtendsByName[name] ?? []) : [];

  // The body is already extends-flattened for locals (loadLocalPresets
  // does the recursion); for built-ins it has no extends to resolve.
  // We still re-run resolveExtendsChain on the declared chain so the
  // JSON / yaml shape can show what the OPERATOR would actually get
  // if they wrote `extends: <name>` at the top level. That feeds the
  // same `mergePresets` semantics loadConfig uses, with cycle / unknown
  // errors surfacing here too.
  let composed: ConfigPreset;
  try {
    const baseFromExtends = resolveExtendsChain(ext, (n) => {
      if (Object.prototype.hasOwnProperty.call(localPresets, n)) return localPresets[n];
      return getPreset(n);
    });
    composed = mergePresets(baseFromExtends, resolved);
  } catch (err) {
    // A bad extends chain in a local preset surfaces here rather than
    // crashing later; mirror lint-config's exit-2 behaviour for parse
    // / resolution errors.
    process.stderr.write(`clawreview presets show: ${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  const fields = populatedKeys(composed);

  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        { name, source, extends: ext, shadowsBuiltin, fields, body: composed },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (format === 'yaml') {
    // YAML output is the most copy-pasteable: a user can drop it into
    // .clawreview.yml verbatim and get the same configuration. The
    // leading `# clawreview preset <name>` header keeps the source
    // attribution alongside the body without breaking the YAML.
    const header = [
      `# clawreview preset: ${name}`,
      `# source: ${source}${shadowsBuiltin ? ' (shadows built-in)' : ''}`,
      ext.length > 0 ? `# extends: ${ext.join(' -> ')}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const body = YAML.stringify(composed, { lineWidth: 0 });
    process.stdout.write(`${header}\n${body}`);
    return;
  }

  // Text: human-readable, color-tagged. Mirrors the per-preset block
  // from `presets list` but renders the resolved body inline.
  const tag =
    source === 'local'
      ? shadowsBuiltin
        ? kleur.yellow('local (shadows built-in)')
        : kleur.cyan('local')
      : kleur.green('built-in');
  process.stdout.write(`${kleur.bold(name)}  ${tag}\n`);
  if (ext.length > 0) {
    process.stdout.write(`  extends: ${ext.join(' -> ')}\n`);
  }
  if (fields.length === 0) {
    process.stdout.write(kleur.gray('  (preset is empty)\n'));
    return;
  }
  process.stdout.write('  body:\n');
  // Render each top-level field on its own line for fast scanning.
  // Nested objects/arrays use YAML so the structure stays readable
  // without a full pretty-printer.
  for (const key of fields) {
    const v = (composed as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      process.stdout.write(`    ${kleur.bold(key)}: ${String(v)}\n`);
    } else {
      // Indent multi-line YAML output four spaces so it nests under `body:`.
      const yaml = YAML.stringify(v, { lineWidth: 0 }).trimEnd();
      const indented = yaml
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n');
      process.stdout.write(`    ${kleur.bold(key)}:\n${indented}\n`);
    }
  }
}

/**
 * Re-read every `.clawreview/presets/*.yml` under `root` and recover the
 * raw `extends:` value declared in each file. Returned as
 * `{ name -> chain[] }`.
 *
 * `loadLocalPresets` strips `extends:` before returning (it flattens the
 * chain into the preset body), so we can't recover the chain from its
 * output. This helper does the minimal duplicated work to read the
 * declared chain back, no schema validation.
 *
 * Errors are swallowed: a malformed file gives an empty chain so the
 * CLI still renders something useful. `lint-config` is the right place
 * to surface preset parse errors.
 */
async function loadLocalPresetDeclaredExtends(
  root: string,
): Promise<Record<string, string[]>> {
  const dir = resolve(root, '.clawreview/presets');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yml' && ext !== '.yaml') continue;
    const name = entry.slice(0, entry.length - ext.length);
    if (!name) continue;
    const filePath = resolve(dir, entry);
    let body: unknown;
    try {
      const rawText = await readFile(filePath, 'utf8');
      body = YAML.parse(rawText);
    } catch {
      out[name] = [];
      continue;
    }
    if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
      out[name] = [];
      continue;
    }
    const ext_ = (body as Record<string, unknown>).extends;
    if (ext_ === undefined || ext_ === null) {
      out[name] = [];
    } else if (Array.isArray(ext_)) {
      out[name] = ext_.map((x) => String(x));
    } else {
      out[name] = [String(ext_)];
    }
  }
  return out;
}

/** Top-level keys present on a partial-config preset, sorted. */
function populatedKeys(preset: ConfigPreset): string[] {
  return Object.keys(preset)
    .filter((k) => (preset as Record<string, unknown>)[k] !== undefined)
    .sort();
}
