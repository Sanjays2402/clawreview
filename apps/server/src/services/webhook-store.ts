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
  size(): number;
  clear(): void;
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
