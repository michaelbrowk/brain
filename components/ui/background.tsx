/** Background under glass (DESIGN.md v2 → Colour → edge tints).
 *
 *  Paints the paper plus the two radial edge tints the glass refracts. Both
 *  sit on the left, under the sidebar: a tint the glass never passes over is
 *  a glow on a wall, not light caught in a material.
 *  Mount it as the FIRST child of a surface whose root creates a stacking
 *  context (`isolate`); it sits at `--z-bg` (-1) inside that context, under
 *  every piece of content, positioned or not.
 *
 *  `mode` defaults to "auto": the look follows `<html data-bg>` ("still" |
 *  "live"), which layout.tsx restores from localStorage before paint and
 *  `setBackgroundMode()` (lib/appearance.ts) switches at runtime. Pass a
 *  mode to force one regardless of the setting (the dev stand does). `fixed`
 *  pins it to the viewport for full-window surfaces. */
export function Background({
  mode = "auto",
  fixed = false,
  className = "",
}: {
  mode?: "auto" | "still" | "live";
  fixed?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`brain-bg brain-bg-${mode} ${className}`}
      data-fixed={fixed ? "" : undefined}
    >
      <i />
      <i />
    </div>
  );
}
