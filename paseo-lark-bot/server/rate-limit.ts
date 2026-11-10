/**
 * Inbound turn budget: a sliding window per (chat, sender). Group members can
 * paste a burst of @-mentions that would each start a model turn; this keeps
 * one person from consuming the chat's queue and provider quota.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the oldest request leaves the window. */
  retryAfterMs: number;
}

export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, number[]>();
  private limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: { limit: number; windowMs: number; now?: () => number; maxKeys?: number }) {
    this.limit = Math.max(0, Math.floor(options.limit));
    this.windowMs = Math.max(1, options.windowMs);
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 2_000;
  }

  /** Record a request when allowed; rejected requests do not consume budget. */
  take(key: string): RateLimitDecision {
    if (this.limit <= 0) return { allowed: true, retryAfterMs: 0 };
    const now = this.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      this.buckets.set(key, timestamps);
    }
    while (timestamps.length > 0 && timestamps[0]! <= cutoff) timestamps.shift();

    if (timestamps.length >= this.limit) {
      const retryAfterMs = Math.max(1, timestamps[0]! + this.windowMs - now);
      return { allowed: false, retryAfterMs };
    }
    timestamps.push(now);
    // Bound memory on a long-lived daemon. Re-inserting refreshes LRU order.
    this.buckets.delete(key);
    this.buckets.set(key, timestamps);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (!oldest) break;
      this.buckets.delete(oldest);
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Settings can change at runtime; existing buckets are preserved. */
  setLimit(limit: number): void {
    this.limit = Math.max(0, Math.floor(limit));
  }

  /** Remaining budget for display in /status; does not consume. */
  remaining(key: string): number {
    if (this.limit <= 0) return Number.POSITIVE_INFINITY;
    const cutoff = this.now() - this.windowMs;
    const timestamps = this.buckets.get(key) ?? [];
    return Math.max(0, this.limit - timestamps.filter((timestamp) => timestamp > cutoff).length);
  }
}

export function formatRetryAfter(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "约 1 分钟" : `约 ${minutes} 分钟`;
}
