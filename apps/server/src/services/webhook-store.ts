/**
 * Bounded in-memory store of recent webhook deliveries.
 *
 * The webhook receiver pushes each accepted delivery here (event + raw
 * payload + headers) so an operator can later POST /api/internal/webhook/
 * replay/:deliveryId to re-feed the receiver. This is the operational
 * equivalent of GitHub's "Redeliver" button in the dashboard — except
 * scoped to whichever deliveries this replica actually saw.
 *
 * Capped at MAX_ENTRIES; oldest entries are evicted first. Production
 * should layer a Redis-backed implementation on top of this same shape.
 */
export interface WebhookEntry {
  deliveryId: string;
  event: string;
  action?: string;
  /** Raw JSON-decoded body — same shape the receiver originally saw. */
  payload: unknown;
  /** Receiver-side timestamp, ISO-8601. */
  receivedAt: string;
  /**
   * Optional repo/installation hints we extract opportunistically so
   * dashboards can render a useful list without re-parsing payloads.
   */
  repoFullName?: string;
  installationId?: number;
}

/**
 * Filter options for `WebhookStore.list`.
 *
 * All filters AND together. Applied BEFORE the `limit` cap, so e.g.
 * `list({ event: 'push', limit: 50 })` returns up to 50 push deliveries,
 * not "the 50 most recent of any kind, filtered to push".
 */
export interface WebhookListOptions {
  /** Cap on returned entries (default: 50, hard ceiling: 200). */
  limit?: number;
  /** Restrict to entries whose `event` equals this string. */
  event?: string;
  /**
   * Lower-bound on `receivedAt`, milliseconds since epoch. Entries with
   * a parse-failed `receivedAt` are kept (we'd rather over-include than
   * silently drop on a bad ISO string).
   */
  sinceMs?: number;
  /** Restrict to entries whose `repoFullName` equals this string. */
  repoFullName?: string;
  /**
   * Pagination cursor. When set, the listing skips entries up to AND
   * INCLUDING the entry with this `deliveryId`, then returns the next
   * page (still newest-first). Pair with a small `limit` to walk the
   * store one page at a time:
   *
   *   page1 = list({ limit: 25 })
   *   page2 = list({ limit: 25, after: page1[page1.length-1].deliveryId })
   *
   * Cursor semantics on stale or unknown ids: if `after` does not match
   * a currently-stored entry (e.g. it has been evicted, or the client
   * fabricated it), the listing returns an empty array rather than
   * silently restarting from the newest entry. This keeps a slow poll
   * loop from accidentally re-reading deliveries it has already
   * processed -- the caller sees the empty page, drops the stale
   * cursor, and re-fetches without one.
   */
  after?: string;
  /**
   * Optional projection of `payload` fields to keep on each entry. When
   * unset, `payload` is omitted from the returned entries (existing
   * default behaviour -- callers that want the full payload should
   * fetch the entry by id via `get()`). When set to a non-empty array,
   * each named field is copied from the original payload onto the
   * returned entry's `payload` shape; missing fields are skipped
   * silently.
   *
   * Tick-10 shipped shallow-only allowlists (`['action', 'number']`).
   * Tick-11 widens the contract to accept DOTTED PATHS so a dashboard
   * row can pull a nested field (`pull_request.title`,
   * `sender.login`) in one round-trip:
   *
   *   - `'action'`             -> top-level pick (back-compat)
   *   - `'pull_request.title'` -> walks `payload.pull_request.title`
   *                               and writes it onto
   *                               `{ pull_request: { title: ... } }`
   *                               so the wire shape mirrors the source
   *                               tree rather than flattening.
   *   - Multiple paths under one prefix merge naturally:
   *     `['pull_request.title', 'pull_request.number']` ->
   *     `{ pull_request: { title, number } }`. No duplicate prefix
   *     in the wire shape.
   *
   * Path depth is capped at 6 segments so a runaway query string
   * cannot make the projector walk an unbounded tree. An entry
   * exceeding the cap is dropped silently (consistent with the
   * tick-10 "missing key is silent" contract).
   *
   * Rationale for paths over a flatten ('pull_request.title' on the
   * wire too):
   *   1. Mirrors the source. Dashboards already consume the GitHub
   *      payload shape; the projection is just a slice of it, not a
   *      rename.
   *   2. Safe merging: two paths under the same prefix don't collide
   *      because the output is structured.
   *   3. JSON-shape stable: a dashboard that adds a path doesn't
   *      have to migrate its key names.
   *
   * The shape is NOT a full JSON-pointer (no array index syntax, no
   * `~` escaping, no `*` glob). A caller that needs a deep slice of
   * an array should fetch the full entry via `get(deliveryId)` and
   * project client-side.
   *
   * Validation: caller-supplied values are coerced to strings; empty
   * names are dropped; the projection key set is deduped so a caller
   * that accidentally passes `['action', 'action']` does the field
   * copy once.
   */
  payloadFields?: readonly string[];
}

