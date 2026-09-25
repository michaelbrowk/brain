export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

/** Small fixed-window limiter for public password endpoints.
 *
 * Keys must come from server-controlled identifiers, never forwarding headers:
 * this app's origin is reachable directly, so cf-connecting-ip/x-forwarded-for
 * cannot be treated as authenticated input. Entries are pruned and hard-capped
 * to keep hostile requests from turning the limiter into an unbounded Map. */
export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly evictOldest: boolean;

  constructor(opts: {
    limit: number;
    windowMs: number;
    maxEntries: number;
    /** What a full map does with a key it has no room for. The default refuses
     *  the new key, which is right wherever a stranger can mint keys: evicting
     *  there would let a flood of fresh keys clear the bucket holding it back.
     *  A limiter whose keys only a successful login can create wants the
     *  opposite — see the login route — because refusing a key there locks out
     *  the very device the bucket exists to protect. */
    evictOldest?: boolean;
  }) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1)
      throw new Error("rate limit must be a positive integer");
    if (!Number.isFinite(opts.windowMs) || opts.windowMs < 1)
      throw new Error("rate limit window must be positive");
    if (!Number.isInteger(opts.maxEntries) || opts.maxEntries < 1)
      throw new Error("rate limit maxEntries must be a positive integer");
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.maxEntries = opts.maxEntries;
    this.evictOldest = opts.evictOldest ?? false;
  }

  get size(): number {
    return this.entries.size;
  }

  consume(key: string, at = Date.now()): RateLimitResult {
    this.prune(at);
    const current = this.entries.get(key);
    if (current && current.resetAt > at) {
      if (current.count >= this.limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - at) / 1000)),
        };
      }
      current.count += 1;
      return {
        allowed: true,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - at) / 1000)),
      };
    }

    if (!current && this.entries.size >= this.maxEntries) {
      if (this.evictOldest) {
        this.dropOldest();
        this.entries.set(key, { count: 1, resetAt: at + this.windowMs });
        return {
          allowed: true,
          retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)),
        };
      }
      let earliestReset = at + this.windowMs;
      for (const entry of this.entries.values()) {
        earliestReset = Math.min(earliestReset, entry.resetAt);
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((earliestReset - at) / 1_000),
        ),
      };
    }

    this.entries.set(key, { count: 1, resetAt: at + this.windowMs });
    return {
      allowed: true,
      retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)),
    };
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /** The window with the least of itself left to spend, so the key that loses
   *  its count is the one closest to losing it anyway. */
  private dropOldest(): void {
    let oldest: string | null = null;
    let oldestReset = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt < oldestReset) {
        oldest = key;
        oldestReset = entry.resetAt;
      }
    }
    if (oldest !== null) this.entries.delete(oldest);
  }

  private prune(at: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= at) this.entries.delete(key);
    }
  }
}
