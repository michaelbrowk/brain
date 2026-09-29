"use client";

import { motion, useIsPresent, type HTMLMotionProps } from "framer-motion";

/** THE CANVAS UNDER THE PAGE TRANSITION, WHICH TAKES NO INPUT ON ITS WAY OUT.
 *
 *  The shell swaps canvases inside `AnimatePresence mode="wait"`, so the one
 *  leaving stays in the document through its exit, and the one arriving
 *  mounts only after it has gone. For those frames the leaving editor was
 *  still visible, focusable and editable: a return to the same page inside the
 *  window typed into it, the canvas that mounted next read the cached body,
 *  and the keystrokes went to the draft while the screen showed the old text
 *  under a conflict banner.
 *
 *  `useIsPresent` turns false in the render that starts the exit, so the
 *  leaving canvas is inert from that commit on. The browser drops focus out
 *  of an inert subtree and never lets it back in, which leaves the arriving
 *  editor as the only place keys can land. `aria-hidden` says the same to
 *  assistive technology and to anything that finds the editor by its role.
 *  Reduced motion swaps the preset, not the presence, so this holds there
 *  too. */
export function CanvasPresence(props: HTMLMotionProps<"div">) {
  const present = useIsPresent();
  return (
    <motion.div
      {...props}
      inert={!present || undefined}
      aria-hidden={!present || undefined}
    />
  );
}