export interface WebhookStore {
  put(entry: WebhookEntry): void;
  get(deliveryId: string): WebhookEntry | undefined;
  /**
   * Newest-first list of entries, capped at `limit`. Accepts either:
   *   - a numeric limit (back-compat with the original signature), or
   *   - a `WebhookListOptions` bag with event/sinceMs/repoFullName
   *     filters and an explicit `limit`.
   *
   * Filters apply BEFORE the limit so dashboards can paginate cleanly.
   */
  list(opts?: number | WebhookListOptions): WebhookEntry[];
  /**
   * Aggregate counts over the stored entries grouped by event, by
   * (event, action), and bucketed by hour. Used by the
   * `/api/internal/webhook/stats` endpoint to render dashboards
   * without shipping the full payload list.
   */
  stats(opts?: WebhookStatsOptions): WebhookStats;
  size(): number;
  clear(): void;
}

/**
 * Options for `WebhookStore.stats`.
 *
 * Mirrors `WebhookListOptions` filters so a dashboard can ask "how many
 * push events on team/api in the last hour?" with the same vocabulary
 * it uses for /recent.
 */
export interface WebhookStatsOptions {
  /** Only count entries with `event === this`. */
  event?: string;
  /** Only count entries with `repoFullName === this`. */
  repoFullName?: string;
  /**
   * Lower bound on `receivedAt`, in ms since epoch. Entries with an
   * unparseable `receivedAt` are kept (consistent with `list`).
   */
  sinceMs?: number;
  /**
   * Sparkline granularity. Default `hour`. The selected granularity
   * controls both `bucketSizeMs` in the response AND the default
   * bucket count (24 hours / 60 minutes / 14 days) so a caller that
   * does not pin `buckets` still gets a useful window.
   *
   *   - `minute` -- 60_000 ms buckets, default 60 (last hour).
   *   - `hour`   -- 3_600_000 ms buckets, default 24 (last day).
   *   - `day`    -- 86_400_000 ms buckets, default 14 (last fortnight).
   *
   * Capped per-granularity so a misconfigured caller cannot ask the
   * store for an unbounded sparkline (minute<=240, hour<=168, day<=90).
   */
  granularity?: 'minute' | 'hour' | 'day';
  /**
   * Number of buckets to roll up at the end of the response, counting
   * back from `nowMs`. When unset, the default depends on
   * `granularity` (see above). Hard-capped per granularity.
   */
  buckets?: number;
  /**
   * Legacy alias for `buckets` under the previous "hours only" stats
   * API. Retained so existing callers keep working; new code should
   * use `buckets`. When both are set, `buckets` wins.
   */
  hourBuckets?: number;
  /**
   * Maximum number of distinct repos to return in `byRepo` before the
   * tail is collapsed into an `(other)` bucket. Default 50, hard
   * ceiling 200 so a misconfigured caller can't ask the store to
   * render a multi-thousand-key map.
   */
  topRepos?: number;
  /**
   * Override "now" for deterministic tests. Production callers should
   * leave this undefined; tests pin it so the bucket alignment is
   * stable.
   */
  nowMs?: number;
}

/**
 * Aggregate summary of the store. The shape is intentionally compact
 * (counts only, no payloads) because the primary consumer is a small
 * sparkline / counter widget in the operator dashboard.
 */
