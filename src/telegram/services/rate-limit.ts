export class RateLimitService {
  private readonly buckets = new Map<number, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  consume(userId: number): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const existing = this.buckets.get(userId) ?? [];
    const active = existing.filter(
      (timestamp) => now - timestamp < this.windowMs,
    );

    if (active.length >= this.maxRequests) {
      const retryAfterMs = Math.max(
        0,
        (active[0] ?? now) + this.windowMs - now,
      );
      this.buckets.set(userId, active);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    active.push(now);
    this.buckets.set(userId, active);
    return { allowed: true, retryAfterSec: 0 };
  }

  clear(): void {
    this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }
}
