import { describe, expect, it } from "vitest";
import { resolveDropZone } from "@/lib/drop-zone";
import { resolveTreeDrop, type TreeDropRow } from "./drop-intent";

/** Rows as the sidebar flattens them: 28px tall, tiled without gaps.
 *
 *  0  Alpha            (root)
 *  1    Alpha One      (child of Alpha)
 *  2    Alpha Two      (child of Alpha)
 *  3  Beta             (root)
 *  4  Gamma            (root, a collection)
 */
const rows: TreeDropRow[] = [
  { id: "alpha", parentId: null, depth: 0 },
  { id: "alpha-one", parentId: "alpha", depth: 1 },
  { id: "alpha-two", parentId: "alpha", depth: 1 },
  { id: "beta", parentId: null, depth: 0 },
  { id: "gamma", parentId: null, depth: 0, collection: true },
];

const zoneAt = (rowIndex: number, fraction: number) =>
  resolveDropZone({
    clientY: rowIndex * 28 + fraction * 28,
    targetTop: rowIndex * 28,
    targetHeight: 28,
  });

describe("resolveDropZone", () => {
  it("splits a row into before, into, after", () => {
    expect(zoneAt(0, 0.05)).toBe("before");
    expect(zoneAt(0, 0.29)).toBe("before");
    expect(zoneAt(0, 0.3)).toBe("into");
    expect(zoneAt(0, 0.5)).toBe("into");
    expect(zoneAt(0, 0.7)).toBe("into");
    expect(zoneAt(0, 0.71)).toBe("after");
    expect(zoneAt(0, 0.98)).toBe("after");
  });

  it("refuses to guess from geometry it cannot trust", () => {
    expect(
      resolveDropZone({ clientY: 10, targetTop: 0, targetHeight: 0 }),
    ).toBeNull();
    expect(
      resolveDropZone({ clientY: Number.NaN, targetTop: 0, targetHeight: 28 }),
    ).toBeNull();
  });
});

describe("resolveTreeDrop", () => {
  it("drops onto the middle of a row as its last child", () => {
    expect(
      resolveTreeDrop({ rows, activeId: "beta", overId: "alpha", zone: "into" }),
    ).toEqual({ parentId: "alpha", beforeId: null, depth: 1, into: true });
  });

  it("drops on the top edge as the sibling before that row", () => {
    expect(
      resolveTreeDrop({
        rows,
        activeId: "beta",
        overId: "alpha-two",
        zone: "before",
      }),
    ).toEqual({
      parentId: "alpha",
      beforeId: "alpha-two",
      depth: 1,
      into: false,
    });
  });

  it("drops on the bottom edge as the sibling after that row", () => {
    expect(
      resolveTreeDrop({
        rows,
        activeId: "beta",
        overId: "alpha-one",
        zone: "after",
      }),
    ).toEqual({
      parentId: "alpha",
      beforeId: "alpha-two",
      depth: 1,
      into: false,
    });
  });

  it("appends when the hovered row is the last of its siblings", () => {
    expect(
      resolveTreeDrop({
        rows,
        activeId: "beta",
        overId: "alpha-two",
        zone: "after",
      }),
    ).toEqual({ parentId: "alpha", beforeId: null, depth: 1, into: false });
  });

  it("reads the two halves of one gap as two different parents", () => {
    // The boundary between "Alpha Two" (depth 1) and "Beta" (depth 0) is one
    // line on screen. Its upper half means "another child of Alpha"; its lower
    // half means "another root". This is what the horizontal drag offset used
    // to be for, without the offset.
    const asAlphaChild = resolveTreeDrop({
      rows,
      activeId: "gamma",
      overId: "alpha-two",
      zone: "after",
    });
    const asRoot = resolveTreeDrop({
      rows,
      activeId: "gamma",
      overId: "beta",
      zone: "before",
    });
    expect(asAlphaChild).toMatchObject({ parentId: "alpha", depth: 1 });
    expect(asRoot).toMatchObject({ parentId: null, depth: 0 });
  });

  it("never asks to place a page before itself", () => {
    // Dragging "Alpha One" onto the bottom edge of "Alpha" would name the next
    // sibling — which is "Alpha One". Skipping the dragged row gives the row
    // after it instead.
    expect(
      resolveTreeDrop({
        rows,
        activeId: "alpha-one",
        overId: "alpha",
        zone: "after",
      }),
    ).toEqual({ parentId: null, beforeId: "beta", depth: 0, into: false });
  });

  it("proposes nothing over the dragged row, an unknown row, or no zone", () => {
    expect(
      resolveTreeDrop({ rows, activeId: "beta", overId: "beta", zone: "into" }),
    ).toBeNull();
    expect(
      resolveTreeDrop({ rows, activeId: "beta", overId: "ghost", zone: "into" }),
    ).toBeNull();
    expect(
      resolveTreeDrop({ rows, activeId: "beta", overId: "alpha", zone: null }),
    ).toBeNull();
    expect(
      resolveTreeDrop({ rows, activeId: "beta", overId: null, zone: "into" }),
    ).toBeNull();
  });

  it("will not file a page into a collection, but still sorts around it", () => {
    expect(
      resolveTreeDrop({ rows, activeId: "beta", overId: "gamma", zone: "into" }),
    ).toBeNull();
    expect(
      resolveTreeDrop({
        rows,
        activeId: "beta",
        overId: "gamma",
        zone: "before",
      }),
    ).toEqual({ parentId: null, beforeId: "gamma", depth: 0, into: false });
  });
});
