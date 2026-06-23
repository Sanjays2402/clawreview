import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import kleur from 'kleur';
import {
  computeDigestDrift,
  findingDigest,
  type FindingDigest,
  type FindingDigestDrift,
} from '@clawreview/aggregator';
import {
  observeReviewDriftWatchPoll,
  observeReviewFilterReportDiff,
  observeReviewFilterReportDiffDuration,
  type MetricsBundle,
} from '@clawreview/telemetry';
import type { Finding, Severity } from '@clawreview/types';

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
 * `clawreview review drift [--input <path>] [--format text|json]`
 * `clawreview review drift --watch <reviewId> --server <url> [--interval <ms>] [--max-polls <n>]`
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
 *     clawreview review drift --watch abc123 --server https://clawreview
 *
 * Two input shapes are accepted in single-shot mode:
 *
 *   1. `/api/reviews/:id` body         (carries `findings` and `digest`).
 *      The CLI recomputes `findingDigest(findings)` and diffs against
 *      the persisted digest.
 *   2. `/api/reviews/:id/digest` body  (tick 14; carries `persisted` +
 *      `fresh` directly). The CLI just consumes the already-computed
 *      `drift` if present, otherwise re-derives via `computeDigestDrift`.
 *
 * Tick 15: `--watch <reviewId>` poll mode hits the server's
 * `/api/reviews/<id>/digest` endpoint on a configurable interval and
 * re-renders the drift banner on every poll. Designed for on-calls
 * watching a bulk-dismiss roll out in real time. Polling stops when:
 *
 *   - SIGINT (Ctrl-C) -- prints "watch stopped" and exits 0 regardless
 *     of the last drift state. Use case: the operator saw what they
 *     needed.
 *   - `--max-polls <n>` reached. Use case: a CI gate that polls
 *     N times then exits with the LAST drift's exit code (0 / 3).
 *   - A fatal error (network / server / parse). Exit 2; the operator
 *     can re-run.
 *
 * The poll mode re-uses the single-shot rendering paths so the watch
 * loop's output is byte-identical to what `clawreview review drift
 * --input -` would print for the same body. This keeps the visual
 * surface uniform: an operator who knows the single-shot output
 * knows the watch output too.
 *
 * Output formats (both modes):
 *
 *   - `text` (default) -- compact banner: hasDrift, totalDelta,
 *     per-bucket changes. Color-tagged when stdout is a TTY. Watch
 *     mode adds a `--- poll N at <ISO> ---` separator between samples.
 *   - `json` -- the same shape as the server's `/digest` DTO so a
 *     downstream tool can re-consume the artifact identically whether
 *     it came from the server or the CLI. Watch mode emits one JSON
 *     object per poll, newline-delimited (JSONL).
 *
 * Exit codes:
 *
 *   0 -- no drift on the FINAL sample (single-shot or watch). Also
 *        emitted when --max-polls hit and the last sample had no drift.
 *   3 -- drift detected on the FINAL sample. Mirrors `presets diff`
 *        exit-3 so a CI gate can `clawreview review drift --watch ...
 *        --max-polls 10` and treat non-zero as "stale at deadline".
 *   1 -- empty input (single-shot only).
 *   2 -- invalid JSON / unknown shape / network failure / config error.
 *
 * Read order (single-shot):
 *
 *   1. `--input <path>` if present.
 *   2. Otherwise stdin (drains until EOF, same convention as `explain`).
 *
 * Read source (watch):
 *
 *   1. `--watch <reviewId>` MUST be paired with `--server <url>`.
 *   2. Polls `<server>/api/reviews/<reviewId>/digest` every
 *      `--interval <ms>` (default 5000ms, min 250ms).
 *   3. Stops after `--max-polls <n>` (default unlimited; 0 also means
 *      unlimited so a CI pipeline doesn't fall into a no-op loop).
 */
export async function runReviewDrift(args: ParsedArgs): Promise<void> {
  const watchReviewId = typeof args.flags.watch === 'string' ? args.flags.watch.trim() : '';
  if (watchReviewId.length > 0) {
    return runReviewDriftWatch(args, watchReviewId);
  }
  // Tick 22: --base / --target compare mode. When both are set,
  // fetch BOTH reviews' /digest bodies from --server and compute
  // the drift between their `fresh` digests. Use case: an operator
  // who just landed a bug fix wants to know "did the fix actually
  // clear high-confidence high-severity findings?" -- the answer
  // is the drift between the OLD review (--base) and the NEW
  // review (--target).
  const baseId = typeof args.flags.base === 'string' ? args.flags.base.trim() : '';
  const targetId = typeof args.flags.target === 'string' ? args.flags.target.trim() : '';
  if (baseId.length > 0 || targetId.length > 0) {
    return runReviewDriftCompare(args, baseId, targetId);
  }
  return runReviewDriftSingle(args);
}

/**
 * Single-shot drift command -- reads one body, renders, exits.
 * This is the original tick-14 behaviour, factored out so the new
 * watch mode can share rendering helpers without duplication.
 */
async function runReviewDriftSingle(args: ParsedArgs): Promise<void> {
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

  // Tick 20: --min-confidence / --severity-threshold pre-bucket
  // filters. Same semantics as `stats --min-confidence` -- both flow
  // through findingDigest's normaliser so the CLI shares one filter
  // contract with the worker / server route / aggregator.
  //
  // Application rules for `review drift`:
  //   - Input shape /api/reviews/:id (carries `findings`): the CLI
  //     RE-COMPUTES `fresh` over `findings` with the filter applied,
  //     and the drift is computed against the persisted digest as
  //     usual. Use case: an operator wants to preview "would the
  //     header change if we tightened the floor?" without going
  //     through the dashboard.
  //   - Input shape /api/reviews/:id/digest (carries `fresh`): the
  //     filter cannot be applied client-side (we don't have the
  //     findings array). The CLI emits a one-line stderr warning
  //     and ignores the flag, leaving the existing fresh / drift
  //     pair intact. Use case: an operator who already has a /digest
  //     body and forgot the filter should hit the server with
  //     ?minConfidence=... instead.
  const minConfidenceRaw = args.flags['min-confidence'];
  const minConfidence =
    minConfidenceRaw === undefined ? undefined : Number(String(minConfidenceRaw));
  const severityThreshold =
    args.flags['severity-threshold'] === undefined
      ? undefined
      : String(args.flags['severity-threshold']);
  const hasFilter = minConfidence !== undefined || severityThreshold !== undefined;

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
  //
  // Tick 20: when filters are supplied AND we hold the findings array,
  // re-compute fresh from findings with the filters applied. When the
  // input is /digest shape (no findings), filters can't apply
  // client-side -- emit a warning, ignore the flag, keep the existing
  // fresh.
  let persisted: FindingDigest | null;
  let fresh: FindingDigest;
  let filtersApplied = false;
  if (Array.isArray(parsed.findings)) {
    // /api/reviews/:id body. Recompute fresh with the worker's tick-12
    // / tick-13 cap choices (8/8 + hotspots:true) so the output is
    // byte-identical to the server's /digest response on the same
    // input. When --min-confidence / --severity-threshold is set, the
    // filter applies BEFORE the bucket arithmetic (findingDigest's
    // tick-19 / tick-20 contract).
    fresh = findingDigest(parsed.findings, {
      topCategories: 8,
      topAgents: 8,
      hotspots: true,
      minConfidence,
      severityThreshold: severityThreshold as Severity | undefined,
    });
    persisted = parsed.digest ?? null;
    filtersApplied = hasFilter;
  } else if (parsed.fresh) {
    // /digest body. `persisted` may be explicit null (legacy review).
    if (hasFilter) {
      // Filter requested but findings absent. Warn so an operator
      // realises the flag had no effect on this branch and re-hits
      // the server with ?minConfidence=... instead.
      process.stderr.write(
        `clawreview review drift: --min-confidence / --severity-threshold ` +
          `requires the /api/reviews/:id input shape (carries 'findings'); ` +
          `received /api/reviews/:id/digest shape -- filters ignored. ` +
          `Re-request the server with ?minConfidence=... / ?severityThreshold=...\n`,
      );
    }
    fresh = parsed.fresh;
    persisted = parsed.persisted ?? null;
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
  // EXCEPT when filters are applied: the input's drift was computed
  // against the unfiltered fresh, so we always recompute when the
  // CLI ran the filter itself.
  const drift =
    filtersApplied || !parsed.drift
      ? computeDigestDrift(persistedForDrift, fresh)
      : parsed.drift;

  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          reviewId: parsed.reviewId ?? null,
          persisted, // echo null vs persisted as-is for legacy detection
          fresh,
          drift,
          // Tick 20: echo the resolved filters so a CI gate / jq
          // pipeline can verify what the CLI actually applied. The
          // raw operator-supplied severityThreshold is echoed (not
          // the normalised value) so a case-mismatch is detectable.
          // `null` whenever the flag was absent (back-compat shape).
          minConfidence: minConfidence === undefined ? null : minConfidence,
          severityThreshold:
            severityThreshold === undefined ? null : severityThreshold,
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

/**
 * Default poll interval (ms) for `--watch`. Five seconds is the same
 * cadence dashboards typically poll at; chosen so a single operator
 * watching a roll out matches the load profile of a normal dashboard
 * tab.
 */
export const WATCH_DEFAULT_INTERVAL_MS = 5000;
/**
 * Minimum --interval value. Anything tighter would hammer the server
 * with operator-poll traffic without giving the worker time to
 * actually re-process between samples; we'd rather refuse than
 * silently amplify load.
 */
export const WATCH_MIN_INTERVAL_MS = 250;

/**
 * Validation outcome from `parseWatchConfig`. Either a fully-resolved
 * config or one of two error sentinels (separate for the test surface
 * to assert on individually).
 */
export type WatchConfigResult =
  | {
      kind: 'ok';
      serverUrl: string;
      intervalMs: number;
      maxPolls: number;
      format: 'text' | 'json';
      onDrift: string | null;
      onDriftOnce: boolean;
      /**
       * Tick 18: --on-recover <cmd> hook. Fires when the watch loop
       * transitions FROM a drift sample TO a clean (no-drift) sample.
       * Complement of --on-drift; the two hooks compose so an
       * operator can pair a "ping me when this drifts" with a
       * matching "ping me when it recovers" without writing custom
       * stateful glue.
       */
      onRecover: string | null;
    }
  | { kind: 'missing-server'; message: string }
  | { kind: 'invalid-interval'; message: string }
  | { kind: 'invalid-max-polls'; message: string }
  | { kind: 'invalid-format'; message: string }
  | { kind: 'invalid-on-drift'; message: string }
  | { kind: 'invalid-on-recover'; message: string };

/**
 * Pure / exported parser for watch-mode config. Centralised so the
 * shapes (defaults, error sentinels, units) have one test surface.
 *
 * Defaults:
 *   - interval: WATCH_DEFAULT_INTERVAL_MS (5000ms)
 *   - max-polls: 0 (unlimited; matches the CI ergonomics "the loop
 *     stops when SIGINT or fatal error fires, not on a magic count")
 *   - format: 'text'
 *   - on-drift: null (no hook fired)
 *   - on-drift-once: false (hook fires on EVERY drift sample)
 *
 * Validation:
 *   - serverUrl is required; missing/empty -> 'missing-server' sentinel
 *   - intervalMs: must be a finite number >= WATCH_MIN_INTERVAL_MS
 *   - maxPolls: must be a non-negative integer (0 means unlimited)
 *   - format: 'text' | 'json'; anything else -> 'invalid-format'
 *   - onDrift: optional non-empty command string; pure whitespace
 *     rejects (a stray --on-drift= is almost certainly a typo)
 *
 * Server URL is normalised: trailing slashes stripped so callers can
 * compose `${serverUrl}/api/reviews/${id}/digest` without worrying.
 */
export function parseWatchConfig(flags: {
  server?: unknown;
  interval?: unknown;
  'max-polls'?: unknown;
  format?: unknown;
  'on-drift'?: unknown;
  'on-drift-once'?: unknown;
  'on-drift-template'?: unknown;
  'on-recover'?: unknown;
  'on-recover-template'?: unknown;
}): WatchConfigResult {
  const serverRaw = typeof flags.server === 'string' ? flags.server.trim() : '';
  if (serverRaw.length === 0) {
    return {
      kind: 'missing-server',
      message:
        '--watch requires --server <url> (the CLI polls <server>/api/reviews/<id>/digest)',
    };
  }
  // Normalise: drop trailing slashes so `${server}/api/...` stays clean.
  const serverUrl = serverRaw.replace(/\/+$/, '');

  let intervalMs = WATCH_DEFAULT_INTERVAL_MS;
  if (flags.interval !== undefined) {
    const raw = String(flags.interval).trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < WATCH_MIN_INTERVAL_MS) {
      return {
        kind: 'invalid-interval',
        message: `--interval must be a number >= ${WATCH_MIN_INTERVAL_MS} (ms); got '${raw}'`,
      };
    }
    intervalMs = Math.floor(parsed);
  }

  let maxPolls = 0;
  if (flags['max-polls'] !== undefined) {
    const raw = String(flags['max-polls']).trim();
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return {
        kind: 'invalid-max-polls',
        message: `--max-polls must be a non-negative integer (0 = unlimited); got '${raw}'`,
      };
    }
    maxPolls = parsed;
  }

  let format: 'text' | 'json' = 'text';
  if (flags.format !== undefined) {
    const raw = String(flags.format).trim().toLowerCase();
    if (raw !== 'text' && raw !== 'json') {
      return {
        kind: 'invalid-format',
        message: `--format must be text or json (got '${flags.format}')`,
      };
    }
    format = raw;
  }

  // Tick 16: --on-drift <cmd> hook. When a poll surfaces drift,
  // exec <cmd> with the drift report on stdin. A non-string value
  // or a pure-whitespace string is treated as absent. An explicit
  // empty string ('--on-drift=') is rejected as a typo so the
  // operator gets immediate feedback.
  let onDrift: string | null = null;
  if (flags['on-drift'] !== undefined) {
    if (typeof flags['on-drift'] !== 'string') {
      return {
        kind: 'invalid-on-drift',
        message: `--on-drift must be a command string; got ${typeof flags['on-drift']}`,
      };
    }
    const trimmed = flags['on-drift'].trim();
    if (trimmed.length === 0) {
      return {
        kind: 'invalid-on-drift',
        message: `--on-drift requires a non-empty command (e.g. --on-drift 'curl -X POST https://...')`,
      };
    }
    onDrift = trimmed;
  }
  // Tick 17: --on-drift-template <name> expands a named template into
  // a fully-formed curl command targeting an environment-variable
  // webhook URL, so the common case ("ping Slack on drift") doesn't
  // require the operator to wrap their own pipeline.
  //
  // Mutex with --on-drift: a template AND an explicit command at the
  // same time is almost always a typo (the operator probably switched
  // to the template syntax but forgot to remove the old --on-drift
  // value). Refuse loudly.
  //
  // The expansion happens HERE (not at hook-execution time) so the
  // resolved command is visible in the watch loop's logs and so the
  // existing --on-drift hook code path consumes the expanded string
  // unchanged. If the named template's required env var is unset,
  // we surface a clear error at parse-time -- a silent expansion
  // to `$EMPTY_VAR` would mean the curl line silently misfires at
  // runtime with no notification, which defeats the whole point.
  if (flags['on-drift-template'] !== undefined) {
    if (onDrift !== null) {
      return {
        kind: 'invalid-on-drift',
        message:
          '--on-drift-template is mutually exclusive with --on-drift (pick one)',
      };
    }
    if (typeof flags['on-drift-template'] !== 'string') {
      return {
        kind: 'invalid-on-drift',
        message: `--on-drift-template must be a template name string; got ${typeof flags['on-drift-template']}`,
      };
    }
    const name = flags['on-drift-template'].trim();
    if (name.length === 0) {
      return {
        kind: 'invalid-on-drift',
        message: '--on-drift-template requires a template name (one of: slack, webhook)',
      };
    }
    const expanded = expandOnDriftTemplate(name, process.env);
    if (expanded.kind === 'invalid') {
      return { kind: 'invalid-on-drift', message: expanded.message };
    }
    onDrift = expanded.command;
  }
  // --on-drift-once: boolean flag. When set, the hook fires only
  // on the FIRST transition into drift (not on every subsequent
  // drift sample). Useful for "ping me when this finally drifts"
  // rather than "ping me every 5s while it stays drifty".
  const onDriftOnce = flags['on-drift-once'] === true || flags['on-drift-once'] === 'true';

  // Tick 18: --on-recover <cmd> hook. Fires on the transition from
  // a drift sample to a clean sample (recover edge). Complement
  // of --on-drift; the two compose so an operator can wire
  // "page me on drift" and "clear the page on recovery" with two
  // independent hooks.
  //
  // Validation mirrors --on-drift: a non-string value rejects, an
  // empty trimmed string rejects (typo guard). The hook receives
  // the same JSONL payload --on-drift uses, so a single jq /
  // webhook pipeline can consume both. We DO NOT add a sibling
  // --on-recover-once flag in this slice -- the recover edge is
  // already deduped by the "fire only on the drift->clean
  // transition" contract (back-to-back clean samples don't
  // re-fire).
  //
  // Tick 19: --on-recover-template <name> mirrors tick-17's
  // --on-drift-template. Same closed set (slack / webhook), same
  // expansion shape (curl POST to an env-var-stored URL), same
  // mutex contract (a template AND an explicit --on-recover at
  // the same time rejects). The recover-template env vars fall
  // back to the drift-template vars when the recover-specific
  // ones aren't set, so an operator with one Slack channel for
  // BOTH edges doesn't need to set two env vars to the same URL.
  let onRecover: string | null = null;
  if (flags['on-recover'] !== undefined) {
    if (typeof flags['on-recover'] !== 'string') {
      return {
        kind: 'invalid-on-recover',
        message: `--on-recover must be a command string; got ${typeof flags['on-recover']}`,
      };
    }
    const trimmed = flags['on-recover'].trim();
    if (trimmed.length === 0) {
      return {
        kind: 'invalid-on-recover',
        message: `--on-recover requires a non-empty command (e.g. --on-recover 'curl -X POST https://...')`,
      };
    }
    onRecover = trimmed;
  }
  // Tick 19: --on-recover-template <name>. Mirrors --on-drift-template
  // (tick 17) so the operator's mental model carries across both
  // edges of the drift transition.
  if (flags['on-recover-template'] !== undefined) {
    if (onRecover !== null) {
      return {
        kind: 'invalid-on-recover',
        message:
          '--on-recover-template is mutually exclusive with --on-recover (pick one)',
      };
    }
    if (typeof flags['on-recover-template'] !== 'string') {
      return {
        kind: 'invalid-on-recover',
        message: `--on-recover-template must be a template name string; got ${typeof flags['on-recover-template']}`,
      };
    }
    const name = flags['on-recover-template'].trim();
    if (name.length === 0) {
      return {
        kind: 'invalid-on-recover',
        message: '--on-recover-template requires a template name (one of: slack, webhook)',
      };
    }
    const expanded = expandOnRecoverTemplate(name, process.env);
    if (expanded.kind === 'invalid') {
      return { kind: 'invalid-on-recover', message: expanded.message };
    }
    onRecover = expanded.command;
  }

  return {
    kind: 'ok',
    serverUrl,
    intervalMs,
    maxPolls,
    format,
    onDrift,
    onDriftOnce,
    onRecover,
  };
}

/**
 * Closed set of `--on-drift-template` template names. Each template
 * expands to a curl-based pipeline targeting a webhook URL stored in
 * an environment variable; the templates are intentionally minimal
 * (a single curl line, no jq filtering, no fan-out) so an operator
 * who wants more elaborate plumbing can fall back to --on-drift with
 * a raw command string.
 *
 *   - `slack`    -> POST the drift JSON to $SLACK_WEBHOOK_URL.
 *                   Slack's incoming-webhook endpoint accepts an
 *                   arbitrary JSON body and renders the `text` field;
 *                   the template forwards the drift report verbatim
 *                   so the operator gets the raw data without an
 *                   intermediate jq pass.
 *   - `webhook`  -> POST the drift JSON to $WEBHOOK_URL. Generic
 *                   alias for any service that accepts a POST + JSON
 *                   body (Discord webhooks, custom alerting,
 *                   Microsoft Teams, etc.).
 *
 * Exported alongside `expandOnDriftTemplate` so a test can iterate
 * the canonical set without hard-coding the literals.
 */
export const ON_DRIFT_TEMPLATES = ['slack', 'webhook'] as const;
export type OnDriftTemplate = (typeof ON_DRIFT_TEMPLATES)[number];

/**
 * Outcome of expanding `--on-drift-template <name>`. Either a
 * resolved curl command string or a typed error sentinel that the
 * parser surfaces under the existing `invalid-on-drift` kind.
 */
export type OnDriftTemplateExpansion =
  | { kind: 'ok'; command: string }
  | { kind: 'invalid'; message: string };

/**
 * Expand a named `--on-drift-template` into the curl command the
 * watch loop will exec on each drift sample.
 *
 * Validation:
 *   - Unknown template name -> 'invalid' with an enumerated list of
 *     valid names so the operator can fix the typo without guessing.
 *   - Required env var unset (or empty after trim) -> 'invalid' with
 *     a clear "set $X" message. We refuse rather than expanding to
 *     `$EMPTY_VAR` because a silently-misfiring curl would defeat
 *     the whole point of the template (the operator added it to be
 *     notified; surfacing the missing var at parse-time gives them
 *     a chance to fix it before the watch loop drifts unnoticed).
 *
 * Pure: takes the `env` map as an argument so tests can drive every
 * arm without mutating `process.env`. Default callers pass
 * `process.env`.
 *
 * The expansion uses `--data-binary @-` so the drift JSON (which the
 * watch loop already pipes on stdin to --on-drift) is forwarded
 * byte-for-byte to the webhook. `-H 'Content-Type: application/json'`
 * is set so a Slack / Discord / generic webhook recognises the body
 * shape. We do NOT include `--fail` (which would exit non-zero on
 * a 4xx response) because the watch loop's failure-tolerance for
 * --on-drift already surfaces hook errors on stderr.
 */
export function expandOnDriftTemplate(
  name: string,
  env: NodeJS.ProcessEnv,
): OnDriftTemplateExpansion {
  const lower = name.toLowerCase();
  // Resolve the env var name from the template. Each template knows
  // exactly one env var; the closed set keeps the surface tiny.
  let envVar: string;
  switch (lower) {
    case 'slack':
      envVar = 'SLACK_WEBHOOK_URL';
      break;
    case 'webhook':
      envVar = 'WEBHOOK_URL';
      break;
    default:
      return {
        kind: 'invalid',
        message: `unknown --on-drift-template '${name}'; valid: ${ON_DRIFT_TEMPLATES.join(', ')}`,
      };
  }
  const url = (env[envVar] ?? '').trim();
  if (url.length === 0) {
    return {
      kind: 'invalid',
      message:
        `--on-drift-template ${lower} requires \$${envVar} (set it before running the watch loop)`,
    };
  }
  // Build the curl line. Single-quoted URL is safe because we
  // validated the env var is non-empty above; the URL value itself
  // is not shell-escaped (operators are expected to set the env var
  // to a clean URL, same contract as --on-drift's raw command).
  const command =
    `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${url}'`;
  return { kind: 'ok', command };
}

