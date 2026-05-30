/**
 * Tracks GitHub webhook delivery IDs we have already accepted so a redelivery
 * (which GitHub does automatically on non-2xx, but also on operator retry)
 * does not enqueue a duplicate review job or create a second ReviewRecord.
 *
 * Backed by a bounded LRU map. In production we want this persisted to Redis
 * across server replicas; that adapter is layered in by the bootstrap.
 */
export interface DeliveryCache {
  /**
   * Returns `true` if we have NOT seen this delivery before AND it is now
   * marked as seen. Returns `false` if the delivery was a duplicate.
   */
  reserve(deliveryId: string): boolean;
  has(deliveryId: string): boolean;
  size(): number;
  clear(): void;
}

export class InMemoryDeliveryCache implements DeliveryCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly capacity = 5000) {}

  reserve(deliveryId: string): boolean {
    if (!deliveryId) return true; // fall open on missing IDs (never block traffic)
    if (this.seen.has(deliveryId)) {
      // refresh recency so a long-burning loop does not evict its own marker
      this.seen.delete(deliveryId);
      this.seen.set(deliveryId, Date.now());
      return false;
    }
    this.seen.set(deliveryId, Date.now());
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  has(deliveryId: string): boolean {
    return this.seen.has(deliveryId);
  }

  size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }
}

let singleton: DeliveryCache | null = null;
export function getDeliveryCache(): DeliveryCache {
  if (!singleton) singleton = new InMemoryDeliveryCache();
  return singleton;
}

export function _resetDeliveryCacheForTests(): void {
  singleton = new InMemoryDeliveryCache();
}