export interface WebhookStats {
  /** Total entries that matched the filter set. */
  total: number;
  /** Entry count keyed by event (e.g. `pull_request`, `push`). */
  byEvent: Record<string, number>;
  /**
   * Entry count keyed by `event/action`. The slash separator keeps the
   * key flat and JSON-safe; downstream consumers can split it back. An
   * entry with no `action` lands under `event/(none)`.
   */
  byEventAction: Record<string, number>;
  /**
   * Entry count keyed by `repoFullName`. Useful for spotting noisy
   * repos at a glance (e.g. one PR rebase storm dwarfing the rest of
   * the org). An entry with no `repoFullName` lands under `(none)` so
   * the bucket is still surfaced rather than silently dropped.
   *
   * Capped at `topRepos` entries (default 50, hard ceiling 200) so a
   * dashboard polling this endpoint never has to render a multi-thousand
   * key map. When the cap fires, the bucket `(other)` carries the sum
   * of the trimmed tail so the total still reconciles with `total`.
   */
  byRepo: Record<string, number>;
  /**
   * Sparkline of receivedAt timestamps at the requested granularity.
   * `buckets` is ordered newest-first: index 0 is the bucket ending at
   * `nowMs`, index 1 is one bucket earlier, and so on. `granularity`
   * + `bucketSizeMs` together describe the bucket width; consumers
   * should not assume either is fixed across releases.
   */
  hourly: {
    /** `'minute' | 'hour' | 'day'`. The label `hourly` is retained for
     *  back-compat with tick-6 consumers; new callers should use
     *  `granularity` to interpret bucketSizeMs. */
    granularity: 'minute' | 'hour' | 'day';
    bucketSizeMs: number;
    buckets: number[];
    /** Right edge of the newest bucket (exclusive), in ms since epoch. */
    nowMs: number;
    /**
     * Index in `buckets` of the bucket carrying the highest count, or
     * `null` when every bucket is empty. Ties resolve to the NEWEST
     * (smaller index) bucket so a dashboard's "peaked at" label biases
     * toward the most recent surge -- that's usually the one an
     * on-call wants to investigate.
     *
     * Computed in `stats()` so a dashboard renderer doesn't have to
     * walk the array client-side just to label the sparkline peak.
     */
    peakBucketIndex: number | null;
    /**
     * Count in the peak bucket. `0` when `peakBucketIndex` is `null`.
     * Kept alongside the index so a dashboard tooltip can show
     * "peaked at <time> with N deliveries" in one render.
     */
    peakBucketCount: number;
  };
}

const MAX_ENTRIES = 200;

/**
 * Find the index of the highest-count bucket in a sparkline array.
 *
 * Returned shape:
 *   - `peakBucketIndex` is the index of the bucket with the highest
 *     count, or `null` when every bucket is empty.
 *   - `peakBucketCount` is the count in that bucket, or `0` when the
 *     index is `null`.
 *
 * Tie-breaking: when two buckets share the maximum count, the SMALLER
 * index wins. The buckets array is newest-first (index 0 == "now"), so
 * the smaller index is the more recent bucket -- a dashboard's
 * "peaked at" label biases toward the most recent surge, which is
 * usually the one an on-call wants to investigate.
 *
 * Extracted from `stats()` so the contract (tie-breaking, empty-input
 * handling) is unit-testable independently of the store wiring.
 */
function computePeakBucket(buckets: number[]): {
  peakBucketIndex: number | null;
  peakBucketCount: number;
} {
  if (buckets.length === 0) return { peakBucketIndex: null, peakBucketCount: 0 };
  let peakIdx = -1;
  let peakCount = 0;
  for (let i = 0; i < buckets.length; i++) {
    const v = buckets[i] ?? 0;
    // Strict `>` so the first (smallest index, newest-bucket) maximum
    // wins on ties.
    if (v > peakCount) {
      peakCount = v;
      peakIdx = i;
    }
  }
  if (peakIdx === -1) return { peakBucketIndex: null, peakBucketCount: 0 };
  return { peakBucketIndex: peakIdx, peakBucketCount: peakCount };
}

