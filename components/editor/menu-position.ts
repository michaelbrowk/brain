/** Caret-anchored menus (slash, wiki-link) share one placement rule: open
 *  under the caret, clamped inside the editor's right edge, and flipped above
 *  the caret when the visual viewport (which shrinks under the iOS keyboard)
 *  has no room below. */

const EDGE_GUTTER = 8;

/** Left offset inside the editor root, never past the right edge. */
export function clampMenuLeft(caretLeft: number, rootWidth: number, menuWidth: number) {
  return Math.max(0, Math.min(caretLeft, rootWidth - menuWidth - EDGE_GUTTER));
}

/** Flip above the caret only when there is no room below and enough above. */
export function shouldFlipAbove(
  caret: { top: number; bottom: number },
  viewportHeight: number,
  menuHeight: number,
) {
  return viewportHeight - caret.bottom < menuHeight && caret.top > menuHeight;
}
