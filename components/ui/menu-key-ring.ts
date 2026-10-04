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
 *  its content: `keys` after a key press inside it, `pointer` after the mouse
 *  next goes somewhere. `globals.css` draws the ring on a row only under
 *  `keys`, and keeps the row's own radius while it is focused.
 *
 *  A MOUSE, AND ONE THAT WENT SOMEWHERE. Radix moves focus for a mouse and
 *  for no other pointer, so a pen or a finger passing over the menu has taken
 *  the focus nowhere and leaves the ring alone. And a browser reports a list
 *  that scrolls under a resting pointer as a move to where the pointer
 *  already was, which an arrow key into the fold does every time: only a
 *  move to another place is the pointer's. Coming into the menu from outside
 *  is such a move by itself, with one exception. A menu the keyboard opened
 *  may have opened under a pointer that was resting there, and the first
 *  entry it sees can be that one, so it only notes the place.
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
  onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
} {
  // Where the mouse was last seen inside this opening of the menu, and
  // whether it may have been resting under the menu when it opened.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const mayRest = useRef(false);
  return useMemo(
    () => ({
      ref: (node) => {
        if (!node) return;
        const keys = document.documentElement.dataset.kbd === "true";
        pointer.current = null;
        mayRest.current = keys;
        node.dataset.keyRing = keys ? "keys" : "pointer";
      },
      onKeyDownCapture: (event) => {
        // A modifier on its own moves nothing, so it claims nothing.
        if (MODIFIER_KEYS.has(event.key)) return;
        event.currentTarget.dataset.keyRing = "keys";
      },
      onPointerEnter: (event) => {
        if (event.pointerType !== "mouse") return;
        pointer.current = { x: event.clientX, y: event.clientY };
        if (mayRest.current) {
          mayRest.current = false;
          return;
        }
        event.currentTarget.dataset.keyRing = "pointer";
      },
      onPointerMove: (event) => {
        if (event.pointerType !== "mouse") return;
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

/** Every `KeyboardEvent.key` that only changes what another key means (the
 *  UI Events modifier keys, and `OS`, which older engines say for Meta). */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);