/**
 * Tick 19: Closed set of `--on-recover-template` template names.
 * Same shape as `ON_DRIFT_TEMPLATES` -- the two flags target the
 * two edges of the drift transition with byte-identical
 * resolution semantics, so we share the surface area.
 *
 * Re-exported as a separate tuple (rather than aliasing
 * ON_DRIFT_TEMPLATES) so a future divergence (e.g. an "email"
 * template that only makes sense for recover edges) can land
 * without disturbing the drift surface.
 */
export const ON_RECOVER_TEMPLATES = ['slack', 'webhook'] as const;
export type OnRecoverTemplate = (typeof ON_RECOVER_TEMPLATES)[number];

/**
 * Outcome of expanding `--on-recover-template <name>`. Identical
 * shape to `OnDriftTemplateExpansion`; surfaced under the
 * `invalid-on-recover` kind by the parser so the error path stays
 * symmetric with the drift-template path.
 */
export type OnRecoverTemplateExpansion =
  | { kind: 'ok'; command: string }
  | { kind: 'invalid'; message: string };

/**
 * Expand a named `--on-recover-template` into the curl command the
 * watch loop will exec on the drift -> clean recovery edge.
 *
 * Env-var fallback ladder:
 *   - `slack`   -> $SLACK_RECOVER_WEBHOOK_URL, falling back to
 *                  $SLACK_WEBHOOK_URL when the recover-specific one
 *                  isn't set. An operator with ONE Slack channel
 *                  receiving both drift and recover pings doesn't
 *                  have to duplicate the URL into two env vars.
 *   - `webhook` -> $WEBHOOK_RECOVER_URL, falling back to
 *                  $WEBHOOK_URL. Same logic.
 *
 * The fallback is intentional: operators who want SEPARATE
 * channels for the two edges (a "drift" channel that screams
 * red, a "recover" channel that posts a quieter green message)
 * set both env vars and the recover-specific one wins. Operators
 * who only set the drift var get the same URL for both, which
 * is the most common case in practice (single Slack channel for
 * a small team).
 *
 * Validation:
 *   - Unknown template name rejects with an enumerated list.
 *   - Resolved URL must be non-empty after trim (neither env var
 *     set OR both set to empty/whitespace strings) -> rejects
 *     with a clear "set $X (or $Y as fallback)" message.
 *
 * Pure: takes the `env` map as an argument so tests can drive
 * every arm without mutating `process.env`.
 */
export function expandOnRecoverTemplate(
  name: string,
  env: NodeJS.ProcessEnv,
): OnRecoverTemplateExpansion {
  const lower = name.toLowerCase();
  // Each template resolves a primary + fallback env var. The
  // closed set keeps the surface tiny and the fallback ladder
  // documented at one location.
  let primaryVar: string;
  let fallbackVar: string;
  switch (lower) {
    case 'slack':
      primaryVar = 'SLACK_RECOVER_WEBHOOK_URL';
      fallbackVar = 'SLACK_WEBHOOK_URL';
      break;
    case 'webhook':
      primaryVar = 'WEBHOOK_RECOVER_URL';
      fallbackVar = 'WEBHOOK_URL';
      break;
    default:
      return {
        kind: 'invalid',
        message: `unknown --on-recover-template '${name}'; valid: ${ON_RECOVER_TEMPLATES.join(', ')}`,
      };
  }
  const primary = (env[primaryVar] ?? '').trim();
  const fallback = (env[fallbackVar] ?? '').trim();
  const url = primary.length > 0 ? primary : fallback;
  if (url.length === 0) {
    return {
      kind: 'invalid',
      message:
        `--on-recover-template ${lower} requires \$${primaryVar} ` +
        `(or \$${fallbackVar} as fallback) -- set one before running the watch loop`,
    };
  }
  const command =
    `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${url}'`;
  return { kind: 'ok', command };
}

/**
 * Tick 24: Closed set of `--on-regression-template` template names
 * for the `review drift --base/--target` compare command. Mirrors
 * ON_DRIFT_TEMPLATES / ON_RECOVER_TEMPLATES so an operator's mental
 * model carries across all three hook surfaces.
 *
 * Re-exported as its own tuple so a future divergence (e.g. a
 * regression-only "jira-ticket" template that opens a ticket on
 * positive deltas) can land without disturbing the drift / recover
 * surfaces.
 */
export const ON_REGRESSION_TEMPLATES = ['slack', 'webhook'] as const;
export type OnRegressionTemplate = (typeof ON_REGRESSION_TEMPLATES)[number];

/**
 * Outcome of expanding `--on-regression-template <name>`. Identical
 * shape to `OnDriftTemplateExpansion` / `OnRecoverTemplateExpansion`;
 * surfaced under the existing 'on-regression' error path so the
 * caller doesn't need to learn a new error sentinel.
 */
export type OnRegressionTemplateExpansion =
  | { kind: 'ok'; command: string }
  | { kind: 'invalid'; message: string };

