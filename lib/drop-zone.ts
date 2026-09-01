/** One vertical model for every "drop a page onto a page" gesture in Brain.
 *
 * The editor's page-ref drag (components/editor/page-ref-nesting.ts) and the
 * sidebar tree drag (components/tree/sortable-tree.tsx) are two different drag
 * implementations — one is a native HTML5 drag inside ProseMirror, the other
 * is dnd-kit over a list of rows. They must not be two different *gestures*.
 * Both ask this function the same question about the same geometry: the middle
 * band of a row means "into this page", the bands above and below it mean
 * "between rows". A reader who learns the gesture in one place has learned it
 * in the other — including inside a column, where a page row is still a row and
 * still answers to this band. `column-drop.ts` listens to the same drag over
 * the same pixels and yields the centre band rather than proposing a second
 * outcome for one pointer.
 *
 * The band is deliberately narrower than half the row. An edge drop is the
 * common, cheap, reversible outcome; nesting reparents a whole subtree, so it
 * asks the pointer to commit to the middle. */

export const DROP_CENTRE_START = 0.3;
export const DROP_CENTRE_END = 0.7;

export type DropZone = "before" | "into" | "after";

export interface DropZoneInput {
  clientY: number;
  targetTop: number;
  targetHeight: number;
}

/** Null when the geometry cannot answer — an unmeasured row, a collapsed rect
 * mid-animation. Callers treat that as "no drop is proposed" rather than
 * guessing a zone from a rect they do not trust. */
export function resolveDropZone({
  clientY,
  targetTop,
  targetHeight,
}: DropZoneInput): DropZone | null {
  if (
    !Number.isFinite(clientY) ||
    !Number.isFinite(targetTop) ||
    !Number.isFinite(targetHeight) ||
    targetHeight <= 0
  ) {
    return null;
  }
  const ratio = (clientY - targetTop) / targetHeight;
  if (ratio < DROP_CENTRE_START) return "before";
  if (ratio > DROP_CENTRE_END) return "after";
  return "into";
}