/**
 * Sanitise a caller-supplied `payloadFields` allowlist into a stable
 * Set of top-level keys, or `null` when the caller did NOT request a
 * projection (existing back-compat behaviour: return the entry
 * unchanged).
 *
 * Contract:
 *   - `undefined` / non-array input -> `null` (no projection).
 *   - Array input -> Set of de-duped non-empty trimmed names. Empty
 *     names ('', '   ') are dropped silently; the rest survive.
 *   - A caller-supplied empty array (`[]`) returns an empty Set
 *     (NOT null). The list() loop interprets that as "explicit
 *     opt-out: ship without payload" -- the caller meant 'I want the
 *     metadata only', not 'I forgot to pass a projection'.
 *
 * Pure / extracted so the contract is unit-testable independently of
 * the store wiring.
 */
export function sanitizeProjection(
  fields: readonly string[] | undefined,
): Set<string> | null {
  if (fields === undefined || fields === null) return null;
  if (!Array.isArray(fields)) return null;
  const out = new Set<string>();
  for (const raw of fields) {
    // Coerce gracefully: numbers / booleans get stringified, then
    // trimmed. This keeps a `?payloadFields=action,number` query
    // parser (which always hands strings) and a programmatic caller
    // both working without bespoke handling.
    const name = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
    if (name.length === 0) continue;
    out.add(name);
  }
  return out;
}

/**
 * Maximum depth for a dotted path. Bounds the per-entry walk so a
 * caller-supplied `?payloadFields=a.b.c.d.e.f.g.h.i.j` cannot turn the
 * projector into an unbounded tree walk. Six is enough for the deepest
 * useful GitHub payload slice (e.g. `pull_request.head.repo.owner.login`)
 * without inviting abuse.
 *
 * Exported so the tests can pin the cap behaviour without re-deriving
 * the threshold.
 */
export const PROJECTION_MAX_PATH_DEPTH = 6;

/**
 * Split a dotted path into trimmed segments. Returns `null` when:
 *   - The input is empty or whitespace-only (the caller already
 *     filtered these out, but this helper is robust).
 *   - Any intermediate segment is empty (`'a..b'`, `'.a'`, `'a.'`).
 *     A stray dot usually means a forgotten path piece; we'd rather
 *     refuse than silently widen.
 *   - The path exceeds `PROJECTION_MAX_PATH_DEPTH` segments.
 *
 * Pure / exported so the contract is testable independently of the
 * projection walk.
 */
export function splitProjectionPath(path: string): string[] | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split('.').map((s) => s.trim());
  if (parts.some((p) => p.length === 0)) return null;
  if (parts.length > PROJECTION_MAX_PATH_DEPTH) return null;
  return parts;
}

/**
 * Walk a dotted path through `src` and return the final value.
 * Returns `undefined` when any intermediate segment is absent or
 * resolves to a non-object value (so an attempt to walk
 * `pull_request.title.length` against
 * `{ pull_request: { title: 'X' } }` yields undefined rather than
 * the string's `.length` accidentally).
 *
 * Own-property check on every hop so a payload that happens to share
 * a key name with `Object.prototype` (e.g. `toString`) doesn't
 * surface prototype-only values.
 */
function walkProjectionPath(src: unknown, segments: readonly string[]): unknown {
  let cursor: unknown = src;
  for (const seg of segments) {
    if (
      cursor === null ||
      cursor === undefined ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor)
    ) {
      return undefined;
    }
    const obj = cursor as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, seg)) return undefined;
    cursor = obj[seg];
  }
  return cursor;
}

/**
 * Copy the requested keys (top-level OR dotted) from `payload` onto a
 * fresh object. Missing keys are skipped silently so a caller can
 * request `['action', 'sender', 'pull_request.title']` against a
 * payload that has only some of them and still get back a usable
 * subset.
 *
 * Returns:
 *   - `undefined` if `payload` is not a plain object (e.g. null, an
 *     array, or a primitive). The store entry's `payload` field is
 *     typed as `unknown`, so we can't safely shallow-pick non-objects.
 *   - A fresh object whose shape mirrors the source tree for any
 *     dotted paths in `fields`. Top-level entries land at the root;
 *     dotted entries land at their nested position so a downstream
 *     consumer sees `{ pull_request: { title: ... } }` rather than a
 *     flattened `{ 'pull_request.title': ... }`.
 *
 * Path-depth-bounded by `PROJECTION_MAX_PATH_DEPTH`; entries with a
 * deeper path are dropped silently (consistent with the tick-10
 * "missing key is silent" contract).
 *
 * Dotted-path support is additive: a tick-10 caller that ONLY uses
 * top-level keys still sees byte-identical output.
 */
