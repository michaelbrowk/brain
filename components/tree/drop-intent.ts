import type { DropZone } from "@/lib/drop-zone";

/** One row of the flattened, currently visible tree. The caller has already
 * removed the dragged page's own descendants, so every row here is a legal
 * neighbour and no drop resolved from this list can land inside the subtree
 * being moved. */
export interface TreeDropRow {
  id: string;
  parentId: string | null;
  depth: number;
  /** A collection owns its rows as imported data. Pages cannot be filed into
   * one, so its middle band proposes nothing. */
  collection?: boolean;
}

export interface TreeDrop {
  parentId: string | null;
  beforeId: string | null;
  /** The indent the feedback is drawn at, so the line says which parent it
   * means when two rows of different depth share a boundary. */
  depth: number;
  into: boolean;
}

/** Turn "the pointer is in this band of this row" into a placement.
 *
 * `into` appends to the hovered page. `before`/`after` make the dragged page a
 * sibling of the hovered row on that side — never a child of anything the
 * pointer is not actually on. That is what replaced the old horizontal-offset
 * nesting: the gap between two rows of different depth is not one ambiguous
 * boundary any more, it is the bottom half of the upper row and the top half
 * of the lower one, and each half means that row's own parent. */
export function resolveTreeDrop({
  rows,
  activeId,
  overId,
  zone,
}: {
  rows: readonly TreeDropRow[];
  activeId: string;
  overId: string | null;
  zone: DropZone | null;
}): TreeDrop | null {
  if (!zone || !overId || overId === activeId) return null;
  const overIndex = rows.findIndex((row) => row.id === overId);
  if (overIndex < 0) return null;
  const over = rows[overIndex];

  if (zone === "into") {
    if (over.collection) return null;
    return {
      parentId: over.id,
      beforeId: null,
      depth: over.depth + 1,
      into: true,
    };
  }

  if (zone === "before") {
    return {
      parentId: over.parentId,
      beforeId: over.id,
      depth: over.depth,
      into: false,
    };
  }

  // "after" needs the sibling that follows the hovered row once the dragged
  // page is out of the way — scanning past the dragged row is what keeps a
  // drop below one's own current position from asking to be placed before
  // itself. Descendants of the hovered row are skipped by the parent test.
  const nextSibling =
    rows
      .slice(overIndex + 1)
      .find((row) => row.id !== activeId && row.parentId === over.parentId)
      ?.id ?? null;
  return {
    parentId: over.parentId,
    beforeId: nextSibling,
    depth: over.depth,
    into: false,
  };
}
