import { describe, expect, it } from "vitest";
import type { TreeNode } from "./store/types";
import { isShareGrantExpired, resolveInheritedShareGrants } from "./share-grants";
import { isShareExpired } from "./sharing";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");

function node(
  id: string,
  parentId: string | null,
  options: {
    public?: boolean;
    shareExpiresAt?: string;
  } = {},
): TreeNode {
  return {
    id,
    parentId,
    title: id,
    order: id,
    created: "2026-07-01T00:00:00.000Z",
    updated: "2026-07-01T00:00:00.000Z",
    hasChildren: false,
    children: [],
    ...options,
  };
}

/** ONE EXPIRY RULE, UNDER TWO NAMES.
 *
 *  The store and the share reader ask `isShareExpired`, the tree walk and the
 *  shell's read-backs ask `isShareGrantExpired`, and the fold path asks both —
 *  the store's refusal through one, the browser's read-back through the other.
 *  Two bodies would be two clocks the moment one of them learned something, so
 *  there is one, and this is the test that says so: the same function, and the
 *  boundary, the malformed value and the empty answer are the same for every
 *  caller whichever name it reached for. */
describe("the share expiry rule both names read", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");

  it("is one function under both names", () => {
    expect(isShareGrantExpired).toBe(isShareExpired);
  });

  it("answers the same for a deadline, a boundary, nothing and nonsense", () => {
    for (const value of [
      undefined,
      null,
      "",
      "2026-07-27T12:00:00.000Z",
      // The deadline itself is past: a grant expires AT its instant.
      "2026-07-26T12:00:00.000Z",
      "2026-07-26T11:59:59.999Z",
      "not-a-date",
    ]) {
      expect(isShareGrantExpired(value, now)).toBe(
        isShareExpired(value ?? undefined, now),
      );
    }
    expect(isShareGrantExpired(null, now)).toBe(false);
    expect(isShareGrantExpired("2026-07-26T12:00:00.000Z", now)).toBe(true);
    expect(isShareGrantExpired("not-a-date", now)).toBe(true);
  });
});

describe("effective inherited share grants", () => {
  it("uses a higher active root when the nearest configured ancestor expired", () => {
    const grandparent = node("grandparent", null, { public: true });
    const parent = node("parent", "grandparent", {
      public: true,
      shareExpiresAt: "2026-07-29T12:00:00.000Z",
    });
    const child = node("child", "parent");

    expect(
      resolveInheritedShareGrants([grandparent, parent, child], NOW),
    ).toEqual({
      active: grandparent,
      expired: parent,
    });
  });

  it("does not treat an expired-only ancestor as active", () => {
    const parent = node("parent", null, {
      public: true,
      shareExpiresAt: "2026-07-29T12:00:00.000Z",
    });
    const child = node("child", "parent");

    expect(resolveInheritedShareGrants([parent, child], NOW)).toEqual({
      active: null,
      expired: parent,
    });
  });
});