export function projectPayload(payload: unknown, fields: Set<string>): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const src = payload as Record<string, unknown>;
  const dst: Record<string, unknown> = {};
  for (const key of fields) {
    if (!key.includes('.')) {
      // Tick-10 back-compat: plain top-level pick.
      if (Object.prototype.hasOwnProperty.call(src, key)) {
        dst[key] = src[key];
      }
      continue;
    }
    // Dotted path: walk into the source tree, then mirror the path
    // back into dst so the wire shape matches the source.
    const segments = splitProjectionPath(key);
    if (segments === null) continue; // Path too deep / malformed -> silently drop.
    const value = walkProjectionPath(src, segments);
    if (value === undefined) continue; // Missing along the path -> drop.
    // Write `value` into dst at `segments`. Create intermediate
    // objects as needed; merge with existing ones (so multiple paths
    // under the same prefix combine cleanly).
    let cursor: Record<string, unknown> = dst;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const existing = cursor[seg];
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        cursor = existing as Record<string, unknown>;
      } else {
        const fresh: Record<string, unknown> = {};
        cursor[seg] = fresh;
        cursor = fresh;
      }
    }
    cursor[segments[segments.length - 1]!] = value;
  }
  return dst;
}

export class InMemoryWebhookStore implements WebhookStore {
  private readonly entries = new Map<string, WebhookEntry>();
  constructor(private readonly capacity = MAX_ENTRIES) {}