/**
 * Expand a named `--on-regression-template` into the curl command
 * the compare command will exec on a positive-delta regression
 * sample.
 *
 * Env-var fallback ladder (mirrors expandOnRecoverTemplate's
 * recover-specific -> shared pattern):
 *   - `slack`   -> $SLACK_REGRESSION_WEBHOOK_URL, falling back to
 *                  $SLACK_WEBHOOK_URL when the regression-specific
 *                  one isn't set. An operator with ONE Slack channel
 *                  receiving both drift and regression alerts
 *                  doesn't have to duplicate the URL into two env
 *                  vars.
 *   - `webhook` -> $WEBHOOK_REGRESSION_URL, falling back to
 *                  $WEBHOOK_URL. Same logic.
 *
 * The fallback is intentional: operators who want SEPARATE
 * channels (a "drift" channel for digest staleness, a "regression"
 * channel for new findings after a refactor) set both env vars
 * and the regression-specific one wins.
 *
 * Validation:
 *   - Unknown template name rejects with an enumerated list.
 *   - Resolved URL must be non-empty after trim -> rejects with a
 *     clear "set $X (or $Y as fallback)" message.
 *
 * Pure: takes the `env` map as an argument so tests can drive
 * every arm without mutating `process.env`.
 */
export function expandOnRegressionTemplate(
  name: string,
  env: NodeJS.ProcessEnv,
): OnRegressionTemplateExpansion {
  const lower = name.toLowerCase();
  let primaryVar: string;
  let fallbackVar: string;
  switch (lower) {
    case 'slack':
      primaryVar = 'SLACK_REGRESSION_WEBHOOK_URL';
      fallbackVar = 'SLACK_WEBHOOK_URL';
      break;
    case 'webhook':
      primaryVar = 'WEBHOOK_REGRESSION_URL';
      fallbackVar = 'WEBHOOK_URL';
      break;
    default:
      return {
        kind: 'invalid',
        message: `unknown --on-regression-template '${name}'; valid: ${ON_REGRESSION_TEMPLATES.join(', ')}`,
      };
  }
  const primary = (env[primaryVar] ?? '').trim();
  const fallback = (env[fallbackVar] ?? '').trim();
  const url = primary.length > 0 ? primary : fallback;
  if (url.length === 0) {
    return {
      kind: 'invalid',
      message:
        `--on-regression-template ${lower} requires \$${primaryVar} ` +
        `(or \$${fallbackVar} as fallback) -- set one before running the compare command`,
    };
  }
  const command =
    `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${url}'`;
  return { kind: 'ok', command };
}

/**
 * Tick 24: outcome of parsing the `--on-regression` / `--on-regression-template`
 * flag pair for `review drift --base/--target`. Mirrors the shape of
 * the watch-mode template-parser arms so each error surface has a
 * distinct discriminant.
 *
 *   - 'none'    -- neither flag set; no hook fires (back-compat with
 *                  tick 23 compare).
 *   - 'ok'      -- flag pair resolved cleanly. `command` carries the
 *                  shell line the regression executor will exec.
 *   - 'invalid' -- typo / mutex collision / unknown template / env-var
 *                  unset. Caller surfaces `message` on stderr and
 *                  exits 2.
 */
export type OnRegressionParseResult =
  | { kind: 'none' }
  | { kind: 'ok'; command: string }
  | { kind: 'invalid'; message: string };

/**
 * Tick 24: pure parser for the `--on-regression` / `--on-regression-template`
 * flag pair.
 *
 * Validation rules:
 *   - Neither flag set -> 'none' (no hook fires).
 *   - --on-regression empty / non-string after trim -> 'invalid'
 *     (almost always a typo).
 *   - --on-regression-template AND --on-regression both set ->
 *     'invalid' (mutex: pick one).
 *   - --on-regression-template empty / non-string -> 'invalid'.
 *   - --on-regression-template <name> with unknown name -> 'invalid'
 *     with the enumerated valid set.
 *   - --on-regression-template <name> with no env var set -> 'invalid'
 *     with the "set $X" hint.
 *
 * Pure: env is passed as an argument so tests can drive every arm
 * without mutating process.env.
 */
export function parseOnRegressionFlags(input: {
  'on-regression'?: unknown;
  'on-regression-template'?: unknown;
  env: NodeJS.ProcessEnv;
}): OnRegressionParseResult {
  const explicit = input['on-regression'];
  const template = input['on-regression-template'];

  let onRegression: string | null = null;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string') {
      return {
        kind: 'invalid',
        message: `--on-regression must be a command string; got ${typeof explicit}`,
      };
    }
    const trimmed = explicit.trim();
    if (trimmed.length === 0) {
      return {
        kind: 'invalid',
        message: `--on-regression: empty / non-string value (pass a shell command)`,
      };
    }
    onRegression = trimmed;
  }

  if (template !== undefined) {
    if (onRegression !== null) {
      return {
        kind: 'invalid',
        message: '--on-regression-template is mutually exclusive with --on-regression (pick one)',
      };
    }
    if (typeof template !== 'string') {
      return {
        kind: 'invalid',
        message: `--on-regression-template must be a template name string; got ${typeof template}`,
      };
    }
    const name = template.trim();
    if (name.length === 0) {
      return {
        kind: 'invalid',
        message: '--on-regression-template requires a template name (one of: slack, webhook)',
      };
    }
    const expanded = expandOnRegressionTemplate(name, input.env);
    if (expanded.kind === 'invalid') {
      return { kind: 'invalid', message: expanded.message };
    }
    onRegression = expanded.command;
  }

  return onRegression === null ? { kind: 'none' } : { kind: 'ok', command: onRegression };
}

/**
 * Internal seam for the watch loop's HTTP fetch. The default
 * implementation uses the global `fetch`; tests inject a stub that
 * returns canned bodies so the suite doesn't need to boot a real
 * server for every assertion.
 */
export type WatchFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const defaultWatchFetcher: WatchFetcher = (url) =>
  fetch(url).then((r) => ({ ok: r.ok, status: r.status, text: () => r.text() }));

/**
 * Internal seam for the watch loop's sleep. Tests substitute a
 * synchronous resolver so the loop runs instantly.
 */
export type WatchSleeper = (ms: number) => Promise<void>;

const defaultWatchSleeper: WatchSleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Internal seam for the `--on-drift <cmd>` hook executor. Default
 * shells out via `node:child_process` exec, piping the drift report
 * JSON to stdin. Tests inject a stub that records invocations so the
 * suite doesn't spawn real subprocesses.
 *
 * The executor returns the exit code (or null on signal exit) and
 * any stderr text -- the caller logs both at debug visibility so a
 * silent hook failure shows up in the watch banner.
 */
export type WatchOnDriftExecer = (
  cmd: string,
  payload: string,
) => Promise<{ exitCode: number | null; stderr: string }>;

const defaultWatchOnDriftExecer: WatchOnDriftExecer = async (cmd, payload) => {
  // exec runs the cmd in a shell so an operator can pass a pipeline
  // ('jq .totalDelta | curl -X POST ...'). Pipe the payload to stdin
  // for the hook to read.
  const { exec } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = exec(cmd, (err, _stdout, stderr) => {
      if (err) {
        // exec's err.code carries the exit status; fall back to null
        // for signal exits where code is undefined.
        const exitCode = typeof (err as NodeJS.ErrnoException).code === 'number'
          ? Number((err as NodeJS.ErrnoException).code)
          : null;
        resolve({ exitCode, stderr: stderr ? String(stderr) : String(err.message) });
        return;
      }
      resolve({ exitCode: 0, stderr: stderr ? String(stderr) : '' });
    });
    // Pipe the drift JSON into the child's stdin then close so the
    // hook sees EOF and can exit.
    child.stdin?.write(payload);
    child.stdin?.end();
  });
};

/**
 * Watch-mode drift command. Polls `/api/reviews/<id>/digest` on a
 * configurable interval and re-renders the drift banner per sample.
 *
 * Stops when:
 *   - SIGINT (Ctrl-C) -- exit 0
 *   - --max-polls reached -- exit 0/3 based on the LAST sample's drift
 *   - Fatal error (network / server / parse) -- exit 2
 *
 * Output:
 *   - text: same banner as single-shot, with a `--- poll N ---` header
 *     between samples so an operator scrolling back can attribute
 *     each banner.
 *   - json (JSONL): one JSON object per poll, separated by `\n`. The
 *     object shape is { reviewId, poll, persisted, fresh, drift }.
 *
 * Telemetry (tick 17): when `injected.metrics` is supplied, every
 * poll attempt fires `clawreview_review_drift_watch_polls_total{result}`
 * (closed set: ok | drift | error). The bundle is OPTIONAL so an
 * operator who doesn't want to depend on the telemetry counter
 * surface can omit it (the loop simply skips the fire); a production
 * deploy wires a real bundle and the counter shows up on /metrics
 * scrapes for whichever sidecar exports the CLI's metrics. The tests
 * inject a no-op bundle wrapper to assert the fire pattern without
 * spinning up a real Prometheus registry.
 *
 * Exported for unit-test driving; the public CLI uses the default
 * fetcher / sleeper / metrics (none).
 */
