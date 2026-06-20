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

export interface WebhookStore {
  put(entry: WebhookEntry): void;
  get(deliveryId: string): WebhookEntry | undefined;
  /** Newest-first list of entries, capped at `limit`. */
  list(limit?: number): WebhookEntry[];
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

  list(limit = 50): WebhookEntry[] {
    const out: WebhookEntry[] = [];
    const all = [...this.entries.values()];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i -= 1) {
      out.push(all[i]!);
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
