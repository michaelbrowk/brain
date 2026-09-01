"use client";

import { motion, type HTMLMotionProps } from "framer-motion";
import { TAP, TAP_ICON } from "@/lib/motion";

/** v1 variants (solid / ghost / pill) stay until the last surface is
 *  restyled; the v2 set is styled by the `.btn*` classes in globals.css and
 *  carries all five states (rest / hover / active / focus-visible /
 *  disabled) there. Press on v2 is CSS `:active` (scale .97, 100ms, none
 *  under reduced motion) — framer's whileTap is v1 only. */
type Variant = "solid" | "ghost" | "pill" | "glass" | "quiet" | "ink" | "accent" | "destructive";

const styles: Record<Variant, string> = {
  // solid ink — the single strong action (monochrome system: no hue)
  solid:
    "rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-paper transition-opacity hover:opacity-90",
  // ghost — quiet inline action
  ghost:
    "rounded-md px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink",
  // pill — snackbar / floating contexts (hover: the ink tint over paper)
  pill: "tint-hover rounded-full bg-paper px-4 py-1.5 text-[13px] font-semibold text-ink",
  // v2 — regular-material capsule 32, floats on paper
  glass: "btn btn-glass tint-hover",
  // v2 — ink-2 text on glass or paper, tint + ink on hover
  quiet: "btn btn-quiet",
  // v2 — the filled primary inside dialogs
  ink: "btn btn-ink",
  // v2 — the one ink-filled circle per surface (34); pass an icon child
  accent: "btn btn-accent",
  // v2 — red text, red tint on hover
  destructive: "btn btn-destructive",
};

const V2 = new Set<Variant>(["glass", "quiet", "ink", "accent", "destructive"]);

const disabledStyle = "disabled:pointer-events-none disabled:opacity-40";

export function Button({
  variant = "solid",
  className = "",
  ...props
}: HTMLMotionProps<"button"> & { variant?: Variant }) {
  const v2 = V2.has(variant);
  return (
    <motion.button
      whileTap={v2 ? undefined : TAP}
      className={`brain-touch-min ${styles[variant]} ${v2 ? "" : disabledStyle} ${className}`}
      {...props}
    />
  );
}

/** Icon-only button. v2 sizes are capsules: 28 in rows and menus, 36 inside
 *  a toolbar pill (`.icon-btn` in globals.css: hover tint + icon ink-2 → ink,
 *  press .90). "sm" / "md" are the v1 squares the old UI still uses. */
export function IconButton({
  className = "",
  size = "md",
  ...props
}: HTMLMotionProps<"button"> & { size?: "sm" | "md" | 28 | 36 }) {
  if (size === 28 || size === 36) {
    return (
      <motion.button
        data-size={size}
        className={`brain-touch-min icon-btn focus-inset ${className}`}
        {...props}
      />
    );
  }
  const dim = size === "sm" ? "size-5" : "size-7";
  return (
    <motion.button
      whileTap={TAP_ICON}
      className={`brain-touch-min grid ${dim} shrink-0 place-items-center rounded-xs text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2 ${disabledStyle} ${className}`}
      {...props}
    />
  );
}
