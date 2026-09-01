import { describe, expect, it } from "vitest";
import { isShareExpired, parseShareExpiry } from "./sharing";

describe("share expiry", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");

  it("keeps an absent or future deadline active", () => {
    expect(isShareExpired(undefined, now)).toBe(false);
    expect(isShareExpired("2026-07-27T12:00:00.000Z", now)).toBe(false);
  });

  it("fails closed for elapsed and malformed deadlines", () => {
    expect(isShareExpired("2026-07-26T12:00:00.000Z", now)).toBe(true);
    expect(isShareExpired("not-a-date", now)).toBe(true);
  });

  it("accepts only a bounded future ISO timestamp or an explicit reset", () => {
    expect(parseShareExpiry(undefined, now)).toBeUndefined();
    expect(parseShareExpiry(null, now)).toBeNull();
    expect(parseShareExpiry("", now)).toBeNull();
    expect(parseShareExpiry("2026-08-02T12:00:00.000Z", now)).toBe(
      "2026-08-02T12:00:00.000Z",
    );
    expect(() => parseShareExpiry("2026-07-26T11:59:59.999Z", now)).toThrow();
    expect(() => parseShareExpiry("2028-07-26T12:00:00.000Z", now)).toThrow();
    expect(() => parseShareExpiry("2026-08-02", now)).toThrow();
  });
});