export async function runReviewDriftWatch(
  args: ParsedArgs,
  reviewId: string,
  injected?: {
    fetcher?: WatchFetcher;
    sleeper?: WatchSleeper;
    onDriftExecer?: WatchOnDriftExecer;
    metrics?: MetricsBundle;
  },
): Promise<void> {
  const config = parseWatchConfig({
    server: args.flags.server,
    interval: args.flags.interval,
    'max-polls': args.flags['max-polls'],
    format: args.flags.format,
    'on-drift': args.flags['on-drift'],
    'on-drift-once': args.flags['on-drift-once'],
    'on-drift-template': args.flags['on-drift-template'],
    'on-recover': args.flags['on-recover'],
    'on-recover-template': args.flags['on-recover-template'],
  });
  if (config.kind !== 'ok') {
    process.stderr.write(`clawreview review drift: ${config.message}\n`);
    process.exitCode = 2;
    return;
  }
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  if (noColor) kleur.enabled = false;

  const fetcher = injected?.fetcher ?? defaultWatchFetcher;
  const sleeper = injected?.sleeper ?? defaultWatchSleeper;
  const onDriftExecer = injected?.onDriftExecer ?? defaultWatchOnDriftExecer;
  const metrics = injected?.metrics;
  const url = `${config.serverUrl}/api/reviews/${encodeURIComponent(reviewId)}/digest`;

  // SIGINT handling: flip a flag, finish the current iteration, exit
  // 0. We DON'T abort an in-flight HTTP request because the next
  // iteration's poll would have raced anyway -- the cleanup path
  // stays small.
  let stopped = false;
  const onSigint = (): void => {
    stopped = true;
  };
  process.once('SIGINT', onSigint);

  // Track the FINAL sample's drift state so the exit code reflects
  // the latest snapshot (single-shot's contract carried up to watch).
  let lastHasDrift = false;
  let pollCount = 0;
  // Tick 16: --on-drift bookkeeping. `firedOnce` flips true the first
  // time the hook fires; --on-drift-once gates subsequent fires off
  // it so an "alert me when this finally drifts" workflow doesn't
  // get spammed on every poll while it stays drifty.
  let onDriftFiredOnce = false;
  // Tick 18: --on-recover bookkeeping. Tracks whether the PREVIOUS
  // sample was drifty so we can detect the drift->clean transition.
  // We deliberately don't fire on the first clean sample if there
  // was no preceding drift sample (i.e. the watch loop started
  // clean) -- recover semantics require a drift to recover FROM.
  let prevHadDrift = false;
  try {
    while (!stopped) {
      pollCount += 1;
      let body: DriftReport;
      try {
        const res = await fetcher(url);
        if (!res.ok) {
          // Tick 17: counter fire on HTTP non-2xx -- counts as 'error'
          // because the watch loop exits 2 after this branch. We fire
          // BEFORE writing to stderr so a test that asserts the
          // metric pattern sees it regardless of stderr ordering.
          if (metrics) observeReviewDriftWatchPoll(metrics, false, null);
          process.stderr.write(
            `clawreview review drift --watch: poll ${pollCount} got HTTP ${res.status}; aborting\n`,
          );
          process.exitCode = 2;
          return;
        }
        const text = await res.text();
        body = JSON.parse(text) as DriftReport;
      } catch (err) {
        // Tick 17: counter fire on fetch / parse failure -- 'error'.
        if (metrics) observeReviewDriftWatchPoll(metrics, false, null);
        process.stderr.write(
          `clawreview review drift --watch: poll ${pollCount} failed: ${(err as Error).message}\n`,
        );
        process.exitCode = 2;
        return;
      }

      // Resolve persisted/fresh/drift using the same logic the
      // single-shot path uses; both /digest and /reviews/:id bodies
      // are accepted so an alternate server endpoint can be polled.
      let persisted: FindingDigest | null;
      let fresh: FindingDigest;
      if (body.fresh) {
        fresh = body.fresh;
        persisted = body.persisted ?? null;
      } else if (Array.isArray(body.findings)) {
        fresh = findingDigest(body.findings, {
          topCategories: 8,
          topAgents: 8,
          hotspots: true,
        });
        persisted = body.digest ?? null;
      } else {
        // Tick 17: counter fire on shape rejection -- 'error'.
        if (metrics) observeReviewDriftWatchPoll(metrics, false, null);
        process.stderr.write(
          `clawreview review drift --watch: poll ${pollCount} body lacks both 'fresh' and 'findings'\n`,
        );
        process.exitCode = 2;
        return;
      }
      const persistedForDrift =
        persisted ?? findingDigest([], { hotspots: false });
      const drift = body.drift ?? computeDigestDrift(persistedForDrift, fresh);
      lastHasDrift = drift.hasDrift;
      // Tick 17: fire the per-poll counter on the success path. The
      // result label is derived from drift.hasDrift via the closed
      // {ok, drift} set; the error label is fired on the failure
      // branches above. We fire BEFORE writing the banner so a
      // test asserting the metric pattern sees it before stdout.
      if (metrics) observeReviewDriftWatchPoll(metrics, true, drift);

      if (config.format === 'json') {
        // JSONL: one object per poll, newline-delimited so a
        // downstream consumer can pipe through `jq -c .`.
        process.stdout.write(
          `${JSON.stringify({
            reviewId,
            poll: pollCount,
            persisted,
            fresh,
            drift,
          })}\n`,
        );
      } else {
        // Text: prefix each sample with a `--- poll N ---` header so
        // an operator scrolling back can attribute the banner.
        process.stdout.write(
          `${kleur.gray(`--- poll ${pollCount} at ${new Date().toISOString()} ---`)}\n`,
        );
        renderDriftText(reviewId, persisted, fresh, drift);
      }

      // Tick 16: --on-drift hook. Fires on drift samples; suppressed
      // when --on-drift-once is set AND the hook has already fired
      // once during this watch session. The hook receives the same
      // JSONL shape as `--format json` on stdin so a single jq /
      // curl / Slack-webhook pipeline can consume both the watch
      // output and the hook payload identically.
      if (config.onDrift !== null && drift.hasDrift) {
        const shouldFire = !config.onDriftOnce || !onDriftFiredOnce;
        if (shouldFire) {
          const payload = JSON.stringify({
            reviewId,
            poll: pollCount,
            persisted,
            fresh,
            drift,
          });
          const hookResult = await onDriftExecer(config.onDrift, payload);
          onDriftFiredOnce = true;
          if (hookResult.exitCode !== 0) {
            // Surface a hook failure to stderr so an operator sees
            // it inline rather than discovering hours later that no
            // alerts went out. We don't abort the watch loop on a
            // hook failure -- the polls are still useful even if
            // the side-channel notification didn't land.
            process.stderr.write(
              `clawreview review drift --watch: on-drift hook exited ${hookResult.exitCode ?? 'null'}` +
                `${hookResult.stderr ? `: ${hookResult.stderr.trim()}` : ''}\n`,
            );
          }
        }
      }

      // Tick 18: --on-recover hook. Fires on the drift->clean edge
      // (i.e. this sample is clean AND the prior sample was drifty).
      // The hook reuses the same exec / payload shape as --on-drift so
      // a unified webhook consumer can branch on `drift.hasDrift`.
      // Recover failures surface on stderr but don't abort -- same
      // failure-tolerance contract as --on-drift.
      if (config.onRecover !== null && !drift.hasDrift && prevHadDrift) {
        const payload = JSON.stringify({
          reviewId,
          poll: pollCount,
          persisted,
          fresh,
          drift,
        });
        const hookResult = await onDriftExecer(config.onRecover, payload);
        if (hookResult.exitCode !== 0) {
          process.stderr.write(
            `clawreview review drift --watch: on-recover hook exited ${hookResult.exitCode ?? 'null'}` +
              `${hookResult.stderr ? `: ${hookResult.stderr.trim()}` : ''}\n`,
          );
        }
      }
      // Update the edge-tracker AFTER both hooks ran so a within-poll
      // restart can't accidentally skip the transition.
      prevHadDrift = drift.hasDrift;

      // Stop check BEFORE sleep so --max-polls 1 doesn't waste an
      // interval between the only sample and the exit.
      if (config.maxPolls > 0 && pollCount >= config.maxPolls) {
        break;
      }
      if (stopped) break;
      await sleeper(config.intervalMs);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  if (stopped) {
    process.stdout.write(`${kleur.gray('watch stopped')}\n`);
    // Stopped by SIGINT -- exit 0 regardless of last drift state.
    process.exitCode = 0;
    return;
  }
  // Stopped by --max-polls -- exit reflects last sample.
  process.exitCode = lastHasDrift ? 3 : 0;
}

/**
 * Tick 22: validation outcome for `runReviewDriftCompare`. Either a
 * fully-resolved config or one of the error sentinels.
 *
 * Mirrors `WatchConfigResult`'s discriminated-union shape so the
 * test surface can pin each error arm individually.
 */
export type CompareConfigResult =
  | {
      kind: 'ok';
      serverUrl: string;
      baseId: string;
      targetId: string;
      format: 'text' | 'json';
    }
  | { kind: 'missing-base'; message: string }
  | { kind: 'missing-target'; message: string }
  | { kind: 'missing-server'; message: string }
  | { kind: 'invalid-format'; message: string };

/**
 * Tick 22: pure parser for `review drift --base / --target` config.
 *
 * Exported so the same shape (defaults, error sentinels) has one
 * test surface. Mirrors `parseWatchConfig` patterns: each error arm
 * is a distinct discriminant; the happy path returns a fully-typed
 * shape.
 */
export function parseCompareConfig(flags: {
  base?: unknown;
  target?: unknown;
  server?: unknown;
  format?: unknown;
}): CompareConfigResult {
  const baseId = typeof flags.base === 'string' ? flags.base.trim() : '';
  if (baseId.length === 0) {
    return {
      kind: 'missing-base',
      message:
        '--base <reviewId> is required for two-review compare mode (saw empty / non-string value)',
    };
  }
  const targetId = typeof flags.target === 'string' ? flags.target.trim() : '';
  if (targetId.length === 0) {
    return {
      kind: 'missing-target',
      message:
        '--target <reviewId> is required for two-review compare mode (saw empty / non-string value)',
    };
  }
  const serverRaw = typeof flags.server === 'string' ? flags.server.trim() : '';
  if (serverRaw.length === 0) {
    return {
      kind: 'missing-server',
      message: '--base / --target requires --server <url> so both reviews can be fetched',
    };
  }
  // Strip a trailing slash so the URL template compose is unambiguous
  // -- mirrors parseWatchConfig.
  const serverUrl = serverRaw.replace(/\/+$/, '');
  const formatRaw =
    typeof flags.format === 'string' ? flags.format.toLowerCase() : 'text';
  if (formatRaw !== 'text' && formatRaw !== 'json') {
    return {
      kind: 'invalid-format',
      message: `--format must be text or json (got '${formatRaw}')`,
    };
  }
  return {
    kind: 'ok',
    serverUrl,
    baseId,
    targetId,
    format: formatRaw as 'text' | 'json',
  };
}

/**
 * Tick 22: `clawreview review drift --base <reviewId> --target <reviewId>`
 *
 * Two-review compare mode. Fetches both reviews' `/api/reviews/:id/digest`
 * bodies from `--server` and computes `computeDigestDrift(base.fresh,
 * target.fresh)`. The drift surfaces as "did the bug fix actually clear
 * the findings?" / "did this refactor regress the count?".
 *
 * Composes with the tick-20 filter flags (`--min-confidence`,
 * `--severity-threshold`) for a "preview drift at a stricter floor"
 * pattern: the filter applies to BOTH reviews symmetrically so an
 * operator can ask "did the fix clear high-confidence high-severity
 * findings?". The filter is forwarded as `?minConfidence=` /
 * `?severityThreshold=` query params on each /digest call.
 *
 * Exit codes:
 *   0 -- both reviews fetched, computeDigestDrift returned no drift.
 *   2 -- config error / fetch failure / shape rejection. Stderr
 *        carries the precise reason.
 *   3 -- drift detected (mirrors single-shot's contract for CI
 *        gateability).
 *
 * Injectable fetcher seam mirrors `runReviewDriftWatch` so the test
 * suite can pin every arm without a real network round-trip.
 */
export async function runReviewDriftCompare(
  args: ParsedArgs,
  // baseId / targetId pre-extracted by runReviewDrift for the early
  // branch -- still pass them so the function can be called directly
  // by tests bypassing the runReviewDrift dispatcher.
  baseId: string,
  targetId: string,
  injected?: {
    fetcher?: WatchFetcher;
    /**
     * Tick 23: hook executor for --on-regression. Defaults to the
     * watch-mode WatchOnDriftExecer (same shell-exec contract, same
     * stdin piping) so a CI pipeline can reuse hooks across watch
     * and compare modes. Tests inject a stub that records invocations.
     */
    onRegressionExecer?: WatchOnDriftExecer;
  },
): Promise<void> {
  // Validate via the pure parser. The early branch already saw at
  // least one of base/target set; the parser now sees both AND
  // checks --server / --format.
  const config = parseCompareConfig({
    base: baseId,
    target: targetId,
    server: args.flags.server,
    format: args.flags.format,
  });
  if (config.kind !== 'ok') {
    process.stderr.write(`clawreview review drift: ${config.message}\n`);
    process.exitCode = 2;
    return;
  }
  // Tick 23: parse the --on-regression hook flag. Pure parser so a
  // typo (e.g. --on-regression='') rejects early with exit 2 rather
  // than firing a no-op hook downstream. Empty / non-string value
  // means "no hook" (back-compat: existing compare calls don't fire).
  //
  // Tick 24: --on-regression-template <name> mirrors tick-17's
  // --on-drift-template for the compare command's regression hook.
  // Same closed {slack, webhook} template set; same env-var
  // fallback ladder (REGRESSION_-specific -> shared) so an operator
  // with one Slack channel handling both drift and regression
  // alerts doesn't need to set two env vars.
  //
  // Mutex with --on-regression: a template AND an explicit
  // --on-regression command rejects (almost always a typo --
  // the operator switched to the template but forgot to remove
  // the raw command).
  const onRegressionParse = parseOnRegressionFlags({
    'on-regression': args.flags['on-regression'],
    'on-regression-template': args.flags['on-regression-template'],
    env: process.env,
  });
  if (onRegressionParse.kind === 'invalid') {
    process.stderr.write(`clawreview review drift: ${onRegressionParse.message}\n`);
    process.exitCode = 2;
    return;
  }
  const onRegression = onRegressionParse.kind === 'ok' ? onRegressionParse.command : undefined;
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  if (noColor) kleur.enabled = false;
  const fetcher = injected?.fetcher ?? defaultWatchFetcher;
  const onRegressionExecer = injected?.onRegressionExecer ?? defaultWatchOnDriftExecer;

  // Tick 20 filter flags compose: forward them as query knobs on
  // each /digest call so the server applies them symmetrically.
  // Same forgiving parsing as the single-shot path (typo'd
  // --severity-threshold passes through verbatim; server normaliser
  // treats unknown as no-op).
  const minConfidenceRaw = args.flags['min-confidence'];
  const severityThreshold =
    args.flags['severity-threshold'] === undefined
      ? undefined
      : String(args.flags['severity-threshold']);
  const filterParams: string[] = [];
  if (minConfidenceRaw !== undefined) {
    filterParams.push(`minConfidence=${encodeURIComponent(String(minConfidenceRaw))}`);
  }
  if (severityThreshold !== undefined) {
    filterParams.push(`severityThreshold=${encodeURIComponent(severityThreshold)}`);
  }
  const qs = filterParams.length > 0 ? `?${filterParams.join('&')}` : '';

  // Fetch both /digest bodies in parallel. The two calls are
  // independent so a serial fetch would be a needless latency penalty
  // for a CI gate that's already on the hot path.
  const baseUrl = `${config.serverUrl}/api/reviews/${encodeURIComponent(config.baseId)}/digest${qs}`;
  const targetUrl = `${config.serverUrl}/api/reviews/${encodeURIComponent(config.targetId)}/digest${qs}`;
  let baseBody: DriftReport;
  let targetBody: DriftReport;
  try {
    const [baseRes, targetRes] = await Promise.all([fetcher(baseUrl), fetcher(targetUrl)]);
    if (!baseRes.ok) {
      process.stderr.write(
        `clawreview review drift --base: HTTP ${baseRes.status} fetching base review '${config.baseId}'\n`,
      );
      process.exitCode = 2;
      return;
    }
    if (!targetRes.ok) {
      process.stderr.write(
        `clawreview review drift --target: HTTP ${targetRes.status} fetching target review '${config.targetId}'\n`,
      );
      process.exitCode = 2;
      return;
    }
    const baseText = await baseRes.text();
    const targetText = await targetRes.text();
    baseBody = JSON.parse(baseText) as DriftReport;
    targetBody = JSON.parse(targetText) as DriftReport;
  } catch (err) {
    process.stderr.write(
      `clawreview review drift --base / --target fetch failed: ${(err as Error).message}\n`,
    );
    process.exitCode = 2;
    return;
  }

  // Resolve each side's fresh digest. Accept both /digest body shape
  // (carries `fresh`) and /reviews/:id body shape (carries findings
  // + digest) so an operator can swap endpoints. We deliberately
  // prefer .fresh when both are present -- the server's /digest
  // recompute is the source of truth on the server side.
  const baseFresh = resolveFreshFromBody(baseBody);
  if (!baseFresh) {
    process.stderr.write(
      `clawreview review drift --base: base review body lacks both 'fresh' and 'findings'\n`,
    );
    process.exitCode = 2;
    return;
  }
  const targetFresh = resolveFreshFromBody(targetBody);
  if (!targetFresh) {
    process.stderr.write(
      `clawreview review drift --target: target review body lacks both 'fresh' and 'findings'\n`,
    );
    process.exitCode = 2;
    return;
  }

  // The drift here is BETWEEN two reviews, not between a persisted
  // and a fresh of the same review. The semantics carry over
  // cleanly: positive deltas = target has MORE of bucket X than
  // base (regression); negative deltas = target has LESS (the
  // happy path after a bug fix). hasDrift = "the two reviews
  // disagreed in at least one bucket".
  const drift = computeDigestDrift(baseFresh, targetFresh);

  if (config.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          baseReviewId: config.baseId,
          targetReviewId: config.targetId,
          base: baseFresh,
          target: targetFresh,
          drift,
          // Echo the resolved filters so a CI gate / jq pipeline
          // can verify what the CLI sent on the wire.
          minConfidence: minConfidenceRaw === undefined ? null : Number(String(minConfidenceRaw)),
          severityThreshold: severityThreshold === undefined ? null : severityThreshold,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    renderCompareText(config.baseId, config.targetId, baseFresh, targetFresh, drift);
  }

  // Tick 23: --on-regression hook. Fires when the target has MORE
  // findings than the base in at least one bucket -- i.e. a refactor
  // / "bug fix" regressed the per-bucket count somewhere. This is
  // strictly NARROWER than `drift.hasDrift`: a bug-fix that cleared
  // findings (negative deltas only) fires NO hook even though
  // hasDrift=true, while a fix that cleared 3 bugs and accidentally
  // added 1 new one DOES fire (the +1 in some bucket is the
  // regression signal).
  //
  // Use case: a CI pipeline that auto-files a JIRA ticket when a
  // landed PR added new findings in another file, OR posts a Slack
  // alert with the regression buckets so the on-call sees what
  // actually got worse.
  //
  // Hook contract mirrors --watch --on-drift exactly: the shell
  // command receives a JSON payload on stdin describing the
  // regression slice (per-bucket positive deltas only).
  //
  // Payload shape:
  //   { kind: 'regression',
  //     baseReviewId, targetReviewId,
  //     totalDelta,            -- always positive (regression total)
  //     bySeverityRegression,  -- per-severity positive deltas only
  //     byAgentRegression,     -- ditto, sparse
  //     byCategoryRegression,  -- ditto, sparse
  //     byFileRegression,      -- ditto, sparse
  //     byTagRegression }      -- ditto, sparse
  //
  // The hook is fire-and-await: we wait for the executor to resolve
  // before returning so an operator on a CI step can rely on the
  // hook completing before the next step runs. Failures surface on
  // stderr (matching the watch-mode --on-drift contract) but do NOT
  // change the compare command's exit code -- the exit code stays
  // tied to drift.hasDrift so a CI gate that already exits 3 on
  // drift doesn't get a DIFFERENT exit code on regression.
  const regressionSlice = computeRegressionSlice(drift);
  if (onRegression !== undefined && regressionSlice !== null) {
    const payload = JSON.stringify({
      kind: 'regression',
      baseReviewId: config.baseId,
      targetReviewId: config.targetId,
      ...regressionSlice,
    });
    try {
      const result = await onRegressionExecer(onRegression, payload);
      if (result.exitCode !== 0) {
        process.stderr.write(
          `clawreview review drift --on-regression hook exited ${result.exitCode}` +
            (result.stderr ? `: ${result.stderr.trim()}` : '') +
            '\n',
        );
      }
    } catch (err) {
      process.stderr.write(
        `clawreview review drift --on-regression hook threw: ${(err as Error).message}\n`,
      );
    }
  }

  // Exit 3 on drift mirrors single-shot's CI gateability contract.
  process.exitCode = drift.hasDrift ? 3 : 0;
}

/**
 * Tick 23: extract the "regression slice" from a drift report --
 * i.e. the subset of per-bucket positive deltas (target has MORE
 * than base) that constitute a regression.
 *
 * Returns null when NO bucket has a positive delta (no regression
 * to attribute). The caller uses null as the trigger predicate for
 * the --on-regression hook fire decision.
 *
 * Pure: never mutates the input drift; iterates each bucket once.
 *
 * Exported so the test surface can pin every arm without driving
 * the whole compare command pipeline.
 */
export interface RegressionSlice {
  /** Sum of positive deltas across all bucket axes. Always > 0 when slice is non-null. */
  totalDelta: number;
  /** Per-severity positive deltas. Sparse: severity keys with delta <= 0 omitted. */
  bySeverityRegression: Record<string, number>;
  /** Per-agent positive deltas. Sparse. */
  byAgentRegression: Record<string, number>;
  /** Per-category positive deltas. Sparse. */
  byCategoryRegression: Record<string, number>;
  /** Per-file positive deltas. Sparse. */
  byFileRegression: Record<string, number>;
  /** Per-tag positive deltas. Sparse. */
  byTagRegression: Record<string, number>;
}

export function computeRegressionSlice(drift: FindingDigestDrift): RegressionSlice | null {
  // sumPositives + filterPositive walk each bucket once. Sparse maps
  // mean keys we omit can never contribute, so the predicate is
  // "any positive delta anywhere" -- a single bucket value > 0.
  const bySeverityRegression = filterPositive(drift.bySeverityDelta);
  const byAgentRegression = filterPositive(drift.byAgentDelta);
  const byCategoryRegression = filterPositive(
    drift.byCategoryDelta as Record<string, number>,
  );
  const byFileRegression = filterPositive(drift.byFileDelta);
  const byTagRegression = filterPositive(drift.byTagDelta);
  // totalDelta on RegressionSlice is the SUM of positive bucket
  // deltas (not drift.totalDelta itself, which can be negative when
  // a regression in one file is offset by a fix in another). We
  // sum the severity axis specifically because each finding lands
  // in exactly one severity bucket -- the sum equals the number
  // of NEWLY-ADDED findings on the regressing axes. The other
  // axes can have overlapping keys (one finding contributes to
  // a file AND an agent AND a category), so summing them would
  // double-count.
  const sevSum = Object.values(bySeverityRegression).reduce((s, n) => s + n, 0);
  if (
    sevSum === 0 &&
    Object.keys(byAgentRegression).length === 0 &&
    Object.keys(byCategoryRegression).length === 0 &&
    Object.keys(byFileRegression).length === 0 &&
    Object.keys(byTagRegression).length === 0
  ) {
    return null;
  }
  return {
    totalDelta: sevSum,
    bySeverityRegression,
    byAgentRegression,
    byCategoryRegression,
    byFileRegression,
    byTagRegression,
  };
}

/**
 * Internal: walk a sparse string-keyed delta map and return a copy
 * containing only entries with strictly positive values. Used by
 * computeRegressionSlice to project the per-bucket regression view.
 */
function filterPositive(bucket: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(bucket)) {
    if (v > 0) out[k] = v;
  }
  return out;
}

/**
 * Pure helper: pull a fresh digest out of either input body shape.
 * Returns null when neither shape is present so the caller can
 * surface a precise error to stderr.
 *
 * Order: /digest body (.fresh) wins over /reviews/:id body
 * (.findings + recompute) because the server's recompute is the
 * canonical write-once shape.
 */
function resolveFreshFromBody(body: DriftReport): FindingDigest | null {
  if (body.fresh) return body.fresh;
  if (Array.isArray(body.findings)) {
    return findingDigest(body.findings, {
      topCategories: 8,
      topAgents: 8,
      hotspots: true,
    });
  }
  return null;
}

/**
 * Text renderer for `review drift --base/--target`. Mirrors the
 * single-shot renderer's banner shape so an operator who knows
 * single-shot knows compare.
 */
function renderCompareText(
  baseId: string,
  targetId: string,
  base: FindingDigest,
  target: FindingDigest,
  drift: FindingDigestDrift,
): void {
  process.stdout.write(
    `${kleur.bold('base review')}:   ${baseId} (${base.total} findings)\n` +
      `${kleur.bold('target review')}: ${targetId} (${target.total} findings)\n` +
      `${kleur.bold('totalDelta')}:    ${formatDelta(drift.totalDelta)}\n\n`,
  );

  if (!drift.hasDrift) {
    process.stdout.write(`${kleur.gray('  (no drift: target matches base)')}\n`);
    return;
  }

  const sevEntries = Object.entries(drift.bySeverityDelta).filter(([, d]) => d !== 0);
  if (sevEntries.length > 0) {
    process.stdout.write(`${kleur.bold('severity')}:\n`);
    for (const [sev, d] of sevEntries) {
      process.stdout.write(`  ${kleur.bold(sev.padEnd(8))} ${formatDelta(d)}\n`);
    }
    process.stdout.write('\n');
  }

  renderSparseCompareBucket('agent', drift.byAgentDelta);
  renderSparseCompareBucket('category', drift.byCategoryDelta as Record<string, number>);
  renderSparseCompareBucket('file', drift.byFileDelta);
  renderSparseCompareBucket('tag', drift.byTagDelta);
}

function renderSparseCompareBucket(
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

/**
 * Tick 23: pure config-validation result for `runReviewFilterReport`.
 * Mirrors `CompareConfigResult` / `WatchConfigResult` discriminated-union
 * shape so the test surface can pin each error arm individually.
 */
export type FilterReportConfigResult =
  | {
      kind: 'ok';
      serverUrl: string;
      reviewId: string;
      format: 'text' | 'json';
      slim: boolean;
    }
  | { kind: 'missing-review-id'; message: string }
  | { kind: 'missing-server'; message: string }
  | { kind: 'invalid-format'; message: string };

/**
 * Tick 23: pure parser for `review filter-report` config.
 *
 * Exported so the same shape (defaults, error sentinels) has one
 * test surface. Mirrors `parseCompareConfig`'s patterns: each error
 * arm is a distinct discriminant; the happy path returns a fully-typed
 * shape. The reviewId arg is positional (first non-flag after the
 * subcommand) to mirror `review drift --base <id>` ergonomics --
 * an operator writes `clawreview review filter-report rv_42_abc`.
 */
export function parseFilterReportConfig(input: {
  reviewId?: unknown;
  server?: unknown;
  format?: unknown;
  slim?: unknown;
}): FilterReportConfigResult {
  const reviewId = typeof input.reviewId === 'string' ? input.reviewId.trim() : '';
  if (reviewId.length === 0) {
    return {
      kind: 'missing-review-id',
      message:
        'clawreview review filter-report <reviewId> is required (saw empty / non-string value)',
    };
  }
  const serverRaw = typeof input.server === 'string' ? input.server.trim() : '';
  if (serverRaw.length === 0) {
    return {
      kind: 'missing-server',
      message: '--server <url> is required so the CLI can fetch the persisted filter report',
    };
  }
  // Strip a trailing slash so the URL template compose is unambiguous
  // -- mirrors parseCompareConfig.
  const serverUrl = serverRaw.replace(/\/+$/, '');
  const formatRaw = typeof input.format === 'string' ? input.format.toLowerCase() : 'text';
  if (formatRaw !== 'text' && formatRaw !== 'json') {
    return {
      kind: 'invalid-format',
      message: `--format must be text or json (got '${formatRaw}')`,
    };
  }
  // Slim accepts the same truthy-string contract as the route's
  // ?slim=true|1|yes flag so the CLI surface matches the wire.
  const slimRaw = input.slim;
  let slim = false;
  if (typeof slimRaw === 'boolean') {
    slim = slimRaw;
  } else if (typeof slimRaw === 'string') {
    const lower = slimRaw.trim().toLowerCase();
    slim = lower === 'true' || lower === '1' || lower === 'yes';
  }
  return {
    kind: 'ok',
    serverUrl,
    reviewId,
    format: formatRaw as 'text' | 'json',
    slim,
  };
}

/**
 * Tick 23: shape of the `/api/reviews/:id/filter-report` response.
 * Two-arm union: the slim path strips the verbose appliedFilters
 * object and surfaces a single `applied: boolean`; the full path
 * keeps it. Both arms always carry the common `reviewId / inputTotal
 * / droppedTotal / applied / slim` fields.
 *
 * Exported so the test surface can pin shape expectations without
 * round-tripping through fetch.
 */
export interface FilterReportBodyFull {
  reviewId: string;
  inputTotal: number;
  droppedTotal: number;
  applied: boolean;
  slim: false;
  appliedFilters: {
    minConfidence: { raw: number | undefined; normalised: number; applied: boolean };
    severityThreshold: { raw: string | undefined; normalised: string | null; applied: boolean };
    any: boolean;
  };
}
export interface FilterReportBodySlim {
  reviewId: string;
  inputTotal: number;
  droppedTotal: number;
  applied: boolean;
  slim: true;
}
export type FilterReportBody = FilterReportBodyFull | FilterReportBodySlim;

/**
 * Tick 23: `clawreview review filter-report <reviewId> --server <url>`
 *
 * Fetches and renders the persisted filter report for a single review.
 * Pair-of-three CLI with `review drift` and a future `review show`:
 * each one is the CLI face of a single read endpoint on the server.
 *
 *   - `review drift`         -> /api/reviews/:id (or /digest)
 *   - `review filter-report` -> /api/reviews/:id/filter-report (tick 23)
 *
 * Use cases:
 *   1. CI gate that wants "did this review's worker apply any filter,
 *      and how many findings did it drop?" without curl + jq.
 *   2. On-call sanity check after a config rollout: "did the new
 *      min_confidence threshold actually filter findings on review X?"
 *   3. Inspection / debugging: `clawreview review filter-report
 *      rv_42_abc --server https://clawreview --format json` for a
 *      structured dump.
 *
 * Output formats:
 *   - text (default) -- compact banner showing reviewId, drop count,
 *     and applied filter axes. Color-tagged when stdout is a TTY.
 *   - json -- the raw response body verbatim (or a slim projection
 *     when --slim is set) so a downstream tool consumes the same
 *     shape the server returned.
 *
 * Exit codes:
 *   0 -- success: report fetched and rendered.
 *   2 -- config error / fetch failure / shape rejection.
 *   3 -- the persisted report had NO filter applied (applied=false).
 *        Mirrors `presets diff` / `review drift`'s exit-3-on-drift
 *        contract: a CI gate that REQUIRES a filter to be in effect
 *        can `clawreview review filter-report ... --require-filter`
 *        (a future fresh-flag) and treat exit 3 as "missing".
 *        Today the exit code always returns 0 on a successful fetch;
 *        the gating arm is reserved for a follow-up tick. (Pinned
 *        in the test surface so a future change is intentional.)
 *
 * Injectable fetcher seam mirrors `runReviewDriftCompare` so the
 * test suite can pin every arm without a real network round-trip.
 */
export async function runReviewFilterReport(
  args: ParsedArgs,
  injected?: { fetcher?: WatchFetcher; sleeper?: WatchSleeper; metrics?: MetricsBundle },
): Promise<void> {
  // Positional shape: `clawreview review filter-report <reviewId>`.
  // args.positional[0] is the subcommand name 'filter-report';
  // [1] is the reviewId positional arg.
  const reviewIdPositional = args.positional[1] ?? '';
  // Tick 24: --watch <reviewId> opt-in switches to poll mode. When
  // present, we route to runReviewFilterReportWatch which polls the
  // /filter-report endpoint on a configurable interval and re-renders
  // the persisted shape per sample. Single-shot mode is the default
  // (and the back-compat path for the tick-23 command).
  //
  // The flag's VALUE is the reviewId (mirrors `review drift --watch
  // <reviewId>` ergonomics). When set, the positional reviewId is
  // ignored -- we'd rather have ONE source of truth than negotiate
  // precedence between two.
  const watchReviewId =
    typeof args.flags.watch === 'string' ? args.flags.watch.trim() : '';
  if (watchReviewId.length > 0) {
    return runReviewFilterReportWatch(args, watchReviewId, injected);
  }
  // Tick 25: --diff <baseReviewId> opt-in switches to two-review
  // compare mode. The positional reviewId stays as the TARGET; the
  // flag's value is the BASE. Mirrors `review drift --base / --target`
  // ergonomics but with a single --diff flag (filter-report doesn't
  // need the symmetric --base/--target surface; the positional
  // already names one of the two sides).
  //
  // Use case: "did this CI run land with the new min_confidence
  // threshold compared to the previous green build?". The compare
  // fetches both /filter-report bodies and surfaces the delta
  // (which fields changed, which thresholds drifted).
  const diffBaseId =
    typeof args.flags.diff === 'string' ? args.flags.diff.trim() : '';
  if (diffBaseId.length > 0) {
    return runReviewFilterReportDiff(args, diffBaseId, reviewIdPositional, injected);
  }
  const config = parseFilterReportConfig({
    reviewId: reviewIdPositional,
    server: args.flags.server,
    format: args.flags.format,
    slim: args.flags.slim,
  });
  if (config.kind !== 'ok') {
    process.stderr.write(`clawreview review filter-report: ${config.message}\n`);
    process.exitCode = 2;
    return;
  }
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  if (noColor) kleur.enabled = false;
  const fetcher = injected?.fetcher ?? defaultWatchFetcher;

  // Build URL: /api/reviews/:id/filter-report (+ ?slim=true when set).
  const slimQs = config.slim ? '?slim=true' : '';
  const url = `${config.serverUrl}/api/reviews/${encodeURIComponent(config.reviewId)}/filter-report${slimQs}`;

  let body: FilterReportBody;
  try {
    const res = await fetcher(url);
    if (!res.ok) {
      // 404 here can be either NotFound (unknown review id) or
      // NoFilterReport (legacy review pre-tick-22). We propagate the
      // status so an operator can distinguish without parsing the
      // body, but we ALSO surface the body's `error` field when
      // available so the message is precise.
      let detail = '';
      try {
        const txt = await res.text();
        const parsedErr = JSON.parse(txt) as { error?: string };
        if (parsedErr.error) detail = ` (${parsedErr.error})`;
      } catch {
        // Body wasn't JSON -- fall back to the bare status code.
      }
      process.stderr.write(
        `clawreview review filter-report: HTTP ${res.status} fetching '${config.reviewId}'${detail}\n`,
      );
      process.exitCode = 2;
      return;
    }
    const text = await res.text();
    body = JSON.parse(text) as FilterReportBody;
  } catch (err) {
    process.stderr.write(
      `clawreview review filter-report: fetch failed: ${(err as Error).message}\n`,
    );
    process.exitCode = 2;
    return;
  }

  if (config.format === 'json') {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else {
    renderFilterReportText(body);
  }
  // Tick 24: --require-filter gating flag. Exit 3 when the persisted
  // report's `applied` bit is false. Pairs with the CLI's existing
  // exit-3-on-drift contract (presets diff / review drift) so a CI
  // gate that REQUIRES a filter to be in effect can fail loudly:
  //   `clawreview review filter-report rv_xyz --server <url> --require-filter`
  // Exit 3 means "filter not applied" (rather than "drift" / "regression");
  // the message above is what differentiates them.
  //
  // Default OFF (back-compat: tick-23 single-shot always exits 0 on
  // a successful fetch). When set AND body.applied is false, we
  // write a single-line stderr hint and flip to exit 3.
  if (args.flags['require-filter'] === true || args.flags['require-filter'] === 'true') {
    if (!body.applied) {
      process.stderr.write(
        `clawreview review filter-report: --require-filter set but persisted report has applied=false\n`,
      );
      process.exitCode = 3;
    }
  }
}

/**
 * Tick 25: validation outcome for `runReviewFilterReportDiff`. Either
 * a fully-resolved config or one of three error sentinels.
 *
 * Mirrors `CompareConfigResult` / `FilterReportConfigResult`
 * discriminated-union shapes so the test surface can pin each error
 * arm individually without parsing stderr messages.
 *
 *   - `'missing-base'`   -- --diff <baseReviewId> was empty or
 *                           non-string. (The flag's value IS the
 *                           base; absence is the back-compat path
 *                           that doesn't reach this parser.)
 *   - `'missing-target'` -- the positional <reviewId> was empty.
 *                           The compare needs both sides; we don't
 *                           guess a default.
 *   - `'missing-server'` -- --server <url> required to fetch both
 *                           /filter-report bodies.
 *   - `'invalid-format'` -- --format must be 'text' or 'json'.
 */
export type FilterReportDiffConfigResult =
  | {
      kind: 'ok';
      serverUrl: string;
      baseId: string;
      targetId: string;
      format: 'text' | 'json';
    }
  | { kind: 'missing-base'; message: string }
  | { kind: 'missing-target'; message: string }
  | { kind: 'missing-server'; message: string }
  | { kind: 'invalid-format'; message: string };

/**
 * Tick 25: pure parser for `review filter-report --diff` config.
 * Mirrors `parseCompareConfig`'s validation contract so the two
 * two-review-compare modes (drift compare + filter-report diff)
 * share one mental model.
 *
 * Validation:
 *   - baseId (from --diff value) required (missing -> 'missing-base')
 *   - targetId (from positional) required (missing -> 'missing-target')
 *   - serverUrl required (missing -> 'missing-server')
 *   - format: 'text' | 'json' (default 'text'; anything else ->
 *     'invalid-format')
 *
 * Server URL trailing slashes are stripped so the URL template
 * compose stays clean.
 */
export function parseFilterReportDiffConfig(flags: {
  base?: unknown;
  target?: unknown;
  server?: unknown;
  format?: unknown;
}): FilterReportDiffConfigResult {
  const baseId = typeof flags.base === 'string' ? flags.base.trim() : '';
  if (baseId.length === 0) {
    return {
      kind: 'missing-base',
      message:
        '--diff <baseReviewId> requires a non-empty review id (saw empty / non-string value)',
    };
  }
  const targetId = typeof flags.target === 'string' ? flags.target.trim() : '';
  if (targetId.length === 0) {
    return {
      kind: 'missing-target',
      message:
        '--diff requires a positional <targetReviewId>: `clawreview review filter-report --diff <baseId> <targetId>`',
    };
  }
  const serverRaw = typeof flags.server === 'string' ? flags.server.trim() : '';
  if (serverRaw.length === 0) {
    return {
      kind: 'missing-server',
      message: '--diff requires --server <url> so both filter-reports can be fetched',
    };
  }
  const serverUrl = serverRaw.replace(/\/+$/, '');
  const formatRaw =
    typeof flags.format === 'string' ? flags.format.toLowerCase() : 'text';
  if (formatRaw !== 'text' && formatRaw !== 'json') {
    return {
      kind: 'invalid-format',
      message: `--format must be text or json (got '${formatRaw}')`,
    };
  }
  return {
    kind: 'ok',
    serverUrl,
    baseId,
    targetId,
    format: formatRaw as 'text' | 'json',
  };
}

/**
 * Tick 25: shape of a per-field delta produced by computeFilterReportDelta.
 *
 * Each field tracks WHETHER it changed plus the before/after values so
 * a downstream consumer can render "min_confidence 0.5 -> 0.8" or
 * "severity_threshold added: high" without computing the delta itself.
 *
 * A bug-fix-only delta (no fields changed) returns hasDelta=false; a
 * CI gate that wants "did anything change?" reads ONE field.
 */
export interface FilterReportDelta {
  /** Top-level applied bit transition. */
  applied: { base: boolean; target: boolean; changed: boolean };
  /** Input total (pre-filter count). */
  inputTotal: { base: number; target: number; delta: number; changed: boolean };
  /** Dropped total (count of findings the filter removed). */
  droppedTotal: { base: number; target: number; delta: number; changed: boolean };
  /**
   * Min-confidence axis. Tracks the normalised threshold (the
   * resolved value the worker applied; the raw input is operator-
   * controlled and not stable for comparison). Threshold absence
   * (no filter on that axis) is represented as null.
   */
  minConfidence: { base: number | null; target: number | null; changed: boolean };
  /**
   * Severity-threshold axis. Same shape as minConfidence; threshold
   * absent on that axis is null.
   */
  severityThreshold: { base: string | null; target: string | null; changed: boolean };
  /** True if ANY field above carries changed=true. CI gate reads this. */
  hasDelta: boolean;
}

/**
 * Tick 25: compute the per-field delta between two filter-report
 * bodies. Pure (no IO, no mutation, no side effects) so it can be
 * tested without driving the HTTP layer.
 *
 * Slim bodies (no `appliedFilters`) are tolerated: the per-axis
 * deltas surface as base=null/target=null with changed=false, since
 * we can't tell whether a slim consumer ran a filter on those axes.
 * This keeps the helper symmetric across projection modes.
 */
export function computeFilterReportDelta(
  base: FilterReportBody,
  target: FilterReportBody,
): FilterReportDelta {
  const appliedChanged = base.applied !== target.applied;
  const inputDelta = target.inputTotal - base.inputTotal;
  const droppedDelta = target.droppedTotal - base.droppedTotal;
  // Extract the per-axis thresholds; slim bodies carry no
  // appliedFilters object, so we read defensively.
  const baseFull = (base as FilterReportBodyFull).appliedFilters;
  const targetFull = (target as FilterReportBodyFull).appliedFilters;
  // Normalised values are the resolved thresholds the worker
  // actually applied. We compare on those (the raw input is
  // operator-controlled and not stable for comparison).
  const baseMinConf = baseFull && baseFull.minConfidence.applied
    ? baseFull.minConfidence.normalised
    : null;
  const targetMinConf = targetFull && targetFull.minConfidence.applied
    ? targetFull.minConfidence.normalised
    : null;
  const baseSev = baseFull && baseFull.severityThreshold.applied
    ? baseFull.severityThreshold.normalised
    : null;
  const targetSev = targetFull && targetFull.severityThreshold.applied
    ? targetFull.severityThreshold.normalised
    : null;
  const minConfChanged = baseMinConf !== targetMinConf;
  const sevChanged = baseSev !== targetSev;
  const hasDelta =
    appliedChanged ||
    inputDelta !== 0 ||
    droppedDelta !== 0 ||
    minConfChanged ||
    sevChanged;
  return {
    applied: { base: base.applied, target: target.applied, changed: appliedChanged },
    inputTotal: {
      base: base.inputTotal,
      target: target.inputTotal,
      delta: inputDelta,
      changed: inputDelta !== 0,
    },
    droppedTotal: {
      base: base.droppedTotal,
      target: target.droppedTotal,
      delta: droppedDelta,
      changed: droppedDelta !== 0,
    },
    minConfidence: { base: baseMinConf, target: targetMinConf, changed: minConfChanged },
    severityThreshold: { base: baseSev, target: targetSev, changed: sevChanged },
    hasDelta,
  };
}

/**
 * Tick 26: stdout sentinel for `review filter-report --diff --output -`.
 * Same shape as `presets diff`'s STDOUT_SENTINEL (Symbol.for keyed
 * registry so module duplication in the test surface doesn't break
 * identity compares). Kept in a distinct registry key from presets
 * diff's so a future divergence (e.g. one command gaining --output
 * '+' for stdout-and-also-write) doesn't have to coordinate two
 * commands' sentinel semantics in lockstep.
 */
export const FILTER_REPORT_DIFF_STDOUT_SENTINEL: unique symbol = Symbol.for(
  'clawreview.review.filter-report.diff.output.stdout',
);
export type FilterReportDiffOutputTarget = string | typeof FILTER_REPORT_DIFF_STDOUT_SENTINEL;

/**
 * Tick 26: resolve a user-provided `--output <path>` value into either
 * the stdout sentinel (when literally `-`) or an absolute filesystem
 * path. Relative paths land under `cwd` -- a CLI consumer that wants
 * a different root can resolve themselves and pass an absolute path.
 *
 * Pure: no IO, no mutation. The path math mirrors `presets diff`'s
 * resolver so an operator who learned one command's --output contract
 * (mkdir -p + relative-to-root + `-` for stdout) knows this one too.
 *
 * The literal `-` is mapped to the stdout sentinel here so a downstream
 * consumer can compare via Symbol identity (`=== FILTER_REPORT_DIFF_STDOUT_SENTINEL`)
 * without the ambiguity of a magic string (a file literally named
 * `-` is still resolvable by Node).
 */
export function resolveFilterReportDiffOutputPath(
  outputPath: string,
  cwd: string,
): FilterReportDiffOutputTarget {
  if (outputPath === '-') return FILTER_REPORT_DIFF_STDOUT_SENTINEL;
  return isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath);
}

/**
 * Tick 26: write the rendered JSON delta body to either stdout (when
 * `outputTarget` is the sentinel) or a file on disk.
 *
 * For file writes: mkdir -p the target directory first (harmless when
 * it already exists; matches presets diff's contract). Surfaces a
 * single stderr "wrote N bytes to <path>" confirmation so a CI log
 * has a breadcrumb without polluting stdout (which holds the actual
 * artifact when --output - / pure mode is in play).
 *
 * For stdout writes: pure-mode write -- no preamble, no stderr
 * banner. The body already carries a trailing newline from
 * JSON.stringify+`\n` so the bytes match what a file-write would
 * have produced. A downstream `jq` / file redirect gets exactly the
 * artifact bytes.
 */
async function writeFilterReportDiffOutput(
  outputTarget: FilterReportDiffOutputTarget,
  body: string,
): Promise<void> {
  if (outputTarget === FILTER_REPORT_DIFF_STDOUT_SENTINEL) {
    process.stdout.write(body);
    return;
  }
  const targetDir = dirname(outputTarget);
  await mkdir(targetDir, { recursive: true });
  await writeFile(outputTarget, body, 'utf8');
  process.stderr.write(
    `clawreview review filter-report --diff: wrote ${body.length} bytes to ${outputTarget}\n`,
  );
}

/**
 * Tick 25: `clawreview review filter-report --diff <baseReviewId> <targetReviewId>`
 *
 * Two-review compare mode for the filter-report endpoint. Fetches
 * both reviews' `/api/reviews/:id/filter-report` bodies and surfaces
 * the per-field delta (which fields changed, which thresholds
 * drifted).
 *
 * Use case: "did this CI run land with the new min_confidence
 * threshold compared to the previous green build?" -- a CI dashboard
 * comparing two runs of the same repo wants to see the filter shape
 * shift, not (just) the finding counts.
 *
 * Exit codes (mirrors `review drift --base/--target` for parity):
 *   0 -- both reviews fetched, computeFilterReportDelta returned no
 *        delta (hasDelta=false).
 *   2 -- config error / fetch failure / shape rejection.
 *   3 -- delta detected (hasDelta=true). Mirrors the CLI's exit-3-
 *        on-drift contract so a CI dashboard classifying exit codes
 *        treats filter-report drift the same as digest drift.
 *
 * Output:
 *   - text (default): banner showing each field's before/after with
 *     a "changed: yes/no" marker. Visually similar to single-shot's
 *     banner but with two sides per axis.
 *   - json: `{ baseId, targetId, delta: FilterReportDelta }` so a
 *     downstream tool can consume the deltas as structured data.
 *
 * Injectable fetcher seam mirrors runReviewDriftCompare so the test
 * suite can pin every arm without a real network round-trip.
 */
export async function runReviewFilterReportDiff(
  args: ParsedArgs,
  baseId: string,
  targetIdPositional: string,
  injected?: { fetcher?: WatchFetcher; metrics?: MetricsBundle },
): Promise<void> {
  // Tick 26: start the per-invocation clock at the top so the
  // duration histogram captures the FULL invocation, including
  // config parse / fetch / compute. Same `result` label as the
  // tick-25 counter so a PromQL join-on-result lines up cleanly.
  // Use performance.now() not Date.now() so a mid-invocation clock
  // adjustment (NTP sync) doesn't poison the observation.
  const startedAt = performance.now();
  const metricsForDuration = injected?.metrics;
  // Helper closure: fire BOTH the counter and the duration histogram
  // with the SAME (fetchOk, delta) tuple so a downstream consumer
  // never sees a count-without-duration / duration-without-count
  // mismatch. The counter is always fired (back-compat with tick 25);
  // the histogram only fires when a metrics bundle was injected.
  const fireExit = (
    fetchOk: boolean,
    delta: { hasDelta: boolean } | null,
  ): void => {
    if (metricsForDuration) {
      observeReviewFilterReportDiff(metricsForDuration, fetchOk, delta);
      observeReviewFilterReportDiffDuration(
        metricsForDuration,
        fetchOk,
        delta,
        (performance.now() - startedAt) / 1000,
      );
    }
  };
  const config = parseFilterReportDiffConfig({
    base: baseId,
    target: targetIdPositional,
    server: args.flags.server,
    format: args.flags.format,
  });
  if (config.kind !== 'ok') {
    process.stderr.write(`clawreview review filter-report: ${config.message}\n`);
    process.exitCode = 2;
    // Tick 25: fire the counter with result=error for the config-
    // error arm too, so a CI dashboard sees the misconfiguration
    // rate alongside the fetch-error / shape-rejection rate. The
    // metrics bundle is optional -- callers that didn't wire one
    // simply skip the fire.
    // Tick 26: fireExit also records the per-invocation latency so
    // the "how long did the misconfig take to surface?" question
    // has a numeric answer (typically sub-millisecond -- this arm's
    // latency captures the config-parse cost only).
    fireExit(false, null);
    return;
  }
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  if (noColor) kleur.enabled = false;
  const fetcher = injected?.fetcher ?? defaultWatchFetcher;

  // Fetch both /filter-report bodies in parallel -- they're
  // independent so a serial fetch would be a needless latency penalty
  // for a CI gate.
  const baseUrl = `${config.serverUrl}/api/reviews/${encodeURIComponent(config.baseId)}/filter-report`;
  const targetUrl = `${config.serverUrl}/api/reviews/${encodeURIComponent(config.targetId)}/filter-report`;
  let baseBody: FilterReportBody;
  let targetBody: FilterReportBody;
  try {
    const [baseRes, targetRes] = await Promise.all([fetcher(baseUrl), fetcher(targetUrl)]);
    if (!baseRes.ok) {
      process.stderr.write(
        `clawreview review filter-report --diff: HTTP ${baseRes.status} fetching base review '${config.baseId}'\n`,
      );
      process.exitCode = 2;
      fireExit(false, null);
      return;
    }
    if (!targetRes.ok) {
      process.stderr.write(
        `clawreview review filter-report --diff: HTTP ${targetRes.status} fetching target review '${config.targetId}'\n`,
      );
      process.exitCode = 2;
      fireExit(false, null);
      return;
    }
    const baseText = await baseRes.text();
    const targetText = await targetRes.text();
    baseBody = JSON.parse(baseText) as FilterReportBody;
    targetBody = JSON.parse(targetText) as FilterReportBody;
  } catch (err) {
    process.stderr.write(
      `clawreview review filter-report --diff fetch failed: ${(err as Error).message}\n`,
    );
    process.exitCode = 2;
    fireExit(false, null);
    return;
  }

  const delta = computeFilterReportDelta(baseBody, targetBody);

  // Tick 26: --output <path> writes the JSON delta body to a file
  // (or stdout when --output -) instead of printing it directly.
  // Mirrors `presets diff --output` so a migration-ticket / CI flow
  // that wants the delta body to land on disk for a follow-up commit
  // can use one command. The literal `-` is the stdout sentinel; when
  // set, the body lands on stdout in "pure mode" with no banner /
  // stderr noise.
  //
  // --output + --format text rejects 2 (text is color-tagged and for
  // terminal display, not artifacts) -- mirrors the presets diff
  // command's contract so the operator's mental model carries over.
  const outputRaw = args.flags.output;
  const outputTarget =
    typeof outputRaw === 'string' && outputRaw.length > 0
      ? resolveFilterReportDiffOutputPath(outputRaw, process.cwd())
      : null;
  if (outputTarget !== null && config.format === 'text') {
    process.stderr.write(
      `clawreview review filter-report --diff: --output is incompatible with --format text ` +
        `(text is color-tagged and intended for terminal display; use --format json ` +
        `for artifact writes)\n`,
    );
    process.exitCode = 2;
    fireExit(false, null);
    return;
  }

  if (outputTarget !== null) {
    // --output path: serialise the delta as JSON regardless of any
    // text-mode color tags (the format check above already rejected
    // --format text + --output). The body shape matches stdout's
    // JSON output so a downstream consumer can swap "redirect stdout
    // to file" for "--output <path>" without changing the parsing
    // code.
    const body = `${JSON.stringify(
      { baseId: config.baseId, targetId: config.targetId, delta },
      null,
      2,
    )}\n`;
    await writeFilterReportDiffOutput(outputTarget, body);
  } else if (config.format === 'json') {
    process.stdout.write(
      `${JSON.stringify({ baseId: config.baseId, targetId: config.targetId, delta }, null, 2)}\n`,
    );
  } else {
    renderFilterReportDeltaText(config.baseId, config.targetId, delta);
  }
  // Exit 3 on delta -- mirrors the CLI's exit-3-on-drift contract
  // so a CI gate can `clawreview review filter-report --diff base
  // target --server <url>` and gate on the exit code.
  process.exitCode = delta.hasDelta ? 3 : 0;
  // Tick 25: fire the diff counter with the resolved result label
  // (identical | delta). The error arm is fired on each early-return
  // branch above.
  // Tick 26: fireExit ALSO records the per-invocation latency in
  // lock-step with the counter so the (count, sum, bucket) tuples
  // come out of one invocation each.
  fireExit(true, delta);
}

/**
 * Tick 25: text renderer for `review filter-report --diff` output.
 * Walks each field of the delta and prints a "base -> target" line
 * with a "changed: yes/no" tag. The format mirrors single-shot's
 * banner so an operator scanning the output sees a familiar shape
 * (just with two columns per axis).
 *
 * Pure-ish (writes to stdout); pulled out as a free function so the
 * test surface can stub stdout independently of the runner.
 */
function renderFilterReportDeltaText(
  baseId: string,
  targetId: string,
  delta: FilterReportDelta,
): void {
  process.stdout.write(`${kleur.bold('filter-report diff')}\n`);
  process.stdout.write(`  ${kleur.bold('base')}:   ${baseId}\n`);
  process.stdout.write(`  ${kleur.bold('target')}: ${targetId}\n`);
  process.stdout.write('\n');
  const tag = (changed: boolean): string =>
    changed ? kleur.yellow('changed') : kleur.gray('unchanged');
  process.stdout.write(
    `  ${kleur.bold('applied')}             ${delta.applied.base} -> ${delta.applied.target}   [${tag(delta.applied.changed)}]\n`,
  );
  process.stdout.write(
    `  ${kleur.bold('inputTotal')}          ${delta.inputTotal.base} -> ${delta.inputTotal.target}   ` +
      `(delta ${formatDelta(delta.inputTotal.delta)})   [${tag(delta.inputTotal.changed)}]\n`,
  );
  process.stdout.write(
    `  ${kleur.bold('droppedTotal')}        ${delta.droppedTotal.base} -> ${delta.droppedTotal.target}   ` +
      `(delta ${formatDelta(delta.droppedTotal.delta)})   [${tag(delta.droppedTotal.changed)}]\n`,
  );
  process.stdout.write(
    `  ${kleur.bold('min_confidence')}      ${delta.minConfidence.base ?? '-'} -> ${delta.minConfidence.target ?? '-'}   [${tag(delta.minConfidence.changed)}]\n`,
  );
  process.stdout.write(
    `  ${kleur.bold('severity_threshold')}  ${delta.severityThreshold.base ?? '-'} -> ${delta.severityThreshold.target ?? '-'}   [${tag(delta.severityThreshold.changed)}]\n`,
  );
  process.stdout.write('\n');
  process.stdout.write(
    `  ${kleur.bold('hasDelta')}            ${delta.hasDelta ? kleur.yellow('yes') : kleur.gray('no')}\n`,
  );
}

/**
 * Tick 23: text renderer for `review filter-report`. Compact banner
 * showing reviewId, drop count, and the applied filter axes. Slim
 * mode collapses the per-axis detail to a single "filters applied"
 * line.
 *
 * Pure-ish (writes to stdout); pulled out as a free function so the
 * test surface can stub stdout and pin every render arm without
 * driving the whole command pipeline.
 */
function renderFilterReportText(body: FilterReportBody): void {
  process.stdout.write(
    `${kleur.bold('review')}:        ${body.reviewId}\n` +
      `${kleur.bold('inputTotal')}:    ${body.inputTotal}\n` +
      `${kleur.bold('droppedTotal')}:  ${formatDelta(-body.droppedTotal)}\n` +
      `${kleur.bold('applied')}:       ${body.applied ? kleur.yellow('yes') : kleur.gray('no')}\n`,
  );
  if (body.slim) {
    process.stdout.write(
      `${kleur.gray('(slim mode: per-axis detail stripped; ?slim=true)')}\n`,
    );
    return;
  }
  // Full mode: surface per-axis detail so the operator sees WHICH
  // filter axis fired.
  const f = body.appliedFilters;
  process.stdout.write(`${kleur.bold('appliedFilters')}:\n`);
  process.stdout.write(
    `  ${kleur.bold('min_confidence')}        applied=${f.minConfidence.applied} ` +
      `raw=${f.minConfidence.raw ?? '-'} normalised=${f.minConfidence.normalised}\n`,
  );
  process.stdout.write(
    `  ${kleur.bold('severity_threshold')}    applied=${f.severityThreshold.applied} ` +
      `raw=${f.severityThreshold.raw ?? '-'} normalised=${f.severityThreshold.normalised ?? '-'}\n`,
  );
}

/**
 * Tick 24: validation outcome for `runReviewFilterReportWatch`. Either
 * a fully-resolved config or one of the error sentinels.
 *
 * Mirrors `WatchConfigResult`'s discriminated-union shape so the test
 * surface can pin each error arm individually. Distinct from
 * `WatchConfigResult` because the filter-report watch loop has a
 * smaller config surface (no --on-drift / --on-recover hooks; the
 * persisted filter report doesn't have a notion of "drift" the way
 * the digest does -- it's a write-once snapshot from the worker).
 */
export type FilterReportWatchConfigResult =
  | {
      kind: 'ok';
      serverUrl: string;
      intervalMs: number;
      maxPolls: number;
      format: 'text' | 'json';
      slim: boolean;
      /**
       * Tick 25: --on-applied-change <cmd> hook. Fires on every
       * transition of the persisted report's `applied` bit
       * (false->true OR true->false). Use case: "alert me when the
       * config rollout finally landed on this review's worker run"
       * (or vice versa: "alert me if the worker started ignoring
       * the filter").
       *
       * Null when the flag is absent. The hook receives the same
       * JSONL payload --on-drift uses (reviewId / poll / body) so
       * a single jq / webhook pipeline can consume both.
       *
       * Distinct from --on-drift / --on-recover in `runReviewDriftWatch`:
       * those fire on per-bucket digest drift; this one fires on the
       * top-level applied-bit edge. We use a fresh sentinel
       * ('invalid-on-applied-change') so a parse error here doesn't
       * surface under the digest-watch error path.
       */
      onAppliedChange: string | null;
    }
  | { kind: 'missing-server'; message: string }
  | { kind: 'invalid-interval'; message: string }
  | { kind: 'invalid-max-polls'; message: string }
  | { kind: 'invalid-format'; message: string }
  | { kind: 'invalid-on-applied-change'; message: string };

/**
 * Tick 24: pure parser for `review filter-report --watch` config.
 *
 * Exported so the same shape (defaults, error sentinels) has one
 * test surface. Mirrors `parseWatchConfig` defaults so an operator
 * who knows `review drift --watch` ergonomics doesn't have to learn
 * a second set:
 *   - interval: WATCH_DEFAULT_INTERVAL_MS (5000ms)
 *   - max-polls: 0 (unlimited)
 *   - format: 'text'
 *   - slim: false (default to the verbose shape so the watch banner
 *     shows the per-axis applied detail; an operator wanting the
 *     terse "applied?" line can pass --slim)
 *
 * Validation rules:
 *   - serverUrl required (missing/empty -> 'missing-server')
 *   - intervalMs: must be a finite number >= WATCH_MIN_INTERVAL_MS
 *   - maxPolls: must be a non-negative integer (0 = unlimited)
 *   - format: 'text' | 'json'
 *
 * Server URL is normalised: trailing slashes stripped so callers can
 * compose `${serverUrl}/api/reviews/${id}/filter-report` cleanly.
 */
export function parseFilterReportWatchConfig(flags: {
  server?: unknown;
  interval?: unknown;
  'max-polls'?: unknown;
  format?: unknown;
  slim?: unknown;
  'on-applied-change'?: unknown;
  'on-applied-template'?: unknown;
}): FilterReportWatchConfigResult {
  const serverRaw = typeof flags.server === 'string' ? flags.server.trim() : '';
  if (serverRaw.length === 0) {
    return {
      kind: 'missing-server',
      message:
        '--watch requires --server <url> (the CLI polls <server>/api/reviews/<id>/filter-report)',
    };
  }
  const serverUrl = serverRaw.replace(/\/+$/, '');

  let intervalMs = WATCH_DEFAULT_INTERVAL_MS;
  if (flags.interval !== undefined) {
    const raw = String(flags.interval).trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < WATCH_MIN_INTERVAL_MS) {
      return {
        kind: 'invalid-interval',
        message: `--interval must be a number >= ${WATCH_MIN_INTERVAL_MS} (ms); got '${raw}'`,
      };
    }
    intervalMs = Math.floor(parsed);
  }

  let maxPolls = 0;
  if (flags['max-polls'] !== undefined) {
    const raw = String(flags['max-polls']).trim();
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return {
        kind: 'invalid-max-polls',
        message: `--max-polls must be a non-negative integer (0 = unlimited); got '${raw}'`,
      };
    }
    maxPolls = parsed;
  }

  let format: 'text' | 'json' = 'text';
  if (flags.format !== undefined) {
    const raw = String(flags.format).trim().toLowerCase();
    if (raw !== 'text' && raw !== 'json') {
      return {
        kind: 'invalid-format',
        message: `--format must be text or json (got '${flags.format}')`,
      };
    }
    format = raw;
  }

  // Mirror parseFilterReportConfig's slim parser: boolean true OR
  // string 'true'/'1'/'yes' resolves to slim=true; everything else
  // resolves to slim=false.
  const slimRaw = flags.slim;
  let slim = false;
  if (typeof slimRaw === 'boolean') {
    slim = slimRaw;
  } else if (typeof slimRaw === 'string') {
    const lower = slimRaw.trim().toLowerCase();
    slim = lower === 'true' || lower === '1' || lower === 'yes';
  }

  // Tick 25: --on-applied-change <cmd> hook. Mirrors --on-drift's
  // parse-time validation contract: a non-string value rejects, an
  // empty trimmed string rejects (typo guard).
  let onAppliedChange: string | null = null;
  if (flags['on-applied-change'] !== undefined) {
    if (typeof flags['on-applied-change'] !== 'string') {
      return {
        kind: 'invalid-on-applied-change',
        message: `--on-applied-change must be a command string; got ${typeof flags['on-applied-change']}`,
      };
    }
    const trimmed = flags['on-applied-change'].trim();
    if (trimmed.length === 0) {
      return {
        kind: 'invalid-on-applied-change',
        message: `--on-applied-change requires a non-empty command (e.g. --on-applied-change 'curl -X POST https://...')`,
      };
    }
    onAppliedChange = trimmed;
  }
  // Tick 25: --on-applied-template <name>. Mirrors tick-17/19's
  // --on-drift-template / --on-recover-template patterns. Mutex
  // with --on-applied-change: combining the two would force the
  // parser to pick a winner.
  if (flags['on-applied-template'] !== undefined) {
    if (onAppliedChange !== null) {
      return {
        kind: 'invalid-on-applied-change',
        message:
          '--on-applied-template is mutually exclusive with --on-applied-change (pick one)',
      };
    }
    if (typeof flags['on-applied-template'] !== 'string') {
      return {
        kind: 'invalid-on-applied-change',
        message: `--on-applied-template must be a template name string; got ${typeof flags['on-applied-template']}`,
      };
    }
    const name = flags['on-applied-template'].trim();
    if (name.length === 0) {
      return {
        kind: 'invalid-on-applied-change',
        message: '--on-applied-template requires a template name (one of: slack, webhook)',
      };
    }
    const expanded = expandOnAppliedTemplate(name, process.env);
    if (expanded.kind === 'invalid') {
      return { kind: 'invalid-on-applied-change', message: expanded.message };
    }
    onAppliedChange = expanded.command;
  }

  return { kind: 'ok', serverUrl, intervalMs, maxPolls, format, slim, onAppliedChange };
}

