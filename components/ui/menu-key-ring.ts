"use client";

import { useMemo, useRef } from "react";

/** THE RING IN A MENU BELONGS TO THE KEYS.
 *
 *  The keyboard ring is gated on `html[data-kbd]` (`<InputModality/>`), which
 *  an arrow key sets and only a pointer DOWN clears. A Radix menu focuses the
 *  row under the pointer as it moves, so after one arrow key the ring followed
 *  the mouse from row to row. While a row's ring stood outside it and the
 *  menu's padding swallowed most of that, it passed. On rows that carry
 *  `focus-inset` it is a full ring inside whatever the pointer rests on, which
 *  says "the keyboard is here" about a row the keyboard is not on.
 *
 *  So the menu says which of the two moved focus last, as `data-key-ring` on
 *  its content: `keys` after a key press inside it, `pointer` after the next
 *  pointer move. `globals.css` draws the ring on a row only under `keys`, and
 *  keeps the row's own radius while it is focused.
 *
 *  It is an attribute written on the element, the way `data-kbd` is, and not
 *  state: nothing renders differently for it, and the content mounts anew
 *  each time the menu opens, which is where it takes its first value from the
 *  modality that opened it.
 *
 *  Spread the result on the menu's `Content`. */
export function useMenuKeyRing(): {
  ref: (node: HTMLElement | null) => void;
  onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
} {
  const pointer = useRef<{ x: number; y: number } | null>(null);
  return useMemo(
    () => ({
      ref: (node) => {
        if (!node) return;
        pointer.current = null;
        node.dataset.keyRing =
          document.documentElement.dataset.kbd === "true" ? "keys" : "pointer";
      },
      onKeyDownCapture: (event) => {
        // A modifier on its own moves nothing, so it claims nothing.
        if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
        event.currentTarget.dataset.keyRing = "keys";
      },
      onPointerMove: (event) => {
        // A list that scrolls under a resting pointer is reported as a move
        // to where the pointer already was, and an arrow key into the fold
        // does exactly that. Only a move that goes somewhere is the pointer's.
        const last = pointer.current;
        pointer.current = { x: event.clientX, y: event.clientY };
        if (last === null || (last.x === event.clientX && last.y === event.clientY)) {
          return;
        }
        event.currentTarget.dataset.keyRing = "pointer";
      },
    }),
    [],
  );
}
