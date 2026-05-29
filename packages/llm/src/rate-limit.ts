/** Token bucket limiter, thread-safe within a single Node process. */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  async acquire(cost = 1): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const needed = cost - this.tokens;
      const waitMs = Math.ceil((needed / this.refillPerSec) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }
}