/**
 * Tick 25: Closed set of `--on-applied-template` template names for
 * `review filter-report --watch`. Mirrors ON_DRIFT_TEMPLATES /
 * ON_RECOVER_TEMPLATES / ON_REGRESSION_TEMPLATES so an operator's
 * mental model carries across all four hook surfaces (drift,
 * recover, regression, applied-change).
 *
 * Re-exported as its own tuple so a future divergence (e.g. an
 * "applied-only" / "unapplied-only" template that surfaces just one
 * direction of the transition) can land without disturbing the
 * other hook surfaces.
 */
export const ON_APPLIED_TEMPLATES = ['slack', 'webhook'] as const;
export type OnAppliedTemplate = (typeof ON_APPLIED_TEMPLATES)[number];

/**
 * Outcome of expanding `--on-applied-template <name>`. Identical
 * shape to `OnDriftTemplateExpansion`; surfaced under the existing
 * 'invalid-on-applied-change' error sentinel so the caller doesn't
 * need a new error kind.
 */
export type OnAppliedTemplateExpansion =
  | { kind: 'ok'; command: string }
  | { kind: 'invalid'; message: string };

/**
 * Expand a named `--on-applied-template` into the curl command the
 * watch loop will exec on the applied-bit transition edge.
 *
 * Env-var fallback ladder (mirrors expandOnRecoverTemplate /
 * expandOnRegressionTemplate's primary->shared pattern):
 *   - `slack`   -> $SLACK_APPLIED_WEBHOOK_URL, falling back to
 *                  $SLACK_WEBHOOK_URL. Operators with one Slack
 *                  channel for all hook events don't need to
 *                  duplicate the URL into a fourth env var.
 *   - `webhook` -> $WEBHOOK_APPLIED_URL, falling back to
 *                  $WEBHOOK_URL. Same logic.
 *
 * Pure: takes the `env` map as an argument so tests can drive
 * every arm without mutating `process.env`.
 */
