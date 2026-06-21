import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
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
 * `clawreview presets resolve <chain> [--root <dir>] [--format yaml|json|text]`
 *
 * Take an ad-hoc `extends:` chain (e.g. `strict,security-focused`) and
 * print the merged body that `extends: [strict, security-focused]`
 * would produce in `.clawreview.yml`, WITHOUT writing a file. The
 * third sub-command on top of `list` and `show`:
 *
 *   - `list` -- "what presets exist?"
 *   - `show` -- "what does THIS preset look like?"
 *   - `resolve` -- "what does THIS CHAIN of presets look like?"
 *
 * Pairs naturally with `show`: an operator drafting a new config can
 * preview the composed body in one step instead of editing a YAML
 * file just to run `clawreview validate`.
 *
 * Chain parsing accepts both `--chain a,b,c` and a positional argument
 * `clawreview presets resolve a,b,c`, with the positional form taking
 * precedence so the common case ("just paste it on the command line")
 * is the shortest. Names are comma-separated; surrounding whitespace
 * is trimmed; empty entries are rejected up front so a stray trailing
 * comma doesn't silently widen the chain.
 *
 * Resolution uses the same `loadLocalPresets` + built-in registry
 * combo `show` does, with the same shadowing rules (local wins on
 * name collision). Unknown names / cycles surface via
 * `resolveExtendsChain` and exit 2 with the error message.
 *
 * Output:
 *   - `--format yaml` (default): merged body as YAML, suitable for
 *     pasting into `.clawreview.yml`. Header comments record the
 *     chain so the source is auditable.
 *   - `--format json`: { chain, sources, body, fields } for tooling.
 *   - `--format text`: human-readable, color-tagged. Mirrors `show`.
 *
 * Exit codes:
 *   - 0 on success
 *   - 1 when the chain is empty (no positional, no --chain)
 *   - 2 when --format is invalid OR when a name in the chain is
 *     unknown / introduces a cycle. The error message includes the
 *     full chain so a stale alias is easy to spot.
 */
