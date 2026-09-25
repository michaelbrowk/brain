import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "./rate-limit";

describe("FixedWindowRateLimiter", () => {
  it("consumes attempts synchronously and resets after the window", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 2,
      windowMs: 1_000,
      maxEntries: 4,
    });

    expect(limiter.consume("login", 100).allowed).toBe(true);
    expect(limiter.consume("login", 101).allowed).toBe(true);
    expect(limiter.consume("login", 102).allowed).toBe(false);
    expect(limiter.consume("login", 1_101).allowed).toBe(true);
  });

  it("fails closed at capacity without evicting an active bucket", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 100,
      maxEntries: 2,
    });

    expect(limiter.consume("a", 0).allowed).toBe(true);
    expect(limiter.consume("b", 1).allowed).toBe(true);
    expect(limiter.consume("c", 2)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.size).toBe(2);
    expect(limiter.consume("a", 3).allowed).toBe(false);

    expect(limiter.consume("d", 200).allowed).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it("evicts the bucket closest to its reset when the owner asked for that", () => {
    // Only a bucket nobody but the owner can create opts into this: the login
    // route keys one per device cookie, and a device cookie exists because a
    // login succeeded. Failing closed there would hand the last device that
    // logged in a lockout the owner cannot clear, so the oldest window goes
    // instead — the one with the least of itself left to spend.
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 100,
      maxEntries: 2,
      evictOldest: true,
    });

    expect(limiter.consume("a", 0).allowed).toBe(true);
    expect(limiter.consume("b", 10).allowed).toBe(true);
    expect(limiter.consume("c", 20).allowed).toBe(true);
    expect(limiter.size).toBe(2);
    // "a" reset first, so "a" is what went. "b" keeps the window it was in.
    expect(limiter.consume("b", 30).allowed).toBe(false);
    expect(limiter.consume("a", 40).allowed).toBe(true);
  });

  it("can reset a key after successful authentication", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      maxEntries: 4,
    });

    expect(limiter.consume("login", 0).allowed).toBe(true);
    expect(limiter.consume("login", 1).allowed).toBe(false);
    limiter.reset("login");
    expect(limiter.consume("login", 2).allowed).toBe(true);
  });
});