export function expandOnAppliedTemplate(
  name: string,
  env: NodeJS.ProcessEnv,
): OnAppliedTemplateExpansion {
  const lower = name.toLowerCase();
  let primaryVar: string;
  let fallbackVar: string;
  switch (lower) {
    case 'slack':
      primaryVar = 'SLACK_APPLIED_WEBHOOK_URL';
      fallbackVar = 'SLACK_WEBHOOK_URL';
      break;
    case 'webhook':
      primaryVar = 'WEBHOOK_APPLIED_URL';
      fallbackVar = 'WEBHOOK_URL';
      break;
    default:
      return {
        kind: 'invalid',
        message: `unknown --on-applied-template '${name}'; valid: ${ON_APPLIED_TEMPLATES.join(', ')}`,
      };
  }
  const primary = (env[primaryVar] ?? '').trim();
  const fallback = (env[fallbackVar] ?? '').trim();
  const url = primary.length > 0 ? primary : fallback;
  if (url.length === 0) {
    return {
      kind: 'invalid',
      message:
        `--on-applied-template ${lower} requires \$${primaryVar} ` +
        `(or \$${fallbackVar} as fallback) -- set one before running the watch loop`,
    };
  }
  const command =
    `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${url}'`;
  return { kind: 'ok', command };
}