export async function runPresetsResolve(args: ParsedArgs): Promise<void> {
  // Chain can come from a positional ("resolve strict,security-focused")
  // or --chain. Positional wins because it's the shortest form on the
  // shell command line, but --chain is documented so a script that
  // already keys on flags doesn't need a special case.
  const positionalChain = args.positional[1];
  const flagChain = args.flags.chain ? String(args.flags.chain) : '';
  const rawChain = positionalChain ?? flagChain;
  if (!rawChain || rawChain.trim().length === 0) {
    process.stderr.write(
      'clawreview presets resolve: missing <chain> (e.g. `presets resolve strict,security-focused`)\n',
    );
    process.exitCode = 1;
    return;
  }

  const root = String(args.flags.root ?? getCwd());
  const formatRaw = String(args.flags.format ?? 'yaml').toLowerCase();
  if (formatRaw !== 'yaml' && formatRaw !== 'json' && formatRaw !== 'text') {
    process.stderr.write(
      `clawreview presets resolve: --format must be yaml|json|text (got '${formatRaw}')\n`,
    );
    process.exitCode = 2;
    return;
  }
  const format = formatRaw as 'yaml' | 'json' | 'text';
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  if (noColor) kleur.enabled = false;

  // Parse the chain. Comma-separated, trimmed. Empty entries are an
  // error rather than silently widened or dropped: a stray trailing
  // comma usually means the operator forgot a name, and resolving the
  // shorter chain anyway would compose the WRONG config silently.
  const chain = rawChain
    .split(',')
    .map((s) => s.trim());
  if (chain.some((s) => s.length === 0)) {
    process.stderr.write(
      `clawreview presets resolve: chain contains an empty entry ('${rawChain}'); ` +
        `comma-separated names only\n`,
    );
    process.exitCode = 2;
    return;
  }

  const localPresets = await loadLocalPresets(root);
  const builtinNames = listPresets();

  // Per-name source so the JSON output can attribute each chain entry
  // to local / built-in / unknown. resolveExtendsChain itself only
  // returns the merged body.
  const sources: Array<{
    name: string;
    source: 'local' | 'builtin' | 'unknown';
    shadowsBuiltin: boolean;
  }> = chain.map((name) => {
    const local = Object.prototype.hasOwnProperty.call(localPresets, name);
    const builtin = builtinNames.includes(name);
    return {
      name,
      source: local ? 'local' : builtin ? 'builtin' : 'unknown',
      shadowsBuiltin: local && builtin,
    };
  });

  let composed: ConfigPreset;
  try {
    composed = resolveExtendsChain(chain, (n) => {
      if (Object.prototype.hasOwnProperty.call(localPresets, n)) return localPresets[n];
      return getPreset(n);
    });
  } catch (err) {
    // Unknown name OR cycle. Surface the chain in the message so the
    // bad alias is easy to spot when the operator pasted half a dozen
    // names.
    process.stderr.write(
      `clawreview presets resolve: ${(err as Error).message} ` +
        `(chain: ${chain.join(' -> ')})\n`,
    );
    process.exitCode = 2;
    return;
  }

  const fields = populatedKeys(composed);

  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          chain,
          sources,
          fields,
          body: composed,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (format === 'yaml') {
    // YAML is the copy-pasteable shape. Header comments record the
    // chain so a config-file consumer can see what generated the body.
    const header = [
      `# clawreview preset chain: ${chain.join(' -> ')}`,
      `# sources: ${sources
        .map((s) => `${s.name}=${s.source}${s.shadowsBuiltin ? '(shadows)' : ''}`)
        .join(', ')}`,
    ].join('\n');
    const body = YAML.stringify(composed, { lineWidth: 0 });
    process.stdout.write(`${header}\n${body}`);
    return;
  }

  // Text: human-readable. Mirrors `presets show` so an operator can
  // skim the same shape regardless of which sub-command produced it.
  process.stdout.write(
    `${kleur.bold('chain')}: ${chain
      .map((n, i) => {
        const src = sources[i]!;
        const tag =
          src.source === 'local'
            ? src.shadowsBuiltin
              ? kleur.yellow('local*')
              : kleur.cyan('local')
            : src.source === 'builtin'
              ? kleur.green('built-in')
              : kleur.red('unknown');
        return `${n} (${tag})`;
      })
      .join(' -> ')}\n`,
  );
  if (fields.length === 0) {
    process.stdout.write(kleur.gray('  (resolved preset is empty)\n'));
    return;
  }
  process.stdout.write('body:\n');
  for (const key of fields) {
    const v = (composed as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      process.stdout.write(`  ${kleur.bold(key)}: ${String(v)}\n`);
    } else {
      const yaml = YAML.stringify(v, { lineWidth: 0 }).trimEnd();
      const indented = yaml
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      process.stdout.write(`  ${kleur.bold(key)}:\n${indented}\n`);
    }
  }
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

/**
 * `clawreview presets diff <a> <b> [--root <dir>] [--format text|yaml|json]`
 *
 * Field-level delta between two preset chains. Each side is parsed as
 * a comma-separated chain (same shape as `presets resolve`), resolved
 * via the same registry + local-presets path `loadConfig` uses, and
 * then compared key by key.
 *
 *   - `presets diff strict permissive`              -> compare two
 *     single-preset chains
 *   - `presets diff strict,security-focused web`    -> ad-hoc multi-preset
 *     chains on either side
 *
 * The fourth sub-command in the `presets` family:
 *
 *   - `list`    -- what presets exist?
 *   - `show`    -- what does THIS preset look like?
 *   - `resolve` -- what does THIS CHAIN of presets look like?
 *   - `diff`    -- what's the DELTA between two chains?
 *
 * Pairs naturally with `resolve`: an operator preparing to migrate
 * from one base config to another (e.g. switching from `strict` to
 * `web,security-focused` for a new repo class) can preview every
 * field that will change in one step.
 *
 * Output:
 *   - `--format text` (default): per-field block: "key: changed",
 *     "key: only in a", "key: only in b". Color-tagged on a TTY.
 *   - `--format yaml`: a single YAML document with three keys --
 *     `changed`, `only_in_a`, `only_in_b` -- each mapping field name
 *     to the affected value(s). Suitable for copy-pasting into a
 *     migration ticket.
 *   - `--format json`: the same shape as yaml, serialised as JSON for
 *     tooling consumption (e.g. piped through jq).
 *
 * Exit codes:
 *   - 0 when the two chains resolve to identical bodies (no delta).
 *   - 1 when arguments are missing or invalid.
 *   - 2 when a chain entry is unknown or introduces a cycle (same
 *     contract as `presets resolve`).
 *   - 3 when the chains resolve and produce a non-empty delta. This
 *     makes the command CI-gateable ("fail if my preset change altered
 *     anything") without parsing the output.
 *
 * The diff is INTENTIONALLY shallow at the top level (matching the
 * shape of `ConfigPreset` keys). A nested change inside `severity_rules`
 * surfaces as "severity_rules: changed" rather than a fine-grained
 * line-level diff -- a YAML/JSON delta of structured config keys is
 * easier to scan than a per-element rebase. Callers that need the
 * deeper diff can feed the JSON output through jq or a diff tool.
 */
export async function runPresetsDiff(args: ParsedArgs): Promise<void> {
  // Three accepted forms for the two chains:
  //
  //   - Positional:       `presets diff <a> <b>`         (the original)
  //   - Short flags:      `--a <chain> --b <chain>`      (script-friendly)
  //   - Named flags:      `--base <chain> --target <chain>` (tick 13;
  //                       pairs cleanly with shell aliases like
  //                       `alias prdiff='clawreview presets diff
  //                       --base $BASE --target $TARGET'` so a
  //                       reusable wrapper doesn't need to special-case
  //                       positional ordering).
  //
  // The forms are checked positional -> short -> named so the original
  // form keeps winning when the operator passed both (back-compat
  // pinned by a regression test). Mixing forms across the two slots
  // (e.g. positional `<a>` + `--target <b>`) is allowed and natural --
  // a positional first arg with `--target` overriding the second slot
  // is a common shell-alias shape.
  const positionalA = args.positional[1];
  const positionalB = args.positional[2];
  const flagA = args.flags.a ? String(args.flags.a) : '';
  const flagB = args.flags.b ? String(args.flags.b) : '';
  const flagBase = args.flags.base ? String(args.flags.base) : '';
  const flagTarget = args.flags.target ? String(args.flags.target) : '';
  // Pick the first present form per slot. `??` cannot help here
  // because the missing-flag fallback is `''` (truthy for `??`); we
  // explicitly check `.length > 0` so `--base` actually wins when
  // no positional / short flag was supplied.
  const rawA = positionalA ?? (flagA.length > 0 ? flagA : flagBase);
  const rawB = positionalB ?? (flagB.length > 0 ? flagB : flagTarget);
  if (!rawA || rawA.trim().length === 0 || !rawB || rawB.trim().length === 0) {
    process.stderr.write(
      'clawreview presets diff: missing <a> or <b> chain ' +
        '(usage: `presets diff <a> <b>` or `presets diff --base <a> --target <b>`)\n',
    );
    process.exitCode = 1;
    return;
  }

  const root = String(args.flags.root ?? getCwd());
  const formatRaw = String(args.flags.format ?? 'text').toLowerCase();
  if (formatRaw !== 'text' && formatRaw !== 'yaml' && formatRaw !== 'json') {
    process.stderr.write(
      `clawreview presets diff: --format must be text|yaml|json (got '${formatRaw}')\n`,
    );
    process.exitCode = 2;
    return;
  }
  const format = formatRaw as 'text' | 'yaml' | 'json';
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  if (noColor) kleur.enabled = false;

  // Optional --only-fields filter. Restricts the diff to a specific
  // allowlist of top-level keys so an operator preparing a focused
  // migration ticket can scope a wide preset rebase to "only this
  // handful of fields". An empty intermediate entry rejects the chain
  // (same shape contract as `parseChain` for the diff command itself).
  const onlyFieldsRaw =
    typeof args.flags['only-fields'] === 'string'
      ? (args.flags['only-fields'] as string)
      : undefined;
  const onlyFields = parsePresetOnlyFields(onlyFieldsRaw);
  if (onlyFields === ONLY_FIELDS_EMPTY_ENTRY) {
    process.stderr.write(
      `clawreview presets diff: --only-fields contains an empty entry ` +
        `('${onlyFieldsRaw}')\n`,
    );
    process.exitCode = 2;
    return;
  }
  // Optional --exclude-fields filter. Mirror of --only-fields: drops
  // keys from the diff instead of restricting to them. Use case: a
  // wide preset rebase where the operator wants "everything EXCEPT
  // these noisy fields" -- usually fields known to drift for unrelated
  // reasons (e.g. `version`, `last_updated`). Same parser shape so an
  // empty intermediate entry (`a,,b`) rejects the chain rather than
  // silently widening it.
  //
  // Mutually exclusive with --only-fields: combining the two would
  // double-filter (only -> exclude) and silently produce a surprising
  // result; better to refuse loudly and let the operator pick one.
  const excludeFieldsRaw =
    typeof args.flags['exclude-fields'] === 'string'
      ? (args.flags['exclude-fields'] as string)
      : undefined;
  const excludeFields = parsePresetOnlyFields(excludeFieldsRaw);
  if (excludeFields === ONLY_FIELDS_EMPTY_ENTRY) {
    process.stderr.write(
      `clawreview presets diff: --exclude-fields contains an empty entry ` +
        `('${excludeFieldsRaw}')\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (onlyFields !== null && excludeFields !== null) {
    process.stderr.write(
      `clawreview presets diff: --only-fields and --exclude-fields are ` +
        `mutually exclusive; pick one\n`,
    );
    process.exitCode = 2;
    return;
  }
  // `onlyFields` is now either null (no filter) or a Set<string>. Both
  // shapes pass into filterPresetDelta unchanged.

  // Parse both chains. Reuse the same rejection rule as `presets
  // resolve` so an empty intermediate entry never silently widens the
  // chain.
  const chainA = parseChain(rawA);
  const chainB = parseChain(rawB);
  if (chainA === null) {
    process.stderr.write(
      `clawreview presets diff: chain <a> contains an empty entry ('${rawA}')\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (chainB === null) {
    process.stderr.write(
      `clawreview presets diff: chain <b> contains an empty entry ('${rawB}')\n`,
    );
    process.exitCode = 2;
    return;
  }

  const localPresets = await loadLocalPresets(root);

  // Resolve each chain. Unknown names / cycles surface here.
  let bodyA: ConfigPreset;
  let bodyB: ConfigPreset;
  try {
    bodyA = resolveExtendsChain(chainA, (n) => {
      if (Object.prototype.hasOwnProperty.call(localPresets, n)) return localPresets[n];
      return getPreset(n);
    });
  } catch (err) {
    process.stderr.write(
      `clawreview presets diff: <a> ${(err as Error).message} ` +
        `(chain: ${chainA.join(' -> ')})\n`,
    );
    process.exitCode = 2;
    return;
  }
  try {
    bodyB = resolveExtendsChain(chainB, (n) => {
      if (Object.prototype.hasOwnProperty.call(localPresets, n)) return localPresets[n];
      return getPreset(n);
    });
  } catch (err) {
    process.stderr.write(
      `clawreview presets diff: <b> ${(err as Error).message} ` +
        `(chain: ${chainB.join(' -> ')})\n`,
    );
    process.exitCode = 2;
    return;
  }

  // Optional --output: write the JSON / YAML body to a file instead
  // of stdout. Use case: a migration ticket flow where the diff body
  // needs to land on disk for a follow-up commit. The text format
  // doesn't make a useful artifact (it's color-tagged for terminal
  // skimming, not for diffing), so --output requires --format json
  // or --format yaml; --format text + --output exits 2 up front.
  //
  // Path resolution: relative paths land under --root (or cwd when
  // --root is absent) so a caller running `--root project/ --output
  // diff.json` ends up with `project/diff.json` instead of a file in
  // the caller's cwd. Absolute paths bypass the resolve entirely.
  //
  // The literal `-` is a stdout sentinel (tick 13): a CI pipeline
  // that wants the file-write contract -- one body, no kleur
  // headers, no `wrote N bytes` stderr noise -- but doesn't want to
  // allocate a temp file can pass `--output -` to write the body to
  // stdout in "pure mode" (no banner, no preamble). The sentinel
  // composes with json + yaml exactly like a real path; it cannot
  // be combined with --format text for the same reason a real file
  // can't (text is the terminal-display form, not an artifact).
  const outputRaw = args.flags.output;
  const outputIsStdoutSentinel =
    typeof outputRaw === 'string' && outputRaw === '-';
  const outputPath =
    outputIsStdoutSentinel
      ? STDOUT_SENTINEL
      : typeof outputRaw === 'string' && outputRaw.length > 0
        ? resolvePresetDiffOutputPath(outputRaw, root)
        : null;
  if (outputPath !== null && format === 'text') {
    process.stderr.write(
      `clawreview presets diff: --output requires --format json or --format yaml ` +
        `(text output is for terminal display, not artifacts)\n`,
    );
    process.exitCode = 2;
    return;
  }

  const baseDelta = computePresetDelta(bodyA, bodyB);
  // Apply at most one of --only-fields / --exclude-fields (the mutex
  // check earlier already rejected the combo). The two filters share
  // the same parser; the difference is set membership semantics:
  //   --only-fields a,b    -> keep ONLY a and b
  //   --exclude-fields a,b -> keep everything EXCEPT a and b
  let delta: PresetDelta;
  if (onlyFields !== null) {
    delta = filterPresetDelta(baseDelta, onlyFields);
  } else if (excludeFields !== null) {
    delta = filterPresetDeltaExcluding(baseDelta, excludeFields);
  } else {
    delta = baseDelta;
  }

  if (format === 'json') {
    const jsonBody = `${JSON.stringify(
      {
        chainA,
        chainB,
        // Surface the active filter so a downstream tool can verify
        // the diff was scoped (or not). Sorted for deterministic
        // JSON output. Exactly one of `onlyFields` / `excludeFields`
        // can be non-null (the mutex check earlier guaranteed it);
        // both being null means the unfiltered delta.
        onlyFields: onlyFields === null ? null : [...onlyFields].sort(),
        excludeFields: excludeFields === null ? null : [...excludeFields].sort(),
        ...delta,
        hasChanges: hasDelta(delta),
      },
      null,
      2,
    )}\n`;
    if (outputPath !== null) {
      await writePresetDiffOutput(outputPath, jsonBody);
    } else {
      process.stdout.write(jsonBody);
    }
  } else if (format === 'yaml') {
    // Header captures the two chains as comments so a YAML consumer
    // still has the provenance even if it strips the JSON envelope.
    // When --only-fields / --exclude-fields was applied, also annotate
    // it so a reviewer can tell at a glance that the YAML body is scoped.
    const headerLines = [
      `# clawreview presets diff`,
      `# a: ${chainA.join(' -> ')}`,
      `# b: ${chainB.join(' -> ')}`,
    ];
    if (onlyFields !== null) {
      headerLines.push(`# only-fields: ${[...onlyFields].sort().join(', ')}`);
    }
    if (excludeFields !== null) {
      headerLines.push(`# exclude-fields: ${[...excludeFields].sort().join(', ')}`);
    }
    const header = headerLines.join('\n');
    const yamlBody = YAML.stringify(
      {
        changed: delta.changed,
        only_in_a: delta.only_in_a,
        only_in_b: delta.only_in_b,
      },
      { lineWidth: 0 },
    );
    const fullBody = `${header}\n${yamlBody}`;
    if (outputPath !== null) {
      await writePresetDiffOutput(outputPath, fullBody);
    } else {
      process.stdout.write(fullBody);
    }
  } else {
    // Text: per-field render. Empty diff -> friendly "no differences"
    // so the operator doesn't think the command silently no-op'd.
    process.stdout.write(
      `${kleur.bold('chain a')}: ${chainA.join(' -> ')}\n` +
        `${kleur.bold('chain b')}: ${chainB.join(' -> ')}\n`,
    );
    if (onlyFields !== null) {
      process.stdout.write(
        `${kleur.bold('only-fields')}: ${[...onlyFields].sort().join(', ')}\n`,
      );
    }
    if (excludeFields !== null) {
      process.stdout.write(
        `${kleur.bold('exclude-fields')}: ${[...excludeFields].sort().join(', ')}\n`,
      );
    }
    process.stdout.write('\n');
    if (!hasDelta(delta)) {
      // Distinguish "filter excluded everything" from "no real diff"
      // so an operator who scoped down to an empty subset doesn't
      // misread the silence as "the chains agree everywhere".
      if (onlyFields !== null) {
        process.stdout.write(kleur.gray('  (no differences in the filtered fields)\n'));
      } else if (excludeFields !== null) {
        process.stdout.write(kleur.gray('  (no differences outside the excluded fields)\n'));
      } else {
        process.stdout.write(kleur.gray('  (no differences)\n'));
      }
    } else {
      // changed: show both sides inline-ish; nested values use YAML.
      const changedKeys = Object.keys(delta.changed).sort();
      for (const key of changedKeys) {
        const { a, b } = delta.changed[key]!;
        process.stdout.write(`  ${kleur.yellow('changed')} ${kleur.bold(key)}:\n`);
        process.stdout.write(`    a: ${renderInline(a)}\n`);
        process.stdout.write(`    b: ${renderInline(b)}\n`);
      }
      for (const key of Object.keys(delta.only_in_a).sort()) {
        process.stdout.write(
          `  ${kleur.cyan('only in a')} ${kleur.bold(key)}: ` +
            `${renderInline(delta.only_in_a[key])}\n`,
        );
      }
      for (const key of Object.keys(delta.only_in_b).sort()) {
        process.stdout.write(
          `  ${kleur.green('only in b')} ${kleur.bold(key)}: ` +
            `${renderInline(delta.only_in_b[key])}\n`,
        );
      }
    }
  }

  // Exit code 3 on non-empty delta so CI can gate on "did anything
  // change?" without parsing the output. Exit 0 when bodies match.
  // The filter is honored: a delta hidden by `--only-fields` /
  // `--exclude-fields` exits 0 because the operator declared those
  // changes out of scope.
  process.exitCode = hasDelta(delta) ? 3 : 0;
}

/**
 * Parse a comma-separated chain identifier (`"strict,security-focused"`)
 * into a trimmed string array. Returns `null` when any entry is empty
 * (a stray comma usually means a forgotten name; we'd rather refuse
 * than silently widen the chain).
 *
 * Pure / extracted so the `resolve` / `diff` commands share one parser.
 */
function parseChain(raw: string): string[] | null {
  const chain = raw.split(',').map((s) => s.trim());
  if (chain.some((s) => s.length === 0)) return null;
  return chain;
}

/**
 * Per-field delta between two resolved preset bodies.
 *
 * Shape (all three maps are sparse: keys appear only when the diff
 * matches their condition):
 *   - changed:  key -> { a, b }    where bodyA[key] !== bodyB[key]
 *                                  (deep-equality compare)
 *   - only_in_a: key -> bodyA[key] (b doesn't carry this key)
 *   - only_in_b: key -> bodyB[key] (a doesn't carry this key)
 *
 * "Key carries this" is checked via `populatedKeys` (i.e. an undefined
 * value counts as "absent") so a preset that explicitly sets a key to
 * undefined is treated identically to one that never set it.
 *
 * Equality is deep via JSON canonicalisation. Sufficient for
 * `ConfigPreset` (no functions / dates / cycles) and avoids pulling
 * in a deep-equal lib for this one call site.
 */
export interface PresetDelta {
  changed: Record<string, { a: unknown; b: unknown }>;
  only_in_a: Record<string, unknown>;
  only_in_b: Record<string, unknown>;
}

export function computePresetDelta(a: ConfigPreset, b: ConfigPreset): PresetDelta {
  const keysA = new Set(populatedKeys(a));
  const keysB = new Set(populatedKeys(b));
  const out: PresetDelta = { changed: {}, only_in_a: {}, only_in_b: {} };
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  // Union walk so we don't miss either side.
  const allKeys = new Set<string>([...keysA, ...keysB]);
  for (const key of allKeys) {
    if (!keysB.has(key)) {
      out.only_in_a[key] = recA[key];
      continue;
    }
    if (!keysA.has(key)) {
      out.only_in_b[key] = recB[key];
      continue;
    }
    // Both sides have the key; compare structurally.
    if (!deepEqual(recA[key], recB[key])) {
      out.changed[key] = { a: recA[key], b: recB[key] };
    }
  }
  return out;
}

function hasDelta(d: PresetDelta): boolean {
  return (
    Object.keys(d.changed).length > 0 ||
    Object.keys(d.only_in_a).length > 0 ||
    Object.keys(d.only_in_b).length > 0
  );
}

/**
 * Parse a comma-separated `--only-fields` argument into a Set of field
 * names. Pure / extracted so the contract (trimming, de-dup, empty-name
 * rejection) is unit-testable independently of the CLI.
 *
 *   - `--only-fields` unset / empty / whitespace-only -> `null` (no
 *     filter; consumers MUST treat this as "render the whole delta").
 *   - Otherwise -> Set of trimmed names. An empty intermediate entry
 *     (`--only-fields a,,b`) returns the special sentinel
 *     `'EMPTY_ENTRY'` so the caller can refuse the chain rather than
 *     silently widening it. The literal sentinel is intentionally
 *     unrepresentable in a real preset key so a typo cannot collide.
 *
 * The names are NOT validated against the ConfigPreset schema -- the
 * filter is a pure rename of `key in allowSet` and the diff renderer
 * surfaces missing keys naturally (an unknown field never appears in
 * the delta, so the filter just yields an empty result).
 */
export const ONLY_FIELDS_EMPTY_ENTRY = Symbol.for('clawreview.preset.diff.only_fields.empty_entry');

export function parsePresetOnlyFields(
  raw: string | undefined | null,
): Set<string> | typeof ONLY_FIELDS_EMPTY_ENTRY | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split(',').map((s) => s.trim());
  if (parts.some((p) => p.length === 0)) return ONLY_FIELDS_EMPTY_ENTRY;
  // Dedup while preserving caller order. Order isn't user-visible
  // (Sets render alphabetically downstream), but tests pin the
  // de-dup semantics so a `--only-fields a,a,b` works as a single
  // intent rather than a count.
  return new Set(parts);
}

/**
 * Restrict a `PresetDelta` to keys in `fields`. Drops any entry under
 * `changed` / `only_in_a` / `only_in_b` whose key is NOT in the
 * allowlist. Returns a NEW delta object so the caller's input is
 * never mutated.
 *
 * When `fields` is null (no filter set), returns the input unchanged.
 *
 * Use case: an operator preparing a wide config rebase wants to focus
 * the diff to a specific set of fields (`severity_threshold,min_confidence`)
 * so a long-running migration ticket has a focused changelog. Without
 * this filter the diff would surface every unrelated field that happens
 * to have changed across the chain.
 *
 * Pure / exported so the filter contract (sparse maps, no-op on empty
 * filter, preserves shape) is unit-testable independently of the CLI.
 */
export function filterPresetDelta(
  delta: PresetDelta,
  fields: Set<string> | null,
): PresetDelta {
  if (fields === null) return delta;
  const out: PresetDelta = { changed: {}, only_in_a: {}, only_in_b: {} };
  for (const k of Object.keys(delta.changed)) {
    if (fields.has(k)) out.changed[k] = delta.changed[k]!;
  }
  for (const k of Object.keys(delta.only_in_a)) {
    if (fields.has(k)) out.only_in_a[k] = delta.only_in_a[k];
  }
  for (const k of Object.keys(delta.only_in_b)) {
    if (fields.has(k)) out.only_in_b[k] = delta.only_in_b[k];
  }
  return out;
}

/**
 * Drop entries from a `PresetDelta` whose key IS in `fields`. Mirror
 * of `filterPresetDelta`: same shape, opposite set membership. Returns
 * a NEW delta object so the caller's input is never mutated.
 *
 * When `fields` is null (no filter set), returns the input unchanged.
 *
 * Use case: an operator preparing a wide preset rebase wants to drop
 * a handful of noisy fields known to drift for unrelated reasons
 * (e.g. `version`, `last_updated`) so the migration ticket's diff
 * stays focused on the substantive changes.
 *
 * Mutually exclusive with `filterPresetDelta` at the CLI layer (the
 * `runPresetsDiff` mutex check refuses --only-fields + --exclude-fields
 * together) so the two helpers never compose in practice. Keeping
 * them as separate pure functions means a future tick can add a
 * third filter shape (e.g. `--changed-only`) without re-walking the
 * call site's branch logic.
 *
 * Pure / exported so the filter contract (sparse maps, no-op on null
 * filter, preserves shape, immutable input) is unit-testable
 * independently of the CLI.
 */
export function filterPresetDeltaExcluding(
  delta: PresetDelta,
  fields: Set<string> | null,
): PresetDelta {
  if (fields === null) return delta;
  const out: PresetDelta = { changed: {}, only_in_a: {}, only_in_b: {} };
  for (const k of Object.keys(delta.changed)) {
    if (!fields.has(k)) out.changed[k] = delta.changed[k]!;
  }
  for (const k of Object.keys(delta.only_in_a)) {
    if (!fields.has(k)) out.only_in_a[k] = delta.only_in_a[k];
  }
  for (const k of Object.keys(delta.only_in_b)) {
    if (!fields.has(k)) out.only_in_b[k] = delta.only_in_b[k];
  }
  return out;
}

/**
 * Internal sentinel value returned from `resolvePresetDiffOutputPath`
 * (and accepted by `writePresetDiffOutput`) when the caller passed
 * `--output -`. Lives as a Symbol so it can never collide with a real
 * filesystem path (a file literally named `-` is still resolvable by
 * Node, so a string sentinel would be ambiguous).
 *
 * Declared BEFORE `resolvePresetDiffOutputPath` so the resolver can
 * narrow its return type to `PresetDiffOutputTarget` without a
 * forward-reference TDZ trap.
 *
 * Exported on the same module so a downstream consumer (today only
 * the `runPresetsDiff` body) can compare against the same instance
 * the resolver returns, avoiding the magic-string anti-pattern.
 */
export const STDOUT_SENTINEL: unique symbol = Symbol.for(
  'clawreview.preset.diff.output.stdout',
);
export type PresetDiffOutputTarget = string | typeof STDOUT_SENTINEL;

/**
 * Resolve a caller-supplied --output path against `--root` (or cwd
 * when --root is absent) when the path is relative. Absolute paths
 * are kept as-is. Pure / exported so the path-resolution contract
 * (relative-to-root vs absolute) is unit-testable independently of
 * the file write.
 *
 * --root context: `runPresetsDiff` resolves local presets under
 * `<root>/.clawreview/presets/*.yml`, so it's natural for a caller
 * specifying both flags to expect a relative --output to land near
 * that same project root. Without this resolution, the relative
 * path would resolve against the operator's cwd which may not
 * match the project root in a CI checkout.
 *
 * The literal `-` is reserved as the stdout sentinel (tick 13) and
 * is mapped to `STDOUT_SENTINEL` here so a downstream consumer can
 * compare via Symbol identity (`=== STDOUT_SENTINEL`) without the
 * ambiguity of a magic string (a file literally named `-` is still
 * resolvable by Node).
 */
export function resolvePresetDiffOutputPath(
  outputPath: string,
  root: string,
): PresetDiffOutputTarget {
  if (outputPath === '-') return STDOUT_SENTINEL;
  return isAbsolute(outputPath) ? outputPath : resolve(root, outputPath);
}

/**
 * Write the rendered diff body to `outputPath` and surface a single
 * stderr confirmation so the operator can tell at a glance the file
 * landed. The path is resolved relative to the caller's cwd (the
 * runPresetsDiff layer already passed an absolute path when --root
 * applies); we just create any missing intermediate directories so
 * `--output reports/2026-06-21/diff.json` works without a separate
 * `mkdir -p`.
 *
 * When the caller passes the `STDOUT_SENTINEL` (from `--output -`)
 * the body is written straight to stdout in "pure mode": no banner,
 * no header preamble, no `wrote N bytes` stderr noise. This is the
 * file-write contract WITHOUT the file allocation -- useful for a
 * CI pipeline that wants the artifact-shaped body (no kleur color
 * tags, one trailing newline) but doesn't want to manage a temp
 * file. The text format is still rejected up-stream so `--output -`
 * + `--format text` exits 2 the same way `--output diff.txt`
 * `--format text` does.
 *
 * Failures (EACCES, ENOSPC, ...) bubble as exit-2 with the underlying
 * error message so a CI gate using `clawreview presets diff
 * --output ...` sees a useful diagnostic. We don't catch and swallow
 * because the operator explicitly asked for an artifact -- silently
 * dropping it would be worse than the loud failure.
 */
async function writePresetDiffOutput(
  outputPath: PresetDiffOutputTarget,
  body: string,
): Promise<void> {
  if (outputPath === STDOUT_SENTINEL) {
    // Pure-mode stdout write: no preamble, no stderr banner. The
    // body already carries a trailing newline (json: from
    // JSON.stringify+`\n`, yaml: from YAML.stringify) so we don't
    // add one. A downstream `jq` / file redirect gets exactly the
    // bytes a `--output diff.json` would have left on disk.
    process.stdout.write(body);
    return;
  }
  const { mkdir } = await import('node:fs/promises');
  const targetDir = dirname(outputPath);
  // mkdir -p; harmless when the directory already exists.
  await mkdir(targetDir, { recursive: true });
  await writeFile(outputPath, body, 'utf8');
  process.stderr.write(
    `clawreview presets diff: wrote ${body.length} bytes to ${outputPath}\n`,
  );
}

/**
 * JSON-canonical deep equality. ConfigPreset bodies are plain JSON-shaped
 * objects (no functions / dates / cycles), so JSON.stringify with a
 * key-sort replacer reduces structural equality to a single string
 * compare. Adequate for the diff command's "did this field change?"
 * granularity.
 */
function deepEqual(x: unknown, y: unknown): boolean {
  return canonicalJSON(x) === canonicalJSON(y);
}

function canonicalJSON(v: unknown): string {
  return JSON.stringify(v, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = obj[k];
      }
      return sorted;
    }
    return value;
  });
}

/**
 * Render a primitive or nested value on a single text-block line.
 * Primitives use their JSON form; objects / arrays use the YAML form
 * trimmed onto one line for short shapes.
 */
function renderInline(v: unknown): string {
  if (v === undefined) return kleur.gray('<unset>');
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  // YAML.stringify gives the most readable shape for a small object;
  // we trim trailing whitespace + the trailing newline so the line
  // stays compact.
  return YAML.stringify(v, { lineWidth: 0 }).trim().replace(/\n/g, '; ');
}
