/** Motion tokens — the single source for durations/easings/springs.
 *  Components never hardcode curves; they import from here. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export const DUR = {
  /** Exits that must clear the way for frequent swaps (page, skeleton). */
  exit: 0.08,
  fast: 0.12,
  base: 0.16,
  page: 0.22,
} as const;

/** Snappy spring for overlays/snackbars. */
export const SPRING = { type: "spring", stiffness: 500, damping: 32 } as const;

/** Tap feedback — exactly two scales, not five. */
export const TAP = { scale: 0.97 } as const;
export const TAP_ICON = { scale: 0.88 } as const;

/** Standard enter/exit presets. */
export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: DUR.fast } },
  transition: { duration: DUR.fast },
};

export const pop = {
  initial: { opacity: 0, scale: 0.98, y: -6 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.99, transition: { duration: DUR.fast } },
  transition: { duration: DUR.base, ease: EASE_OUT },
};

export const pageTransition = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  // exit must be much faster than enter — page switches are frequent
  exit: { opacity: 0, transition: { duration: DUR.exit } },
  transition: { duration: DUR.page, ease: EASE_OUT },
};

/** Reduced-motion stand-in for `pageTransition`: a plain crossfade. */
export const pageFade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: DUR.exit } },
  transition: { duration: DUR.fast },
};

export const slideUp = {
  initial: { opacity: 0, y: 24, scale: 0.95 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 16, scale: 0.95 },
  transition: SPRING,
};

/* ── Liquid Glass v2 presets ───────────────────────────────────────────────
   Springs in Apple terms (damping / response) mapped to framer-motion's
   `bounce` + `duration` form. damping 1.0 = no overshoot; bounce only where a
   gesture carried momentum. Everything the user drags animates on these from
   the current value, never via CSS transitions. */

/** Sidebar collapse/expand, sidebar slot swap, settings section. 1.0 / 0.30 */
export const SPRING_PANEL = { type: "spring", bounce: 0, duration: 0.3 } as const;
/** Selection capsule flowing between rows (`layoutId`), segmented control. 1.0 / 0.25 */
export const SPRING_SELECT = { type: "spring", bounce: 0, duration: 0.25 } as const;
/** Sheets and drawers when opened/closed by a button. 1.0 / 0.30 */
export const SPRING_SHEET = { type: "spring", bounce: 0, duration: 0.3 } as const;
/** Sheets released from a drag — the only preset with bounce. 0.8 / 0.30 */
export const SPRING_SHEET_GESTURE = { type: "spring", bounce: 0.2, duration: 0.3 } as const;

/** Press: scale on pointer-down, 100ms ease-out; hover fills 80ms in / 160ms out. */
export const PRESS = { scale: 0.97, duration: 0.1 } as const;
export const PRESS_ICON = { scale: 0.9, duration: 0.1 } as const;
export const HOVER = { in: 0.08, out: 0.16 } as const;

/** Menus, popovers, palette, dialogs: opacity + scale .96→1 from the trigger.
 *  Exit retraces the path in 120ms ease-in. Blur is never animated — the
 *  "glass arrived" feel comes from the material's edge-light, not a filter
 *  ramp. Pass `transformOrigin` from the trigger's position. */
export function materialize(transformOrigin = "top left") {
  return {
    initial: { opacity: 0, scale: 0.96 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.96, transition: { duration: DUR.fast, ease: "easeIn" } },
    transition: { type: "spring", bounce: 0, duration: 0.22 },
    style: { transformOrigin },
  } as const;
}

/** Reduced-motion stand-in for `materialize`: a 120ms opacity crossfade. */
export const materializeFade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: DUR.fast } },
  transition: { duration: DUR.fast },
} as const;
