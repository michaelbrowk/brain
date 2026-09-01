# Brain design system

v2 "Liquid Glass" is the constitution — see `DESIGN.md` at the repo root. The
notes below describe the v1 layer that still renders the current surfaces;
new work uses the v2 atoms: `mat-thin/reg/thick` + `mat-fill-*` (materials and
fills), `text-title…text-kbd` (registers), `ScrollEdge`/`useScrollEdge`
(`scroll-edge.tsx`), `Background` (`background.tsx`), `Icon variant="bold"`,
and the springs in `lib/motion.ts`. Dev stand: `/dev/glass`.

Monochrome ink-on-paper. The only colour on screen is the user's text.

## Layers

1. **Tokens** — `app/globals.css` (CSS vars, OKLCH) + `lib/motion.ts` (durations,
   easings, springs). Components NEVER hardcode a colour, radius, or bezier.
2. **Primitives** — this folder: `Icon` (Solar, generated), `Button`/`IconButton`,
   `Kbd`, `Skeleton`, `Snackbar`, `ConfirmDialog`.
3. **Composition** — `components/` (shell, tree, palette, editor) built ONLY
   from tokens + primitives.

## Rules

- **No accent hue.** Interaction states are neutral ink fills (`--fill-hover`,
  `--fill-active`); emphasis is weight, not colour.
- **Icons: Solar only** (`components/ui/icon.tsx`). Add names to
  `scripts/gen-icons.mjs` → `node scripts/gen-icons.mjs`.
- **Type registers:** UI/chrome 13px · list rows 13–14px · body 16/1.7 ·
  title 28–30/600. Don't invent new sizes; change the set deliberately.
- **Radii:** xs4 sm6 md8 lg12 xl16 (`--r-*`). One system.
- **Motion:** import from `lib/motion.ts`. Frequent actions get feedback
  (tap-scale); page/overlay transitions use `pop`/`pageTransition`/`slideUp`.
  Reduced-motion is handled globally (`MotionConfig reducedMotion="user"`).
- **No cards, no left-border stripes, no fake terminals.** Group with air and
  1px `--line` hairlines.
- **Grow the system deliberately:** if a screen needs something the system
  lacks, add a primitive/token here first, then use it — don't inline styles.
