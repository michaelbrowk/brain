"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { motion } from "framer-motion";
import { EASE_OUT } from "@/lib/motion";
import { IconButton } from "./ui/button";
import { Icon } from "./ui/icon";

const subscribeToClient = () => () => {};

/** The sidebar foot's theme switch — an IconButton 28 like the Trash beside
 *  it (DESIGN.md §12: icon ink-2 → ink on hover over the ink tint, press
 *  .90), with the sun and the moon crossfading inside it. It used to be a
 *  v1 square of its own: ink-3 at rest, a .04 tint on hover, ΔL .035 — on
 *  the floor of §8's .03 while every neighbour measures .05 and more. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribeToClient,
    () => true,
    () => false,
  );

  const isDark = resolvedTheme === "dark";
  // Both icons stay mounted in the same grid cell; framer retargets
  // opacity/rotation mid-flight on rapid toggles, so no swap state ever
  // leaves the button empty.
  const showSun = mounted && isDark;
  return (
    <IconButton
      size={28}
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      <motion.span
        initial={false}
        animate={{
          opacity: showSun ? 1 : 0,
          rotate: showSun ? 0 : 90,
          scale: showSun ? 1 : 0.7,
        }}
        transition={{ duration: 0.2, ease: EASE_OUT }}
        className="col-start-1 row-start-1 flex"
        aria-hidden={!showSun}
      >
        <Icon name="sun-linear" size={16} />
      </motion.span>
      <motion.span
        initial={false}
        animate={{
          opacity: showSun ? 0 : 1,
          rotate: showSun ? 90 : 0,
          scale: showSun ? 0.7 : 1,
        }}
        transition={{ duration: 0.2, ease: EASE_OUT }}
        className="col-start-1 row-start-1 flex"
        aria-hidden={showSun}
      >
        <Icon name="moon-linear" size={16} />
      </motion.span>
    </IconButton>
  );
}