/**
 * Tick 24: `clawreview review filter-report --watch <reviewId>`
 *
 * Watch-mode equivalent of the tick-23 single-shot `review filter-
 * report`. Polls `<server>/api/reviews/<id>/filter-report` on a
 * configurable interval and re-renders the persisted shape per
 * sample. Designed for on-calls watching a config rollout land:
 * the persisted filter report is the write-time snapshot the worker
 * produced, so polling it answers "did the new min_confidence
 * threshold land on this review's worker run yet?" without manual
 * curl loops.
 *
 * Stops when:
 *   - SIGINT (Ctrl-C) -- exit 0 regardless of last sample state.
 *   - --max-polls reached -- exit 0 (no built-in failure mode for
 *     the filter-report watch; an operator who wants exit-3 on
 *     "filter not applied" can pair with --require-filter).
 *   - Fatal error (network / server / parse) -- exit 2.
 *
 * Output (mirrors `review drift --watch` to keep the visual surface
 * uniform):
 *   - text (default): same banner as single-shot, with a `--- poll N
 *     at <ISO> ---` separator between samples.
 *   - json (JSONL): one JSON object per poll, newline-delimited so
 *     a downstream consumer can pipe through `jq -c .`.
 *
 * Single-shot's --slim flag composes: the watch loop forwards
 * ?slim=true on every poll so the operator gets the slim banner per
 * sample.
 *
 * Injectable fetcher / sleeper seams mirror runReviewDriftWatch so
 * the test suite can pin every arm without a real network round-trip
 * or real sleep.
 */
