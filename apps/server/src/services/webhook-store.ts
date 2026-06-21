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
  };
}

const MAX_ENTRIES = 200;

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
      out.push(e);
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
    const buckets = new Array<number>(bucketCount).fill(0);
    const byEvent: Record<string, number> = {};
    const byEventAction: Record<string, number> = {};
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

    return {
      total,
      byEvent,
      byEventAction,
      hourly: { granularity, bucketSizeMs, buckets, nowMs },
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
