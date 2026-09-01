import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { structureMutationConfirmed } from "./structure-reconciliation";

function node(
  id: string,
  parentId: string | null,
  children: TreeNode[] = [],
  extra: Record<string, unknown> = {},
): TreeNode {
  return {
    id,
    parentId,
    title: id,
    order: "000000000000",
    created: "2026-07-26T00:00:00.000Z",
    updated: "2026-07-26T00:00:00.000Z",
    children,
    hasChildren: children.length > 0,
    ...extra,
  };
}

describe("structure mutation reconciliation", () => {
  it("confirms an exact parent and before-sibling placement", () => {
    const tree = [
      node("parent", null, [
        node("first", "parent"),
        node("moved", "parent"),
        node("before", "parent"),
      ]),
    ];

    expect(structureMutationConfirmed(tree, "moved", "parent", "before")).toBe(
      true,
    );
    expect(structureMutationConfirmed(tree, "moved", null, "before")).toBe(
      false,
    );
  });

  it("confirms append only when the page is last", () => {
    const tree = [node("first", null), node("moved", null)];

    expect(structureMutationConfirmed(tree, "moved", null, null)).toBe(true);
    expect(structureMutationConfirmed(tree, "first", null, null)).toBe(false);
  });

  it("reads placement alone, not a leftover key on the node", () => {
    // Filing used to withhold confirmation until the Inbox marker cleared, so
    // a note could sit in the right place and still count as unconfirmed.
    // Placement is the whole answer now — a key left on a note captured before
    // the removal cannot hold a move open.
    const stale = { inbox: true };

    expect(
      structureMutationConfirmed(
        [node("note", null, [], stale)],
        "note",
        null,
        null,
      ),
    ).toBe(true);
    expect(
      structureMutationConfirmed(
        [node("note", "parent", [], stale)],
        "note",
        null,
        null,
      ),
    ).toBe(false);
  });
});
