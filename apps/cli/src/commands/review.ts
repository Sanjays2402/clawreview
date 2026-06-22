import { readFile } from 'node:fs/promises';

import kleur from 'kleur';
import {
  computeDigestDrift,
  findingDigest,
  type FindingDigest,
  type FindingDigestDrift,
} from '@clawreview/aggregator';
import type { Finding } from '@clawreview/types';

import type { ParsedArgs } from '../args.js';

/**
 * Shape this command consumes. Matches the `/api/reviews/:id` DTO that
 * the server returns (which carries `findings` and optionally `digest`)
 * AND the tick-14 `/api/reviews/:id/digest` DTO (which carries
 * `persisted` + `fresh`). Both shapes are accepted so an operator can
 * pipe either endpoint into this command without massaging the body.
 *
 * Optional fields are tolerated as `undefined` so a legacy review
 * record (pre-tick-12) with no persisted digest still produces a
 * useful "every fresh bucket is positive" drift report.
 */
interface DriftReport {
  /** Used by --format text to label the rendered banner. */
  reviewId?: string;
  /** `/api/reviews/:id` shape: live findings + persisted digest. */
  findings?: Finding[];
  digest?: FindingDigest | null;
  /** `/api/reviews/:id/digest` shape (tick 14). */
  persisted?: FindingDigest | null;
  fresh?: FindingDigest;
  drift?: FindingDigestDrift;
}

/**
 * `clawreview review drift [--input <path> | --review <file>] [--format text|json]`
 *
 * Compute and print the drift between a review's persisted digest and
 * a fresh recompute over its current findings.
 *
 * Use case: an operator just bulk-dismissed a swathe of findings and
 * wants to know whether the PR comment header is now stale BEFORE
 * cracking open the dashboard. The CLI keeps the loop tight:
 *
 *     curl -s https://clawreview/api/reviews/abc123 | clawreview review drift
 *     clawreview review drift --input review-abc123.json --format json
 *
 * Two input shapes are accepted:
 *
 *   1. `/api/reviews/:id` body         (carries `findings` and `digest`).
 *      The CLI recomputes `findingDigest(findings)` and diffs against
 *      the persisted digest.
 *   2. `/api/reviews/:id/digest` body  (tick 14; carries `persisted` +
 *      `fresh` directly). The CLI just consumes the already-computed
 *      `drift` if present, otherwise re-derives via `computeDigestDrift`.
 *
 * Output formats:
 *
 *   - `text` (default) -- compact banner: hasDrift, totalDelta,
 *     per-bucket changes. Color-tagged when stdout is a TTY.
 *   - `json` -- the same shape as the server's `/digest` DTO so a
 *     downstream tool can re-consume the artifact identically whether
 *     it came from the server or the CLI.
 *
 * Exit codes:
 *
 *   0 -- no drift (or `--input` body genuinely had no findings).
 *   3 -- drift detected. Mirrors `clawreview presets diff` exit-3
 *        convention so a CI gate can `clawreview review drift ...`
 *        and treat non-zero as "stale; re-run worker".
 *   1 -- empty input.
 *   2 -- invalid JSON / unknown shape.
 *
 * Read order:
 *
 *   1. `--input <path>` if present.
 *   2. Otherwise stdin (drains until EOF, same convention as `explain`).
 */
