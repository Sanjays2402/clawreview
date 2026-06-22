import { readFile } from 'node:fs/promises';

import kleur from 'kleur';
import {
  computeDigestDrift,
  findingDigest,
  type FindingDigest,
  type FindingDigestDrift,
} from '@clawreview/aggregator';
import {
  observeReviewDriftWatchPoll,
  type MetricsBundle,
} from '@clawreview/telemetry';
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
  | { kind: 'ok'; serverUrl: string; intervalMs: number; maxPolls: number; format: 'text' | 'json'; onDrift: string | null; onDriftOnce: boolean }
  | { kind: 'missing-server'; message: string }
  | { kind: 'invalid-interval'; message: string }
  | { kind: 'invalid-max-polls'; message: string }
  | { kind: 'invalid-format'; message: string }
  | { kind: 'invalid-on-drift'; message: string };

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

  return { kind: 'ok', serverUrl, intervalMs, maxPolls, format, onDrift, onDriftOnce };
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