  put(entry: WebhookEntry): void {
    if (!entry.deliveryId) return;
    // Re-insert to refresh insertion order (Map preserves it), so the
    // newest delivery is the last entry.
    if (this.entries.has(entry.deliveryId)) {
      this.entries.delete(entry.deliveryId);
    }
    this.entries.set(entry.deliveryId, entry);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get(deliveryId: string): WebhookEntry | undefined {
    return this.entries.get(deliveryId);
  }

  list(opts?: number | WebhookListOptions): WebhookEntry[] {
    const o: WebhookListOptions = typeof opts === 'number' ? { limit: opts } : opts ?? {};
    const limit = Math.max(1, Math.min(MAX_ENTRIES, o.limit ?? 50));
    const out: WebhookEntry[] = [];
    const all = [...this.entries.values()];

    // Resolve the projection allowlist once so the inner loop just
    // walks a small (or empty) Set. Empty / non-array opts.payloadFields
    // means "no payload on the wire" (existing default).
    const projection = sanitizeProjection(o.payloadFields);

    // Resolve the cursor up front. The cursor identifies a starting
    // INDEX in the newest-first walk; we look it up once and use the
    // index in the loop below. An unknown cursor short-circuits to an
    // empty page (see the WebhookListOptions.after docs for why).
    let startIdx = all.length - 1;
    if (o.after !== undefined && o.after.length > 0) {
      const cursorIdx = all.findIndex((e) => e.deliveryId === o.after);
      if (cursorIdx === -1) return [];
      // Walk newest-first means we want indices STRICTLY below the
      // cursor (older than it).
      startIdx = cursorIdx - 1;
      if (startIdx < 0) return [];
    }

    for (let i = startIdx; i >= 0 && out.length < limit; i -= 1) {
      const e = all[i]!;
      if (o.event !== undefined && e.event !== o.event) continue;
      if (o.repoFullName !== undefined && e.repoFullName !== o.repoFullName) continue;
      if (o.sinceMs !== undefined) {
        const t = Date.parse(e.receivedAt);
        // NaN (unparseable) is kept rather than dropped to bias toward
        // showing the operator more rather than less in a degraded state.
        if (Number.isFinite(t) && t < o.sinceMs) continue;
      }
      // Apply projection when set. `payloadFields === undefined` is
      // the default and returns the entry unchanged (back-compat with
      // every existing caller). A non-empty allowlist copies just the
      // requested top-level keys onto a fresh `payload`; an empty
      // (post-sanitisation) allowlist sets `payload` to undefined so
      // the caller can ship a slim shape without re-touching it.
      if (projection === null) {
        out.push(e);
      } else if (projection.size === 0) {
        // Empty (post-sanitisation) allowlist -> no payload on the wire.
        out.push({ ...e, payload: undefined });
      } else {
        out.push({ ...e, payload: projectPayload(e.payload, projection) });
      }
    }
    return out;
  }

  stats(opts: WebhookStatsOptions = {}): WebhookStats {
    const granularity = opts.granularity ?? 'hour';
    const bucketSizeMs =
      granularity === 'minute' ? 60_000 : granularity === 'day' ? 86_400_000 : 3_600_000;
    const defaultBucketCount =
      granularity === 'minute' ? 60 : granularity === 'day' ? 14 : 24;
    const maxBucketCount =
      granularity === 'minute' ? 240 : granularity === 'day' ? 90 : 168;
    const nowMs = opts.nowMs ?? Date.now();
    // `buckets` is the modern knob; `hourBuckets` is the legacy alias
    // (tick 6 shipped with only the hour granularity). Both clamp into
    // the per-granularity cap so a misconfigured caller can't request
    // an unbounded sparkline.
    const requested = opts.buckets ?? opts.hourBuckets ?? defaultBucketCount;
    const bucketCount = Math.max(1, Math.min(maxBucketCount, requested));
    // Cap the byRepo top-N so a dashboard polling this endpoint never
    // has to render thousands of repo buckets. The remainder collapses
    // into `(other)` further down so the total still reconciles.
    const topRepos = Math.max(1, Math.min(200, opts.topRepos ?? 50));
    const buckets = new Array<number>(bucketCount).fill(0);
    const byEvent: Record<string, number> = {};
    const byEventAction: Record<string, number> = {};
    const byRepoRaw: Record<string, number> = {};
    let total = 0;

    for (const e of this.entries.values()) {
      if (opts.event !== undefined && e.event !== opts.event) continue;
      if (opts.repoFullName !== undefined && e.repoFullName !== opts.repoFullName) continue;
      const parsed = Date.parse(e.receivedAt);
      const t = Number.isFinite(parsed) ? parsed : nowMs;
      if (opts.sinceMs !== undefined && Number.isFinite(parsed) && t < opts.sinceMs) continue;
      total += 1;
      byEvent[e.event] = (byEvent[e.event] ?? 0) + 1;
      const actionKey = `${e.event}/${e.action ?? '(none)'}`;
      byEventAction[actionKey] = (byEventAction[actionKey] ?? 0) + 1;
      // Repo bucket: `(none)` for deliveries we couldn't extract a
      // repo full name from (e.g. installation / marketplace events).
      const repoKey = e.repoFullName ?? '(none)';
      byRepoRaw[repoKey] = (byRepoRaw[repoKey] ?? 0) + 1;
      // Drop into the right bucket (newest-first index). Entries older
      // than the rendered window are still counted toward the grand
      // totals but excluded from the sparkline.
      const ageMs = nowMs - t;
      if (ageMs >= 0) {
        const idx = Math.floor(ageMs / bucketSizeMs);
        if (idx < bucketCount) {
          buckets[idx] = (buckets[idx] ?? 0) + 1;
        }
      }
    }

    // Compose the trimmed byRepo map: sort by descending count, keep
    // the top N, sum the rest into `(other)` so the visible map still
    // sums to `total` for sanity checks in dashboards.
    const sortedRepos = Object.entries(byRepoRaw).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    const byRepo: Record<string, number> = {};
    for (let i = 0; i < Math.min(topRepos, sortedRepos.length); i++) {
      const [k, v] = sortedRepos[i]!;
      byRepo[k] = v;
    }
    if (sortedRepos.length > topRepos) {
      let other = 0;
      for (let i = topRepos; i < sortedRepos.length; i++) {
        other += sortedRepos[i]![1];
      }
      if (other > 0) byRepo['(other)'] = other;
    }

    return {
      total,
      byEvent,
      byEventAction,
      byRepo,
      hourly: {
        granularity,
        bucketSizeMs,
        buckets,
        nowMs,
        ...computePeakBucket(buckets),
      },
    };
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

let singleton: WebhookStore | null = null;
export function getWebhookStore(): WebhookStore {
  if (!singleton) singleton = new InMemoryWebhookStore();
  return singleton;
}

export function _resetWebhookStoreForTests(): void {
  singleton = new InMemoryWebhookStore();
}
