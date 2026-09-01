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

  constructor(opts: { limit: number; windowMs: number; maxEntries: number }) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1)
      throw new Error("rate limit must be a positive integer");
    if (!Number.isFinite(opts.windowMs) || opts.windowMs < 1)
      throw new Error("rate limit window must be positive");
    if (!Number.isInteger(opts.maxEntries) || opts.maxEntries < 1)
      throw new Error("rate limit maxEntries must be a positive integer");
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.maxEntries = opts.maxEntries;
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

  private prune(at: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= at) this.entries.delete(key);
    }
  }
}
