/** Caret-anchored menus (slash, wiki-link) share one placement rule: open
 *  under the caret, clamped inside the editor's right edge, and moved above
 *  the caret when the visual viewport (which shrinks under the iOS keyboard,
 *  and loses the writing bar docked on it) has no room below. */

const EDGE_GUTTER = 8;

/** The air between the caret's line and the menu's edge. */
export const MENU_GAP = 6;

/** Left offset inside the editor root, never past the right edge. */
export function clampMenuLeft(caretLeft: number, rootWidth: number, menuWidth: number) {
  return Math.max(0, Math.min(caretLeft, rootWidth - menuWidth - EDGE_GUTTER));
}

export interface CaretMenuPlacement {
  side: "below" | "above";
  /** The menu's height cap: its own when the side holds it, the room when
   *  it does not. */
  maxHeight: number;
}

/** Below the caret when the menu fits there, above when only that side holds
 *  it, and otherwise the roomier side with the menu shrunk to the room. With
 *  the keyboard up a phone has 280 on neither side of a caret mid-screen,
 *  and a rule that only ever flipped put the menu under the keyboard. The
 *  viewport is the usable one: `visualViewport`'s own top and bottom, with
 *  anything docked on the bottom already taken off. */
export function placeCaretMenu(
  caret: { top: number; bottom: number },
  viewport: { top: number; bottom: number },
  menuHeight: number,
): CaretMenuPlacement {
  const below = viewport.bottom - caret.bottom - MENU_GAP;
  const above = caret.top - viewport.top - MENU_GAP;
  if (below >= menuHeight) return { side: "below", maxHeight: menuHeight };
  if (above >= menuHeight) return { side: "above", maxHeight: menuHeight };
  return above > below
    ? { side: "above", maxHeight: Math.max(0, above) }
    : { side: "below", maxHeight: Math.max(0, below) };
}
