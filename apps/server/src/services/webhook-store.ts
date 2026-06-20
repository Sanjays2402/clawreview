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
   * Number of hourly buckets to roll up at the end of the response,
   * counting back from `nowMs` (or `Date.now()`). Default: 24.
   * Capped at 168 (one week) so a misconfigured caller cannot ask the
   * store for an unbounded sparkline.
   */
  hourBuckets?: number;
  /**
   * Override "now" for deterministic tests. Production callers should
   * leave this undefined; tests pin it so the hourly bucket alignment
   * is stable.
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
   * Hourly histogram of receivedAt timestamps. `buckets` is ordered
   * newest-first: index 0 is the bucket ending at `now`, index 1 is
   * the bucket one hour earlier, and so on. `bucketSizeMs` is fixed at
   * 3,600,000 today but exposed so consumers don't hard-code it.
   */
  hourly: {
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
    for (let i = all.length - 1; i >= 0 && out.length < limit; i -= 1) {
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
    const HOUR_MS = 3_600_000;
    const nowMs = opts.nowMs ?? Date.now();
    const hourBuckets = Math.max(1, Math.min(168, opts.hourBuckets ?? 24));
    const buckets = new Array<number>(hourBuckets).fill(0);
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
      // Drop into the right hour bucket (newest-first index). Entries
      // older than the rendered window are still counted toward the
      // grand totals but excluded from the sparkline.
      const ageMs = nowMs - t;
      if (ageMs >= 0) {
        const idx = Math.floor(ageMs / HOUR_MS);
        if (idx < hourBuckets) {
          buckets[idx] = (buckets[idx] ?? 0) + 1;
        }
      }
    }

    return {
      total,
      byEvent,
      byEventAction,
      hourly: { bucketSizeMs: HOUR_MS, buckets, nowMs },
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
