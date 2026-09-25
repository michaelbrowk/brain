import { describe, expect, it } from "vitest";

import {
  rememberSharePasswordVerdict,
  SHARE_PASSWORD_VERDICT_CAPACITY,
  sharePasswordVerdictHolds,
  sharePasswordVerdictKey,
} from "./share-password-verdict";

const key = (password: string, id = "page-1", hash = "$2b$10$hash") =>
  sharePasswordVerdictKey(id, hash, password);

describe("the remembered share-password verdict", () => {
  it("holds for the rest of the window and no longer", () => {
    const right = key("hunter2");
    expect(sharePasswordVerdictHolds(right, 1_000)).toBe(false);

    rememberSharePasswordVerdict(right, 1_000);
    expect(sharePasswordVerdictHolds(right, 1_000)).toBe(true);
    expect(sharePasswordVerdictHolds(right, 60_999)).toBe(true);
    expect(sharePasswordVerdictHolds(right, 61_001)).toBe(false);
    // Expiry is final: the window it was proven in is over, and the next guess
    // buys its own comparison.
    expect(sharePasswordVerdictHolds(right, 61_000)).toBe(false);
  });

  it("holds for nothing but the exact page, hash and password", () => {
    rememberSharePasswordVerdict(key("hunter2"), 0);

    expect(sharePasswordVerdictHolds(key("hunter2"), 0)).toBe(true);
    expect(sharePasswordVerdictHolds(key("hunter3"), 0)).toBe(false);
    expect(sharePasswordVerdictHolds(key("hunter2", "page-2"), 0)).toBe(false);
    // The rotated password is a different hash, so every verdict proven against
    // the old one stops holding the moment the owner changes it.
    expect(
      sharePasswordVerdictHolds(key("hunter2", "page-1", "$2b$10$rotated"), 0),
    ).toBe(false);
  });

  it("keeps a bounded number of them, dropping the ones remembered first", () => {
    const first = key("first-of-many", "page-lru");
    rememberSharePasswordVerdict(first, 0);
    for (let index = 0; index < SHARE_PASSWORD_VERDICT_CAPACITY; index += 1) {
      rememberSharePasswordVerdict(key(`p${index}`, "page-lru"), 0);
    }

    expect(sharePasswordVerdictHolds(first, 0)).toBe(false);
    expect(sharePasswordVerdictHolds(key("p0", "page-lru"), 0)).toBe(true);
  });
});
