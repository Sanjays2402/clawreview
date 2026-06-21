/**
 * Built-in configuration presets.
 *
 * Presets are partial `ClawReviewConfig` shapes that callers can pull in
 * via `extends: ['preset-name']`. The CLI loader (and any other future
 * config consumer — server, dashboard) resolves an `extends` chain by
 * deep-merging the listed presets in order, then layering the user's own
 * fields on top. Arrays REPLACE; objects MERGE. The semantics intentionally
 * mirror tsconfig's `extends`, which most TS users will already have in
 * their muscle memory.
 *
 * Adding a new preset:
 *   1. Add a `Partial<ClawReviewConfig>` entry to PRESETS below.
 *   2. Document it in the inline comment so `clawreview validate` users
 *      can discover it from the source.
 *   3. The CLI auto-picks it up; no other wiring required.
 */
import type { ClawReviewConfig } from './config.js';

export type ConfigPreset = Partial<ClawReviewConfig>;

/**
 * `strict`         — high-bar reviews: critical-only threshold, very low
 *                    per-file cap, inline comments on. Use for release
 *                    branches or third-party-contribution scans.
 * `security-focused`
 *                  — only security-adjacent agents, medium threshold,
 *                    larger per-file cap so big-blast-radius PRs surface
 *                    everything.
 * `accessibility-first`
 *                  — adds the accessibility agent, lowers threshold to
 *                    low so a11y nits are still reported.
 * `permissive`     — only critical issues, drops style noise — good for
 *                    fast-moving exploratory branches.
 * `nit-friendly`   — every agent on, threshold dropped to nit. Use during
 *                    code-review training or pair-review demos.
 */
export const PRESETS: Record<string, ConfigPreset> = {
  strict: {
    severity_threshold: 'low',
    max_findings_per_file: 4,
    comment_style: 'detailed',
    inline_comments: {
      enabled: true,
      min_severity: 'medium',
      max: 20,
    },
    review_limits: {
      max_changed_lines_per_file: 800,
      max_patch_bytes_per_file: 128 * 1024,
      include_generated: false,
    },
  },
  'security-focused': {
    agents: ['security', 'sql-injection', 'secrets'],
    severity_threshold: 'medium',
    max_findings_per_file: 12,
    inline_comments: {
      enabled: true,
      min_severity: 'high',
      max: 20,
    },
  },
  'accessibility-first': {
    agents: ['security', 'performance', 'style', 'accessibility', 'secrets'],
    severity_threshold: 'low',
  },
  permissive: {
    agents: ['security', 'performance', 'secrets'],
    severity_threshold: 'high',
    max_findings_per_file: 6,
  },
  'nit-friendly': {
    agents: ['security', 'performance', 'style', 'accessibility', 'sql-injection', 'secrets'],
    severity_threshold: 'nit',
    max_findings_per_file: 16,
    comment_style: 'detailed',
  },
};

/** Names of built-in presets (sorted for stable display). */
export function listPresets(): string[] {
  return Object.keys(PRESETS).sort();
}

/** Returns the preset by name, or `undefined` if no such preset exists. */
export function getPreset(name: string): ConfigPreset | undefined {
  return PRESETS[name];
}

/**
 * Deep-merge two preset-shaped objects. Arrays from `b` REPLACE arrays in
 * `a`; plain objects MERGE recursively; primitives in `b` win. Used by
 * the CLI loader to compose multiple `extends` entries then layer user
 * values on top.
 */
export function mergePresets(a: ConfigPreset, b: ConfigPreset): ConfigPreset {
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (Array.isArray(v)) {
      out[k] = v.slice();
    } else if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(prev) &&
      prev !== null &&
      typeof prev === 'object'
    ) {
      out[k] = mergePresets(prev as ConfigPreset, v as ConfigPreset);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as ConfigPreset;
}

/**
 * Resolve an `extends` chain into a single merged preset object.
 *
 * The chain is evaluated left-to-right, so the rightmost preset wins on
 * conflicting keys. Unknown preset names throw — fail loudly rather than
 * silently produce a config the user did not ask for.
 *
 * Cycle protection: an `extends` chain that re-references a name already
 * visited throws. Presets are static today (no preset-extends-preset
 * support yet), but the cycle check future-proofs the loader.
 */
export function resolveExtendsChain(
  names: string[],
  resolve: (name: string) => ConfigPreset | undefined = getPreset,
): ConfigPreset {
  const visited = new Set<string>();
  let merged: ConfigPreset = {};
  for (const name of names) {
    if (visited.has(name)) {
      throw new Error(`clawreview: preset cycle detected at '${name}'`);
    }
    visited.add(name);
    const preset = resolve(name);
    if (!preset) {
      const available = listPresets().join(', ');
      throw new Error(
        `clawreview: unknown preset '${name}'. Available: ${available}`,
      );
    }
    merged = mergePresets(merged, preset);
  }
  return merged;
}
