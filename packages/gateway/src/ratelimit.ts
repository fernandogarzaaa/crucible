/** Token-bucket rate limiter keyed by an arbitrary string (API key, user, agent). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(private readonly perMinute: number, private readonly burst = perMinute) {}
  /** Returns true if the request is allowed. */
  take(key: string, cost = 1): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, updated: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.updated) / 60_000) * this.perMinute);
    b.updated = now;
    if (b.tokens < cost) { this.buckets.set(key, b); return false; }
    b.tokens -= cost;
    this.buckets.set(key, b);
    return true;
  }
  retryAfterMs(key: string, cost = 1): number {
    const b = this.buckets.get(key);
    if (!b || b.tokens >= cost) return 0;
    return Math.ceil(((cost - b.tokens) / this.perMinute) * 60_000);
  }
}
