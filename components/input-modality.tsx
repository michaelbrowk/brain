"use client";

import { useEffect } from "react";

/** Tracks HOW the user is driving the app. `:focus-visible` alone isn't
 *  enough: Radix menus/popovers return focus to their trigger with .focus()
 *  on close, and WebKit treats programmatic focus as focus-visible — so every
 *  mouse click on "New page" or a "…" menu left a black ring behind. The ring
 *  is only meaningful when focus moves via the keyboard, so gate it on the
 *  last input modality (globals.css scopes the outline to html[data-kbd]). */
export function InputModality() {
  useEffect(() => {
    const el = document.documentElement;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" || e.key.startsWith("Arrow")) el.dataset.kbd = "true";
    };
    const onPointer = () => {
      delete el.dataset.kbd;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);
  return null;
}