export async function runReviewDrift(args: ParsedArgs): Promise<void> {
  const inputPath = args.flags.input ? String(args.flags.input) : '';
  const format = String(args.flags.format ?? 'text') as 'text' | 'json';
  if (format !== 'text' && format !== 'json') {
    process.stderr.write(
      `clawreview review drift: invalid --format (use text or json)\n`,
    );
    process.exitCode = 2;
    return;
  }
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  if (noColor) kleur.enabled = false;

  let raw: string;
  if (inputPath) {
    try {
      raw = await readFile(inputPath, 'utf8');
    } catch (err) {
      process.stderr.write(
        `clawreview review drift: cannot read --input '${inputPath}': ${(err as Error).message}\n`,
      );
      process.exitCode = 2;
      return;
    }
  } else {
    raw = await readStdin();
  }
  if (!raw.trim()) {
    process.stderr.write('clawreview review drift: empty input\n');
    process.exitCode = 1;
    return;
  }

  let parsed: DriftReport;
  try {
    parsed = JSON.parse(raw) as DriftReport;
  } catch (err) {
    process.stderr.write(
      `clawreview review drift: invalid JSON (${(err as Error).message})\n`,
    );
    process.exitCode = 2;
    return;
  }

  // Resolve the (persisted, fresh) pair from whichever input shape we
  // were handed. Order matters: a /digest body's persisted+fresh wins
  // over the /api/reviews/:id body's findings+digest (the /digest
  // body is the dedicated DTO, the /reviews/:id body is the
  // recompute fallback).
  let persisted: FindingDigest | null;
  let fresh: FindingDigest;
  if (parsed.fresh) {
    // /digest body. `persisted` may be explicit null (legacy review).
    fresh = parsed.fresh;
    persisted = parsed.persisted ?? null;
  } else if (Array.isArray(parsed.findings)) {
    // /api/reviews/:id body. Recompute fresh with the worker's tick-12
    // / tick-13 cap choices (8/8 + hotspots:true) so the output is
    // byte-identical to the server's /digest response on the same
    // input.
    fresh = findingDigest(parsed.findings, {
      topCategories: 8,
      topAgents: 8,
      hotspots: true,
    });
    persisted = parsed.digest ?? null;
  } else {
    process.stderr.write(
      `clawreview review drift: input lacks both 'fresh' and 'findings' -- ` +
        `expected an /api/reviews/:id or /api/reviews/:id/digest body\n`,
    );
    process.exitCode = 2;
    return;
  }

  // Synthesise an empty persisted when the review pre-dates tick 12.
  // Matches the server route's contract: drift surfaces as "every
  // fresh bucket is a positive delta" instead of throwing.
  const persistedForDrift =
    persisted ?? findingDigest([], { hotspots: false });
  // Honour a pre-computed drift if the input carried one (saves the
  // re-walk; both server and CLI compute it identically by contract).
  const drift = parsed.drift ?? computeDigestDrift(persistedForDrift, fresh);

  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          reviewId: parsed.reviewId ?? null,
          persisted, // echo null vs persisted as-is for legacy detection
          fresh,
          drift,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    renderDriftText(parsed.reviewId ?? null, persisted, fresh, drift);
  }

  // Exit 3 on drift so CI can gate the same way `presets diff` does.
  // 0 when persisted and fresh agree (or when both are empty).
  process.exitCode = drift.hasDrift ? 3 : 0;
}

/**
 * Text renderer for `clawreview review drift`. Compact, terminal-
 * friendly; mirrors the existing `presets diff` text shape so an
 * operator who knows one knows the other.
 */
function renderDriftText(
  reviewId: string | null,
  persisted: FindingDigest | null,
  fresh: FindingDigest,
  drift: FindingDigestDrift,
): void {
  const header = reviewId
    ? `${kleur.bold('review')}: ${reviewId}\n`
    : '';
  process.stdout.write(
    `${header}` +
      `${kleur.bold('persisted')}: ${persisted ? `${persisted.total} findings` : kleur.gray('(legacy: no persisted digest)')}\n` +
      `${kleur.bold('fresh')}:     ${fresh.total} findings\n` +
      `${kleur.bold('totalDelta')}: ${formatDelta(drift.totalDelta)}\n\n`,
  );

  if (!drift.hasDrift) {
    process.stdout.write(`${kleur.gray('  (no drift)')}\n`);
    return;
  }

  // Per-severity (fixed-shape).
  const sevEntries = Object.entries(drift.bySeverityDelta).filter(([, d]) => d !== 0);
  if (sevEntries.length > 0) {
    process.stdout.write(`${kleur.bold('severity')}:\n`);
    for (const [sev, d] of sevEntries) {
      process.stdout.write(`  ${kleur.bold(sev.padEnd(8))} ${formatDelta(d)}\n`);
    }
    process.stdout.write('\n');
  }

  renderSparseBucket('agent', drift.byAgentDelta);
  renderSparseBucket('category', drift.byCategoryDelta as Record<string, number>);
  renderSparseBucket('file', drift.byFileDelta);
  renderSparseBucket('tag', drift.byTagDelta);
}

function renderSparseBucket(
  label: string,
  bucket: Record<string, number>,
): void {
  const keys = Object.keys(bucket).sort();
  if (keys.length === 0) return;
  process.stdout.write(`${kleur.bold(label)}:\n`);
  for (const k of keys) {
    const d = bucket[k] ?? 0;
    process.stdout.write(`  ${k.padEnd(24)} ${formatDelta(d)}\n`);
  }
  process.stdout.write('\n');
}

function formatDelta(d: number): string {
  if (d > 0) return kleur.green(`+${d}`);
  if (d < 0) return kleur.red(`${d}`);
  return kleur.gray('0');
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data;
}