export async function runReviewFilterReportWatch(
  args: ParsedArgs,
  reviewId: string,
  injected?: {
    fetcher?: WatchFetcher;
    sleeper?: WatchSleeper;
    onAppliedChangeExecer?: WatchOnDriftExecer;
  },
): Promise<void> {
  const config = parseFilterReportWatchConfig({
    server: args.flags.server,
    interval: args.flags.interval,
    'max-polls': args.flags['max-polls'],
    format: args.flags.format,
    slim: args.flags.slim,
    'on-applied-change': args.flags['on-applied-change'],
    'on-applied-template': args.flags['on-applied-template'],
  });
  if (config.kind !== 'ok') {
    process.stderr.write(`clawreview review filter-report: ${config.message}\n`);
    process.exitCode = 2;
    return;
  }
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;
  if (noColor) kleur.enabled = false;

  const fetcher = injected?.fetcher ?? defaultWatchFetcher;
  const sleeper = injected?.sleeper ?? defaultWatchSleeper;
  // Tick 25: hook executor reuses the WatchOnDriftExecer shape from
  // runReviewDriftWatch (same shell-exec contract, same stdin-pipe
  // semantics). Tests inject a stub that records invocations.
  const onAppliedChangeExecer =
    injected?.onAppliedChangeExecer ?? defaultWatchOnDriftExecer;
  const slimQs = config.slim ? '?slim=true' : '';
  const url = `${config.serverUrl}/api/reviews/${encodeURIComponent(reviewId)}/filter-report${slimQs}`;

  // SIGINT handling: flip a flag, finish the current iteration, exit
  // 0. Same pattern as runReviewDriftWatch.
  let stopped = false;
  const onSigint = (): void => {
    stopped = true;
  };
  process.once('SIGINT', onSigint);

  // Tick 24: --require-filter watch-mode bookkeeping. Tracks the LAST
  // sample's `applied` bit so the post-loop exit code reflects the
  // most recent snapshot (matches single-shot semantics: "did the
  // last poll show a filtered report?"). The default sentinel `true`
  // means "no sample yet"; if the loop exits with zero polls
  // (impossible on the happy path but cheap to be safe), the gate
  // stays inert.
  const requireFilter =
    args.flags['require-filter'] === true || args.flags['require-filter'] === 'true';
  let lastApplied = true;
  // Tick 25: --on-applied-change bookkeeping. Tracks the PREVIOUS
  // sample's applied bit so the next sample can detect the
  // transition edge. We use a 'no prior sample' sentinel (null) so
  // the FIRST poll never fires the hook (there's no transition
  // FROM null TO a bool); subsequent polls compare against the
  // last observed boolean. Same pattern as runReviewDriftWatch's
  // prevHadDrift -- a recover edge requires a drift to recover
  // FROM, and an applied-change edge requires an applied to change
  // FROM.
  let prevApplied: boolean | null = null;
  let pollCount = 0;
  try {
    while (!stopped) {
      pollCount += 1;
      let body: FilterReportBody;
      try {
        const res = await fetcher(url);
        if (!res.ok) {
          process.stderr.write(
            `clawreview review filter-report --watch: poll ${pollCount} got HTTP ${res.status}; aborting\n`,
          );
          process.exitCode = 2;
          return;
        }
        const text = await res.text();
        body = JSON.parse(text) as FilterReportBody;
      } catch (err) {
        process.stderr.write(
          `clawreview review filter-report --watch: poll ${pollCount} failed: ${(err as Error).message}\n`,
        );
        process.exitCode = 2;
        return;
      }

      if (config.format === 'json') {
        // JSONL: one object per poll, newline-delimited.
        process.stdout.write(
          `${JSON.stringify({
            reviewId,
            poll: pollCount,
            body,
          })}\n`,
        );
      } else {
        // Text: prefix each sample with a `--- poll N at <ISO> ---`
        // header (matches runReviewDriftWatch).
        process.stdout.write(
          `${kleur.gray(`--- poll ${pollCount} at ${new Date().toISOString()} ---`)}\n`,
        );
        renderFilterReportText(body);
      }

      // Tick 24: track the LAST sample's applied bit for the
      // --require-filter gate. The body's `applied` is the
      // top-level boolean both slim and full shapes carry, so the
      // bookkeeping works uniformly across projection modes.
      lastApplied = Boolean(body.applied);

      // Tick 25: fire --on-applied-change hook on the transition
      // edge (prev !== current). The first poll never fires (there's
      // no transition from a null prior); subsequent polls compare
      // against the last observed boolean and fire on flip.
      //
      // The hook receives the same JSONL payload --on-drift uses so
      // a single jq / webhook pipeline can consume both:
      //   { reviewId, poll, body, prevApplied, currentApplied }
      // Failures surface on stderr but DON'T abort the loop -- the
      // operator wired the hook to be notified; a misconfigured
      // webhook shouldn't stop the watch from running.
      if (config.onAppliedChange !== null) {
        if (prevApplied !== null && prevApplied !== lastApplied) {
          const payload = JSON.stringify({
            reviewId,
            poll: pollCount,
            body,
            prevApplied,
            currentApplied: lastApplied,
          });
          try {
            const result = await onAppliedChangeExecer(config.onAppliedChange, payload);
            if (result.exitCode !== 0) {
              process.stderr.write(
                `clawreview review filter-report --watch: --on-applied-change exited ${result.exitCode}: ${result.stderr.trim()}\n`,
              );
            }
          } catch (err) {
            process.stderr.write(
              `clawreview review filter-report --watch: --on-applied-change failed: ${(err as Error).message}\n`,
            );
          }
        }
      }
      prevApplied = lastApplied;

      // Stop check BEFORE sleep so --max-polls 1 doesn't waste an
      // interval between the only sample and the exit.
      if (config.maxPolls > 0 && pollCount >= config.maxPolls) {
        break;
      }
      if (stopped) break;
      await sleeper(config.intervalMs);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  if (stopped) {
    process.stdout.write(`${kleur.gray('watch stopped')}\n`);
    process.exitCode = 0;
    return;
  }
  // Stopped by --max-polls -- exit reflects the gate when set,
  // otherwise 0 (no built-in failure mode for plain watch).
  if (requireFilter && pollCount > 0 && !lastApplied) {
    process.stderr.write(
      `clawreview review filter-report --watch: --require-filter set but last poll showed applied=false\n`,
    );
    process.exitCode = 3;
    return;
  }
  process.exitCode = 0;
}
