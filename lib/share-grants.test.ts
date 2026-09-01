import { describe, expect, it } from "vitest";
import type { TreeNode } from "./store/types";
import { resolveInheritedShareGrants } from "./share-grants";

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
