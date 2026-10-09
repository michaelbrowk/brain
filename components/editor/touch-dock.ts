"use client";

import { useEffect, useState } from "react";

/** The keyboard's height, the way a fixed element has to know it: the layout
 *  viewport keeps its height under the iOS keyboard, and only the visual
 *  viewport shrinks, so `bottom: 0` is under the keys and `bottom: inset` is
 *  on top of them. */
export function keyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
}

/** The keyboard's height on its own: what the visual viewport lost, which a
 *  pan over the page (offsetTop) does not change. The inset says where to
 *  dock; this says how much of the page the keyboard covers. */
export function keyboardHeight(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, window.innerHeight - vv.height);
}

/** Below this the lost height is a URL bar settling or a rounding, not a
 *  keyboard: the shell's own threshold for hiding the tab bar. */
export const KEYBOARD_MIN = 120;

/** The two facts every bar docked above the keyboard reads: that this is a
 *  touch screen (the selection toolbar's own query, `hover: none` with a
 *  coarse pointer, which an iPad with a trackpad answers no to), and how
 *  much of the window the keyboard is covering right now, as the inset to
 *  dock at and as the keyboard's own height. One hook, so the selection
 *  toolbar and the writing bar never disagree about any of it. */
export function useTouchDock(): { isTouch: boolean; kbInset: number; kbHeight: number } {
  const [isTouch, setIsTouch] = useState(false);
  const [kbInset, setKbInset] = useState(0);
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia("(hover: none) and (pointer: coarse)");
    const onMq = () => setIsTouch(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    const vv = window.visualViewport;
    const onVv = () => {
      setKbInset(keyboardInset());
      setKbHeight(keyboardHeight());
    };
    onVv();
    vv?.addEventListener("resize", onVv);
    vv?.addEventListener("scroll", onVv);
    return () => {
      mq.removeEventListener("change", onMq);
      vv?.removeEventListener("resize", onVv);
      vv?.removeEventListener("scroll", onVv);
    };
  }, []);
  return { isTouch, kbInset, kbHeight };
}

/** The visual viewport's top and bottom in layout coordinates, less what is
 *  docked on its bottom edge: the band a caret menu may stand in. */
export function usableViewport(dockOffset: number): { top: number; bottom: number } {
  const vv = window.visualViewport;
  const top = vv?.offsetTop ?? 0;
  const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  return { top, bottom: bottom - dockOffset };
}
