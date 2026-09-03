---
name: Brain
description: Paper is the whole window. Chrome is glass floating over it.
colors:
  paper: "oklch(0.988 0.004 91)"
  ink: "oklch(0.232 0.004 286)"
  ink-2: "oklch(0.480 0.010 278)"
  ink-3: "oklch(0.540 0.008 286)"
  ink-4: "oklch(0.622 0.007 286)"
  hair: "color-mix(in oklch, var(--ink) 10%, transparent)"
  blue: "oklch(0.520 0.186 258)"
  accent: "oklch(0.232 0.004 286)" # = ink; dark inverts to paper
  accent-ink: "oklch(0.988 0.004 91)" # = paper; dark inverts to ink
  yellow: "oklch(0.821 0.149 85)" # transient handles + stickers only
  yellow-ink: "oklch(0.262 0.053 91)"
  red: "oklch(0.553 0.225 27)"
  glass-thin: "oklch(1 0 0 / 0.70)"
  glass-reg: "oklch(1 0 0 / 0.66)"
  glass-thick: "oklch(1 0 0 / 0.58)"
  sticker: "oklch(0.94 0.083 95)"
  sticker-ink: "oklch(0.32 0.045 95)"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Inter, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Inter, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  subheading:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Inter, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  h3:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Inter, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Inter, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.2px"
  table:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "-0.15px"
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.08px"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "18px"
    letterSpacing: "0.06px"
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "0"
  kbd:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.06px"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  block: "8px"
  table: "10px"
  row: "14px"
  popover: "14px"
  sticker: "14px"
  field: "16px"
  group: "16px"
  pill: "18px"
  sheet: "20px"
  palette: "22px"
  panel: "26px"
components:
  pill:
    backgroundColor: "{colors.glass-reg}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "36px"
  panel:
    backgroundColor: "{colors.glass-thick}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "12px"
  row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.row}"
    padding: "0 4px 0 10px"
    height: "28px"
  accent-button:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "50%"
    size: "34px"
  ink-button:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.control}"
    rounded: "10px"
    padding: "0 12px"
    height: "32px"
  glass-button:
    backgroundColor: "{colors.glass-reg}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "9999px"
    padding: "0 12px"
    height: "32px"
  chip:
    backgroundColor: "oklch(1 0 0 / 0.50)"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.row}"
    padding: "0 10px 0 8px"
    height: "28px"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.table}"
    rounded: "10px"
    padding: "0 10px"
    height: "32px"
  menu:
    backgroundColor: "{colors.glass-reg}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.popover}"
    padding: "6px"
  dialog:
    backgroundColor: "{colors.glass-thick}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.control}"
    rounded: "9999px"
---

# Design System: Brain — v2 "Liquid Glass"

## North Star

**Paper is the whole window. Chrome is glass that floats over it.** The document fills the canvas edge to edge and has no borders of its own. Every piece of navigation and control is a floating glass panel with one shared inset of 12px, and the content scrolling under it stays visible through it. Glass in Brain is functional, not decorative: it answers exactly one question — what is above what — and nothing else. Text always sits on opaque paper. The system's one memorable object is the ink-filled round button in the corner of a glass panel — the single primary action per surface, black on paper and inverted in dark. The chrome carries no hue: yellow exists only as a transient handle and on stickers.

What v2 keeps from v1 "Ink on Paper": warm paper, one type scale, Solar icons, the ban on decorative cards, the absence of a second accent. What it lifts: the bans on glass, on shadows under floating panels, and on system blue. Chrome stops being "compact and quiet" and becomes a separate layer with its own physics.

Sources in this repository: tokens in `app/globals.css`, motion presets in `lib/motion.ts`, atoms in `components/ui/`. The look came from a standalone HTML concept and from Apple's guidance on materials, motion and typography, neither of which ships here. This document is the contract; where it and a memory of the concept disagree, this document wins.

## 1. Materials

Three thicknesses. Thickness encodes hierarchy: the larger the surface, the thicker the glass.

| Material | blur / saturate | Fill light | Fill dark | Edge | Shadow | Radius | Where |
|---|---|---|---|---|---|---|---|
| **thin** `mat-thin` | 12px / 160% | white .70 | rgb(44 44 48 / .55) | inset top white .80 | `--shadow-1` | capsule | block drag handle, tooltip, kbd on paper, floating "new mail" chip |
| **regular** `mat-reg` | 18px / 170% | white .66 | rgb(40 40 44 / .60) | `--edge-light` + `--rim` | `--shadow-2` | 18 (36px capsule), popover 14 | toolbar pills, breadcrumb, menus, popovers, floating text toolbar, share popover |
| **thick** `mat-thick` | 28px / 180% | white .58 + top sheen | rgb(34 34 38 / .62) + sheen white .10 | `--edge-light` + `--rim` | `--shadow-3` | 26 (sidebar), 20 (sheet, dialog), 22 (palette) | floating sidebar, command palette, dialogs and sheets, settings navigation |

Rules:

- **Opaque surfaces**: paper (canvas, editor, tables, hub, settings content, the HTML message sheet and the reader strip in Mail — §13's ground rule leaves the mail column and the reader pane on the canvas), sticker (yellow gradient — content), toast (inverted ink capsule — a transient must read over anything, HTML mail included), the ink-filled primary (the round button in a panel's corner, the primary in dialogs).
- **No glass on glass.** A second `backdrop-filter` inside an element that has one is forbidden. The selected row in the sidebar (white .78 under an ink veil .04, rim ink .14 + `0 1px 2px` — white alone measured ΔL .006 on the thick material over paper), pinned chips (white .50), kbd on glass — these are **fills**, not materials: `mat-fill-selected`, `mat-fill-chip`, `mat-fill-hover`. Text on a fill is 600 and full ink.
- **Text on glass**: ink (100%) and ink-2 only; weight ≥ 500. ink-3 on glass is forbidden; ink-4 is never text (dividers, disabled icons).
- **Text in toolbar pills and the breadcrumb is ink only** (adopted at the Phase 0 review): weight ≥ 500, no ink-2, no blue. The Phase 0 stand measured ink-2 on regular glass over a dark cover at ~3:1 and blue lower still, and a pill travels over anything the canvas shows. Consequences: the "Edited 2h ago" meta leaves the pill and lives on paper in the title block (Phase 2); the breadcrumb parent is ink 500 followed by a chevron — blue stays for links on paper. Planned, not built: Phase 2 adds a **pill polarity** atom, `data-polarity="dark"` → dark material + light ink, so a pill over a dark cover follows the cover's luminance instead of fighting it.
- **Glass only over its own scroller.** A panel blurs the content that passes under it in the same window. Glass over foreign heavy content (HTML mail with images) is forbidden — the message keeps its own paper sheet and anything above it (the reader strip) is opaque paper, never a material.
- **Fallback** — three conditions, one result ("matte glass"), remapped in one block in `globals.css`:
  - `prefers-reduced-transparency: reduce` → fill white .97 / dark .97, blur off, rim 1px ink .14, sheen off, scroll-edge becomes a paper gradient, and the white fills take a paper rule — white on a .97 white surface is invisible: the selected capsule becomes the blue tint .08 (dark keeps white .14), the pinned chip an ink tint .05 (dark keeps white .08), kbd and skeleton their paper fills. Hover stays the layered ink tint.
  - `prefers-contrast: more` → fill .98, border 1px ink .50, ink-2 → `#3E3F44`, hair → .30.
  - `@supports not (backdrop-filter: blur(1px))` → same as reduced transparency.
  - `html[data-glass-fallback="matte|contrast"]` forces either for tests and the dev stand.

## 2. Colour

Tokens are stored in oklch. The hex values are the concept's; every conversion round-trips within ΔE 0.1.

| Token | Light | Dark | Role |
|---|---|---|---|
| paper | `#FCFBF8` | `oklch(.205 .006 75)` | canvas, all content |
| edge tint | sky `#CBDDF0` @.42 / sand `#EEDFC6` @.38, two radials, both on the left | same hues, chroma ×0.5, alpha .18 | glass needs something to refract, so a tint lives where glass passes over it; the third radial sat on open canvas at the window's right edge and read as a glow on a wall — removed. Static by default |
| ink | `#1D1D1F` | `oklch(.92 .006 85)` | text, icons in pills |
| ink-2 | `#5C5D63` | `oklch(.75 .006 85)` | secondary, the only grey on glass |
| ink-3 | `#6E6E73` | `oklch(.62 .006 75)` | sources, captions — paper only |
| ink-4 | `#86868B` | `oklch(.52 .006 75)` | not text: dividers, faint markers, disabled |
| hair / hair-soft | ink .10 / .07 | white .12 / .08 | table grid, hr, structural lines inside paper |
| hair-field / hair-field-strong | ink .53 / .62 | white .36 / .50 | the one hairline held to WCAG 1.4.11: a field's boundary is what says "type here". Measured against paper by `e2e/mail-connect.spec.ts`: 3.42:1 rest and 4.46:1 hover (light), 3.36:1 and 5.26:1 (dark). The .10 hair reads 1.22:1 and is not a boundary |
| hair-field-invalid | red .70 (3.75:1) | red .70 (3.69:1) | the same ring on a field the form rejected. Rest keeps 1.4.11's 3:1 on its own, so the hue is the extra signal and never the only one; hover and focus step to full `--red` (5.20:1 light, 6.34:1 dark) |
| fill-tint | ink .05 | white .10 | the quiet tint of a small paper object — status badge, 28px icon tile, segmented track. Dark cannot reuse .05: it lands under the noise floor of the dark ground |
| blue | `#0B63D1` (5.6:1 on paper) | `#4C9CF5` | links on paper, focus ring (.55), toggle on, and the two selection tints: a table row on paper at .06–.08, a mail row on the canvas at .18 / .24 with a 1px rim of the same blue at .22 / .28 (`--blue-rim`). Mail is the higher pair because it has nothing else left to lean on — see §13 — never text on glass (the breadcrumb parent is ink) |
| accent / accent-ink | ink `#1D1D1F` fill + paper `#FCFBF8` glyph (16.3:1, hover 12.7:1) | inverted: `oklch(.92 .006 85)` fill + `oklch(.205 .006 75)` glyph (14.1:1, hover 10.9:1) | **one** ink-filled primary action per surface; hover lightness ±.08 (`--accent-hover`), press scale .97 |
| yellow | `#F0BC3C` + yellow-ink `#2E2300` (9:1) | `#F2C24D` | transient handles and insertion indicators, stickers — never a button |
| red | `#D70015` | `#FF6961` | destructive confirmations and errors only — red text, a red tint .08 on hover (`--red-tint`), never a red fill |
| sticker / tc-* / tb-* | unchanged | unchanged | content, not chrome |

Dark ink-2 is `.75`, not the v1 `.72`: on thick glass over the lightest dark backdrop the Phase 0 stand measured 4.12:1 at `.72`; `.75` clears AA.

Dosage:

- **Primary**: one ink-filled control per surface, where a **surface is a panel or a pane, not the window** — the sidebar and an open sheet each get one, and a screenshot showing both is not a violation (§13 pins this against the mail frames). Sidebar → New page; mobile tab bar → New; Mail → none in the column, the composer sheet's Send when a sheet is open; Login → Sign in; Settings → none at rest, and the submit of whatever form is open — Connect, Save changes, Apply import — because a form is a surface with exactly one way out. Light: ink fill, paper glyph; dark: the inverse. Resting area ≤ 0.1% of the viewport (a 34px circle at 1440×900 is 0.07%). Hover lightens (light) or darkens (dark) the fill by .08 oklch, 80ms in / 160ms out; press is `PRESS` (scale .97, 100ms). A second filled control on the same surface is forbidden.
- **Yellow**: transient handles and insertion indicators only (hover and drag in the table and tree), gone with the gesture — and the sticker, which is content. No button is ever yellow.
- **Blue**: link text, focus, selection. No blue filled buttons — that would be two primary colours.
- **Chrome without hue**: glass is white or graphite only. Coloured glass is forbidden.

## 3. Typography

Stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Inter", system-ui, "Segoe UI", Roboto, sans-serif` (`--font-sf`, Tailwind `font-system`). On Apple devices this is SF with automatic Text/Display switching at ≥ 20px and native Cyrillic. Elsewhere (share pages on Windows) the self-hosted Inter with its Cyrillic subsets comes second — it stays in the repo as the fallback. JetBrains Mono stays for code. Literata stays as the one "Reading typeface" option. `font-optical-sizing: auto`, `-webkit-font-smoothing: antialiased`, `font-variant-numeric: tabular-nums` in tables, dates, counters (`text-table`, `text-kbd`, or `tabular-nums`).

Registers (the only allowed set; a new size is a design decision, not a styling shortcut):

| Register | Utility | Size / weight / lh / tracking | Where |
|---|---|---|---|
| Title | `text-title` | 30 / 700 / 1.15 / −0.02em | page title |
| Heading | `text-heading` | 22 / 700 / 1.2 / −0.015em | H1 in a document |
| Subheading | `text-subheading` | 17 / 600 / 1.3 / −0.02em | H2, lead line, dialog title |
| H3 | `text-h3` | 15 / 600 / 1.35 / −0.01em | H3, settings group titles |
| Body | `text-body` | 16 / 400 / 1.5 / −0.2px | editor, hub, settings descriptions |
| Table | `text-table` | 14 / 400 / 1.35 / −0.15px | tables, mail list, palette rows |
| Control | `text-control` | 13 / 500 / 1 / −0.08px | sidebar, pills, menus, buttons, dialog rows |
| Label | `text-label` | 11 / 600 / 18px / +0.06px | "Pinned", "Pages", menu section titles, palette group headings, a dialog's list label ("History") — sentence case, never uppercase |
| Caption | `text-caption` | 12 / 400 / 1.35 / 0 | timestamps, captions |
| Kbd | `text-kbd` | 11 / 500 / 1 / +0.06px | shortcuts |

Weight inside the Table register carries meaning, so it is not a taste call. **600 (`font-semibold`) is a subject** — the thing the row is about, with its own Caption line under it: an account, a connected app, a backup verdict, an archive being imported. **500 (`font-medium`) is a label** — it names a setting or a destination whose control, value, or chevron sits at the row's right: "Security", "Archives kept", "Open Mail", every form label. **400 is a sentence** — a status line or an explanation that is neither ("Stale — no recent backup attempt was recorded."). A row never carries two 600s.

Tracking is tied to size (Apple): ≥ 20px negative −0.015…−0.02em, 14–17px −0.15…−0.2px, 13px −0.08px, ≤ 11px positive. One value for all sizes is forbidden. Body line-height is 1.5 (was 1.7 under Inter); on review of a long editor page 1.55 is acceptable, nothing higher.

Single-line labels: Control's line-height 1 is for the control box, not for a truncating span — `overflow: hidden` on a 13px line box clips descenders ("g j p y q"). Every truncated label inside a control (tree row, chip, breadcrumb, menu item, palette row, toast) takes a 1.25 line box (one rule in the `Components (v2)` block of `globals.css`), and a decoration such as the breadcrumb underline goes on the label span, never on the emoji or icon beside it. The stand's "Truncation · descenders" row and `e2e/design-audit.spec.ts` hold it.

Cyrillic: SF covers it fully; the Inter fallback ships Cyrillic and Cyrillic-ext subsets. Page emoji render natively (Apple Color Emoji): 14px in rows, 44px in the page title; Segoe UI Emoji is acceptable on share pages.

## 4. Geometry

- **One inset, 12px** (`--inset`): sidebar top/left/bottom 12; toolbar top 12; sidebar↔canvas gap 12; right 12. Nothing floating touches the window edge. Mobile: 8px + safe area.
- **The inset is kept from the edge of the surface an object floats over, and the canvas is a surface.** The document column starts at `--canvas-offset` = inset + sidebar + inset (304 with the 280 sidebar), so the canvas's own left edge stands 12 from the sidebar's glass, and a pill floating over the canvas keeps the same 12 inside it: the breadcrumb, the mail nav pill and the settings crumb all land at 316, **24 from the sidebar's right edge**, at every width and on every surface. That 24 is two insets, not a wider one — the toolbar keeps to the canvas at its left what it keeps to the window at its right, and the sidebar keeps to the canvas what it keeps to the window. An earlier line here read "sidebar↔toolbar gap 12" and named half of it: the product was right by this rule and the line was wrong. The toast column is centred on the same canvas (§12, Toast).
- **What floats is sized by its content, not by the window.** The inset says how close a floating object may come to the edge; it never says the object reaches it. Every pill in the product is shrink-to-fit — breadcrumb, toolbar, toast — and so is the **mobile tab bar**: five slots of `--tabbar-slot` plus the row's 4px ends, `width: fit-content` between the two insets with `margin-inline: auto`. **One measurement gives the slot**: the widest label is "Search" at 37.6 (Label 11/500), 11px of air on each side is 59.6, and the 4px step above rounds that to 60 — 11.2 as built. Five of them plus the ends is 308, and the bar holds 308 at every window that leaves it that much between the insets (≥ 324): clearance 41 on each side at 390, 61 at 430, 66 at 440. It used to divide the full width into five equal parts, 73px slots holding a 38px word, and a run of five of those reads as a backing laid under the screen rather than as an object standing on it. Below 324 the window sets the width instead — `(w − 16 − 8) / 5`, which is 59.2 at 320 — and `minmax(44px, var(--tabbar-slot))` does not reach its floor until 244, where the bar is 228 and still sitting on both insets. Narrower than that it is wider than the space between them, `margin-inline: auto` centres it back through them, and at 228 it would reach the window. Nothing ships there. Measured per width by `e2e/mail-shots.spec.ts`.
- **Air around a word is not air between two words.** Two labels centred in equal tracks leave `track − (w₁ + w₂) / 2` between them, so the quantity to read is the widest adjacent **pair**, never the widest single label counted twice. On the tab bar that pair is Home↔Search — the New slot carries a wordless 34px circle, so Search and Pages never stand side by side — and it measures 25.4 at the 60 slot, where a 20px minimum would be met by 54.6. The 20 is a check the slot passes. It is not where the slot comes from, and the first draft of the bullet above said it was, on arithmetic for a pair this bar does not have.
- **The canvas runs beside floating chrome, not only under it.** §7 gives the page canvas no edge band, so a paragraph passing the tab bar is drawn to the window's own edge and shows on both sides of the capsule as well as behind it — 21px of a word either side at 390, 46 at 440, and 186 at 767, the last width before the bar is `display: none` and the sidebar takes over. The full-width bar hid that, by accident of its width rather than by anyone's decision, and hid it least where it mattered most: a five-slot bar stretched across 767 is 751 wide with 150px slots, which is the failure this change is about, at its worst. Keeping it hidden costs either a band on the canvas (§7's named ban) or a bar sized by the window (the bullet above), and text passing beside chrome is already what this product does at the top of a full-width page, where the article runs under the toolbar pills. So it stays visible: it is the tab bar reading as an object standing on the screen that makes it so, and that is the change, not a side effect of it.
- **Concentric radii**: `R_outer = R_inner + padding`. Sidebar: row 14 + padding 12 = 26 (`--r-panel`). Toolbar pill: 36px tall → 18 (`--r-pill`, full capsule). Popover: item 8 + padding 6 = 14 (`--r-popover`). Dialog/sheet: control 10 (`--r-control` — buttons and fields in dialogs, palette rows) + padding 10 = 20 (`--r-sheet`). Palette 22. Table 10. Block 8. Sticker 14. Sidebar search field 16 (32px). Settings group 16 (row 8 + padding 8). A settings row is full-bleed inside its group and its content sits at a 14px inset, so it hosts **controls** (field, segmented, button — `--r-control` 10) and never a bordered box of its own: an r10 box at a 14px inset would need an r24 group to be concentric. A value that wants emphasis takes mono or a tint, not a ring.
- **4px step**; canonical spacing 4/8/12/16/24/32/48. Control heights: 28 (dense row), 32 (field), 34 (primary circle), 36 (toolbar pill), 44 invisible touch minimum (`brain-touch-min` stays).
- **Widths**: sidebar 280, editor column 700 centred in the space right of the sidebar, palette 560, settings content 640, mail thread list 360.
- **Z-scale** (one, in tokens; components never write numbers): bg −1 / content 0 / scroll-edge 9 / toolbar 10 / stickers 15 / sidebar 20 / popover 30 / drawer 40 / modal 50 / toast 60.

## 5. Elevation

No shadows inside paper: tables are a 1px hairline ring, blocks a tint, sections an hr. Shadows belong only to what floats, graded by material thickness:

| Level | Shadow | Who |
|---|---|---|
| L0 | — | paper and everything on it |
| L1 thin | `--shadow-1`: `0 1px 2px ink/.05, 0 4px 12px -4px ink/.10` | chip, handle, tooltip |
| L2 regular | rim + edge-light + `--shadow-2`: `0 1px 1.5px .05, 0 8px 20px -8px .14` | pills, menus, popovers |
| L3 thick | rim + edge-light + `--shadow-3`: `0 1px 2px .05, 0 16px 40px -12px .16` | sidebar, palette, sheets |
| L4 modal | L3 + scrim `rgb(20 30 40 / .18)` (dark .50) | blocking dialogs; non-blocking panels have no scrim |
| Lift | `--lift`: `0 12px 28px -8px .22` | during drag only |

The sticker carries its own warm shadow (`--shadow-sticker`, `0 10px 24px -10px rgb(120 84 0 / .35)`) — it is an object on the desk, not chrome. Dark theme shadows have alpha ×1.8.

## 6. Motion

Springs in Apple terms (damping / response) mapped to framer-motion `{ type: "spring", bounce, duration }`. Presets live in `lib/motion.ts`; components never hardcode curves.

| Preset | damping / response | framer | Use |
|---|---|---|---|
| `SPRING_PANEL` | 1.0 / 0.30 | bounce 0, duration .30 | sidebar collapse/expand (focus mode), sidebar slot swap, settings section |
| `SPRING_SELECT` | 1.0 / 0.25 | bounce 0, duration .25 | selection capsule flowing between rows (`layoutId`), segmented control |
| `materialize()` | 1.0 / 0.22 | opacity 0→1, scale .96→1, `transform-origin` = trigger | menus, popovers, palette, dialogs; exit retraces the path in 120ms ease-in |
| `SPRING_SHEET` / `SPRING_SHEET_GESTURE` | 1.0 / 0.30, or 0.8 / 0.30 **after a gesture only** | bounce 0 / .2 | mobile sheets, drawer |
| `PRESS` / `PRESS_ICON` | — | scale .97 on pointer-down, 100ms ease-out; icons .90 | all buttons; respond on down, not on up |
| `HOVER` | — | 80ms in / 160ms out | all hover fills |
| `pageTransition` | — | crossfade 220ms + y 8→0, exit 80ms | page switch |
| `SPRING` (toast) | 500 / 32 | — | snackbar, countdown ring stays |

On materialising: a blur ramp on the glass element itself (animating `filter` on top of `backdrop-filter`) is double compositing. Materialize through opacity + scale; the "glass has arrived" feeling comes from the edge-light, which appears at 60% progress on its own `::before` layer. **Radix surfaces (menus, popovers, dialogs, the palette) materialize through keyframes on `data-state`** — `materialize-in` / `materialize-out` / `materialize-edge` and `dialog-pop` in `globals.css`, `transform-origin` from the Radix variable — so Radix keeps the unmount timing and focus-return leases; framer is for what physically moves (sidebar, selection capsule, sheets, drag). Everything the user drags (tree rows, stickers, sheets) runs on springs from the current value, never on CSS transitions. Theme change is a 200ms colour crossfade, no brightness jump.

`prefers-reduced-motion: reduce` → opacity crossfades ≤ 160ms only, no scale/translate/blur/layout springs; `pageFade` instead of `pageTransition`, `materializeFade` instead of `materialize`; press without scale (the fill change stays); the live background stops. "Maximum animation" is delivered through springs and materialize, not through the number of moving objects.

## 7. Scroll-edge — an atom

**Edge blur/fade is reserved for lists and panels** (sidebar tree, mail list, settings content, palette results). **It is invisible at rest and appears only where content continues under the chrome. The page canvas has no edge band: toolbar pills are self-blurring glass.** A surface can still be read as carrying one without owning one, and on a phone it is easy to: the canvas is paper plus the two edge radials (§2), whose 900×560 sky footprint covers the whole top of a 390 window, so any opaque plate laid across that band cuts the ramp with a hard horizontal line and draws exactly the thing §7 forbids. That is what the mail reader strip was doing (§13). A gate that fires correctly is not the same as an edge that is absent — check what is painted, not only what `data-scrolled` says. Each edge is gated by what it stands for: the **top** edge by `data-scrolled` (the scroller's first pixel out of view, scrollTop > 0), the **bottom** edge by `data-scroll-more` (the last pixel out of view — content continues below; a list that fits, or one scrolled to its end, shows no bottom edge). Two variants of one atom (`components/ui/scroll-edge.tsx`):

1. **edge-blur** `<ScrollEdge variant="blur" />` — where a *list* goes under floating chrome (mail thread list under its pill toolbar, settings content top, a list bottom under a floating chip or the mobile tab bar). A sticky layer of height `chrome + inset + 28` (toolbar 36 → 76px), `backdrop-filter` + `mask-image`, `pointer-events: none`, z 9, a direct child of the scroller. Its layers sit at opacity 0 and fade in over 160ms ease-out (opacity only; instant under reduced motion) once the scroller carries `data-scrolled`. The two-step version — 12px solid to 30% and gone by 65% (the band the pill occupies) over 2px solid to 65% and gone at 100% — is the progressive blur; other scrollers take a single 10px step. The last step is 2px on purpose: a masked backdrop layer crossfades its blurred copy over the sharp content rather than shrinking the radius, so a 4px→sharp fade put a grey double image of a whole text line under the pill (the "shelf" found at the Phase 0 review). 2px→sharp reads as a faint halo. Edge-blur exists only where chrome overlaps a list — never on the page canvas, never decoratively at a bottom with nothing floating over it.
2. **edge-fade** `<ScrollEdge variant="fade">` — inside glass panels (tree in the sidebar, lists in popovers, settings navigation, palette results): `mask-image` on the scroller itself, 12px at the top with `data-scrolled`, 20px at the bottom with `data-scroll-more`, eased over the same 160ms. No backdrop-filter — cheap.

`data-scrolled` and `data-scroll-more` are set by `useScrollEdge` from IntersectionObservers on two 1px sentinels (first and last child of the scroller), off the scroll event path. The fade scroller and each blur edge own their sentinel; a scroller that is not one of those calls the hook itself (`ref`, `sentinelRef`, `endRef`).

**Cover edges — the two always-on bands.** The page cover does not end, it dissolves, and it does it twice. The alpha runs `--cover-dissolve`, 80% of the banner at both sizes (176 of 220 desktop, 144 of 180 mobile). The blur is shorter and sits inside it: `.brain-cover-foot` (124px desktop / 88 mobile, at the banner's bottom) and `.brain-cover-left` (the open canvas between the sidebar's right edge and the point the cover reaches full density, 160px) hold the scroll edge's construction ungated. The foot runs the pair — 4px fading in over the first third, 20px taking the last half, the step between them blur-to-blur and never blur-to-sharp. The left ramp does it with one 20px layer: it is longer than the foot's blur band and its alpha starts at the residue rather than at nothing, so a single radius fades in gently enough. Measured against a two-layer left band on the ray fixture the two frames are the same, and one layer is what keeps a covered page at 7 backdrop layers with a slot left for a popover. Neither band is a scroll edge and neither takes `data-scrolled`: the cover is a material boundary, not chrome over a list, and these are the only two places a blur band is permanent. Both stop at the sidebar's right edge — under the glass they would only compound the sidebar's own blur. The layers use `--cover-blur-1` / `--cover-blur-2`, remapped to `none` in every fallback block, where the mask carries the whole fade alone.

**A band lets its blur go before its own far edge.** A scroll edge may hold full blur to the end of its box because the scroller clips there. Neither cover band has anything clipping it, and a backdrop layer at full opacity does not stop where its box does: a 20px radius drags the cover's colour ~20px past the point the alpha has already given it up, and then vanishes with the layer. The foot ends in open canvas, so that showed as a 14px plateau and a one-pixel cliff — 26/255 across the whole width on a saturated cover, 3/255 on a pale one, which is why a pale fixture alone will not find it, and why measuring across a band never finds what only a walk down it can. So the blur's zero lands where the alpha's does, and on the way out the radii step down in the order the scroll edge uses on its trailing end: the wide one goes first and hands to the narrow one, which carries the last stretch to nothing. Measured on the ray fixture, worst 1px step down the band 29 → 4 dark and 28 → 4 light, at rest and travelling under the pills. Since the dissolve grew, the same walk covers the whole banner rather than its lower half and returns 6 dark and 7 light — both in the picture's own texture near the ramp, not at any edge. (`measureFoot` walks every open column of the canvas, since the failure is a line across the whole width and one probe column can sit on the only place it does not show). The left band's far edge lands on the sidebar's right edge, where the sidebar's own 28px takes over — the cut is invisible there by a coincidence of two numbers, not by construction, so it lets go too.

**The alpha is a mask, never a fill.** The ground under the cover is the canvas — `--paper` plus three static radial tints, on a shell that does not scroll — so what sits behind a given cover pixel changes with the scroll position and with x. A paper fill can match one of those and no more, which is what the pre-#198 foot got wrong once the canvas took over from paper. A mask matches all of them, because it takes the cover away instead of painting over it. It is also the only reason the cover can reach the sidebar as something glass can refract. Both edges run the same curve, `3u² - 2u³`, sampled at twelve equal steps of u; the left ones are that curve with its floor lifted onto `--cover-residue`.

**The dissolve is a curve over a long run, and that is two decisions.** A gradient interpolates linearly between the stops it is handed, so a short stop list is a polyline and every stop is a corner where the rate changes in one pixel. The seven-stop list this replaced put corners at 47% and 78% of the band: the rate crossed one of them 1.4 → 2.3 levels per pixel and the other 1.4 → 0.7, and a corner in a gradient is an edge — the fade acquired a beginning about 70px above the cover's bottom, vivid above it and draining below. That is what a reader means by a sharp fade, and the bottom edge, which by then measured clean, was not it. Smoothstep leaves the top and lands on the canvas with zero slope, so there is no corner to find at either end, and twelve steps hold the worst interior corner to 0.5 levels per pixel — under 8-bit quantisation over a band this tall.

Shape alone would not have been enough. The same curve over the old 124px band still peaks at 2.7 levels per pixel: the density has to go somewhere, and a short band concentrates it. So the run grew to 80% of the banner, which spreads the same loss over 139px of the ray fixture instead of 98 and drops the peak to 1.89 (dark 1.92, and 1.92 / 1.93 at 1180). What it costs is the picture: the banner holds full density for its top 44px only, and by its own midline the cover is at ~75%. On a radial fixture that reads as haze and costs nothing. On a photograph it is a real spend — the second one this cover makes, after the 452px of its left side — and it buys the one thing a cover cannot have, an edge. A longer run is available and keeps buying: at 200px the peak falls to about 1.7, and the picture holds full density for 20px. That is the trade, and 80% is where it was drawn.

`measureFoot` gates both. The cliff bar (worst 1px step ≤ 11) is read per column, because a layer stopping at its own box edge shows on the row it stops on. The rate is read off the mean of every open column instead: the mask is the same gradient at every x, so what varies between columns is the picture — on the ray fixture the worst single column returns 2.7 where the mean row returns 1.9. Off that profile it asserts a rate ceiling of 2.3 levels per pixel and a 5%→95% run of at least half the banner, and prints the onset and the whole shape. The list this replaced measured 2.75 over a 98px run and fails both. Neither is asserted on a pale cover, which swings 25 levels top to canvas and whose rate numbers are quantisation, nor on a scrolled frame, whose top is off-screen; those print and are read by eye. Mobile is not gated either — the banner is 180px and the harness runs at one device pixel per CSS pixel, so its 2.57 would need a bar of its own to mean anything, while on a phone's own screen the same fade lands at under 1.3 levels per physical pixel.

**The cover runs under the sidebar.** It bleeds left to the window's edge, and the sidebar — thick glass — blurs and re-saturates what passes beneath it, so a page with a strong cover tints its own sidebar. That is the decision, not a leak. It holds only because the cover arrives spent: the ramp does ~86% of its work on the open canvas, and `--cover-residue` (0.22) is what travels on under the glass, flat across the panel and tapering to nothing over the 12px that show raw at the window edge. Measured on the ray fixture, the sidebar's own content loses at most 0.43 of a contrast ratio in light (Today thoughts 16.38 → 15.95) and 0.65 in dark (Today thoughts 9.90 → 9.25); everything below the cover's 220px is untouched. The one item under AA is the Search placeholder, which is under it already without a cover (dark 4.31:1, by the ink-3 placeholder exception in §12) and reads 3.93:1 with one — no residue value rescues a number that starts below the line, so pay it on the placeholder if it matters, not on the cover. Focus mode and mobile have no sidebar and no offset: every left token is 0 and the mask is a no-op. `--cover-glass` and `--cover-ramp` are registered (`@property`) and transition over 220ms, so entering or leaving focus mode slides the dissolve with the sidebar instead of repainting a third of the picture in one frame; the offset itself still moves in one reflow (B5), and reduced motion drops the transition.

What it costs the image: 292px under the glass plus 160px of ramp is 452px of the cover's left side spent on the dissolve — 31% of the width at 1440, 38% at 1180. A symmetric fixture pays nothing for that. A photograph with its subject on the left pays all of it, and a cover has no repositioning. That is the price of the decision, not an argument against it — the alternative was the cut.

Performance: ≤ 2 layers per scroller, none on rows. Backdrop layer budget per viewport ≤ 8 (sidebar 1 + pills 3 + cover edges 3 or list edge 2 + popover 1). A covered `/p` counts 7 at rest, 8 with a popover open and 8 with the command palette open — the deepest stack the app can put over a cover, and it lands on the ceiling with nothing to spare. The palette costs one layer, not three: its list fades on `.edge-fade`, a mask on the scroller itself, which carries no backdrop-filter. All three counts are measured in `e2e/cover-shots.spec.ts`, since the `@release` budget test runs on a coverless page. iOS Safari edge-blur on sticky during momentum scroll may flicker (hypothesis, checked in Phase 0 on a device) — there the fallback is edge-fade with a paper gradient.

## 8. Hover — the rule

The concept's white-on-glass row hover (white .42 on glass .58) fails: ΔL ≈ 0.01. The norm:

- **Every interactive element has five states**: rest, hover, active (press), focus-visible, disabled. None is optional — a breadcrumb parent, a disclosure toggle and a menu item react like a button does. A text field has a **sixth, invalid**: it is the one control a form can reject, so it is the one control that has something to say about itself.
- **Minimum visibility**: lightness difference rest→hover ≥ 0.03 oklch (measured on the dev stand by `scripts/glass-stand-shots.mjs`: .043–.080) **and** a second signal where the element has one (icon ink-2→ink, the "…" button appearing, an underline on a link).
- **One mechanism**: hover is the **ink tint** `rgb(29 29 31 / .07)` (dark: white .08) **layered over whatever fill the element has** — on an element without a fill of its own it is the `background-color`; on one that has a fill (glass pill, chip, the selected capsule, the toast's paper pill, table handles) it is a `::after` layer (`.tint-hover`, `--hover-tint`) fading in by opacity, so the 80ms in / 160ms out timing is the same everywhere (a background-image swap would snap). Lightening a white fill (the concept's pill .80, chip .72, selected .86) measured ΔL < .01 over paper on the stand: white on white. So a pill, a chip and the selected capsule all take the tint; the filled primary and the ink button shift their fill lightness by .08 instead. Dark: the tint over the selected capsule darkens (`--hover-tint-selected`, black .12) because white over white .14 dropped ink to 4.36:1.
- On paper: list and table rows — blue .06–.08; editor blocks — ink .035 + 8px outset; fields — the ring strengthens one step (`--hair-field` → `--hair-field-strong`), blue on focus.
- **Invalid** is `aria-invalid="true"` on the input and nothing else — one source for the assistive name and the paint, so the two can never disagree (`.field:has(input[aria-invalid="true"])`). It walks the same ladder in red: `--hair-field-invalid` (red .70 — 3.75:1 against paper, 3.69:1 dark) at rest, full `--red` on hover (5.20:1 / 6.34:1), 1.5px `--red` on focus — the error colour holds through focus, because blue there would say the value had been accepted. Hue is never the only signal: the message that set `aria-invalid` sits on the row, and the rest ring keeps 1.4.11's 3:1 on its own.
- Press: scale .97 on pointer-down (icons .90), 100ms ease-out, the hover fill stays; reduced motion keeps the fill and drops the scale. Disabled: opacity .4, no pointer events.
- Hover applies instantly on pointer-down; `@media (hover: none)` removes hover-only affordances (handles, the "…" reveal) but not press fills. The same query gates **autofocus**: the hub's field takes focus on arrival only under `(hover: hover)` — a focused field on a touch device raises the keyboard on every visit to Home, and the width says nothing about the finger (an iPad at 1024 and a phone in landscape at 844 both read `hover: none`, and both used to arrive with the field focused).
- **A hover-only affordance is dropped on `hover: none` only where another path to the same action survives it.** The rule above assumes the reveal duplicates something — a row that opens, a handle whose drag has a menu behind it. Where it is the only way in, it stays at full opacity instead: the derived tail's row menu is the whole filing gesture on a phone, since an HTML5 drag never starts from a finger, so its trigger carries `[@media(hover:none)]:opacity-100` (`components/subpages.tsx`). Removing it there would leave the page with no way to file a child at all.
- **A drag that cannot land says so before the release.** An insertion line is a promise, so a drag carrying something the document will refuse draws none, and gives `no-drop` under the cursor. The flag is `data-file-refused` on the editor wrapper (`components/editor/page-filing.ts`, read by `components/editor/milkdown.css`), the shape `data-col-drop` already uses. It is set on `dragover`, while the reader can still change their mind — the old veto sat on `drop`, which meant a valid-looking line and a silent nothing on release — and comes off on `dragend`, on `drop`, and on a `dragleave` that leaves the editor. The refusal has no frame of its own: what it is, is the absence of the line.
- Focus: `html[data-kbd] :focus-visible` → `outline: 3px solid blue/.55; outline-offset: 2px; border-radius: inherit`; inside capsules offset −3 (`.focus-inset`). **The ring is keyboard focus only** (`data-kbd` + `:focus-visible`): a pointer press shows scale + tint, never the ring — no `:focus` / `:active` rule draws an outline, and the stand's active column carries none. A text field is the exception by convention: its own 1.5px blue ring is `:focus-within` on the field for every modality, never the keyboard ring.
- Guardrails: `e2e/design-audit.spec.ts` hovers every control on the stand and asserts a computed change, and clicks a button (no ring) then Tabs to it (ring); `scripts/glass-stand-shots.mjs` measures ΔL from pixels.

## 9. Icons

Solar stays (`scripts/gen-icons.mjs` + `solar-icons.generated.ts`).

- **Linear at rest, Bold when selected** — a pair like SF Symbols regular/fill (mobile tab bar, settings navigation, pinned chips when active). `<Icon name="home" variant="bold" />`. Pairs are declared in `PAIRS` in the generator; a bold exists only for those.
- Sizes: 16 in rows and pills, 18 in toolbar buttons, 20 in settings navigation and empty states. Stroke 1.5 in a 24 box at 16px gives ~1px — visually equal to SF regular at 13pt.
- Colour: ink-2 in rows, ink in pills and on hover; a meaningful icon is never ink-4.
- Optical alignment: asymmetric glyphs (share, pen) shift by 1px; checked on the stand next to SF text 13/500.
- `gen-icons` is the only path; new names are added as `-linear` / `-bold` pairs.

## 10. Named bans

1. **No glass on glass** — a second backdrop-filter inside glass.
2. **No text over a backdrop-filter** — a blurred layer is never the ground under a paragraph, a table, a long list or anything editable. Which opaque ground a surface stands on is that surface's own decision: the editor and tables take paper, Mail takes the canvas and gives paper only to the HTML message (§13).
3. **No hard edge** — no 1px line between chrome and scroll; only scroll-edge.
4. **No shadow in paper** — shadows only on what floats.
5. **One ink-filled primary per surface**; yellow only as a transient handle or on a sticker; no blue fills, no coloured glass.
6. **No per-row glass** — no backdrop-filter on rows, cards, cells, or inside lists > 20 items.
7. **No edge-hugging chrome** — everything floating keeps the 12px inset.
8. **No CSS transition for gestures** — anything dragged runs on springs from the current value.
9. **No new type size** outside the registers, no fixed tracking.
10. **No glass on share/print** — the public page and print are paper only.
11. **No side stripes, no gradient text, no decorative cards** — carried over from v1.
12. **No emoji/icon substitution** — never swap Solar for another set in one place.
13. **No plus, cross or check inside a circle or a square** — the control already
    supplies the shape. A ring drawn inside a round button is a second shape for
    one action, and at the 14–18px these run at, the enclosure takes the weight
    the glyph itself needs to read: the ringed check on a section header spends
    most of its ink on the ring and about 4px on the mark that carries the
    meaning. The enclosure is not information. `add`, `close` and `check` are
    drawn bare (`scripts/gen-icons.mjs` → BARE, held by
    `ops/design-guardrails.test.ts`), and a plain-X close button never gets
    there by hiding a ring in CSS. No exception for the check that marks the
    chosen row in a menu or a list: that mark has the least room of the three,
    so the ring costs it the most. What this does not ban is every circle —
    `smile-circle` is a face, `pen-new-square` is a page, `clock-circle` is a
    clock. There the shape is the drawing.

## 11. Atoms in the repo

| Atom | Where |
|---|---|
| Tokens | `app/globals.css` `:root` / `.dark` / `@theme inline` — v2 block (`--accent` / `--accent-ink` / `--accent-hover`), matte fallbacks, z-scale, concentric radii |
| Materials | `@utility mat-thin / mat-reg / mat-thick`, fills `mat-fill-selected / mat-fill-chip / mat-fill-hover` |
| Type registers | `@utility text-title … text-kbd` |
| Scroll-edge | `components/ui/scroll-edge.tsx` (`ScrollEdge`, `useScrollEdge`) + `.edge` / `.edge-fade` |
| Background | `components/ui/background.tsx` (`Background`), `html[data-bg]`, `lib/appearance.ts` (`setBackgroundMode`) |
| Springs | `lib/motion.ts` (`SPRING_PANEL`, `SPRING_SELECT`, `SPRING_SHEET`, `SPRING_SHEET_GESTURE`, `materialize`, `PRESS`, `HOVER`) |
| Icons | `components/ui/icon.tsx` (`variant`, `IconSize`), `scripts/gen-icons.mjs` (`PAIRS`) |
| Focus ring | `html[data-kbd] :focus-visible`, `.focus-inset` |
| Components | §12 — `components/ui/*` on the `Components (v2)` block in `globals.css` |
| Dev stand | `/dev/glass` (development only); `scripts/glass-stand-shots.mjs` re-shoots the frames and re-derives the contrast and hover tables beside them, into a directory this repository does not carry — the script's header says where |
| Guardrails | `ops/design-guardrails.test.ts` (blur only in the material layer, register sizes in `components/ui`), `e2e/design-audit.spec.ts` `@release` (hover walk, no nested material, materialize without filter, scroll-edge gating) |

## 12. Components

Delivered in Phase 1. Styled by the `Components (v2)` block in `globals.css` (plain classes, so a consumer's stale utilities lose); every interactive one carries the five states of §8 and renders statically on the stand through `data-hover` / `data-active` / `data-focus` / `disabled`. Type is Control 13/500 unless noted.

| Component | API | Spec |
|---|---|---|
| Button | `<Button variant="glass" \| "quiet" \| "ink" \| "accent" \| "destructive">` (`ui/button.tsx`; `solid` / `ghost` / `pill` are v1 and go with the train) | glass: regular capsule 32, floats on paper, hover tint. quiet: ink-2 text, hover tint + ink — except inside a toolbar pill or the breadcrumb, where the rest colour is ink (§1: a travelling pill carries ink only; `.brain-topbar` enforces it). ink: `--accent` fill r10 32, hover ±.08 — dialogs' primary. accent: ink circle 34, ≤ 1 per surface, never yellow. destructive: red 600 text, red tint .08 hover — never a red fill. Press .97 (CSS `:active`). |
| IconButton | `<IconButton size={28 \| 36}>` (`"sm"` / `"md"` are v1) | capsule; icon ink-2 → ink on hover + tint; press .90. 28 in rows and menus, 36 inside a toolbar pill — where the rest colour is already ink (§1, same rule as Button quiet). The sidebar foot's Trash and theme toggle are this atom at 28: the toggle used to be a v1 square of its own (ink-3 at rest, a .04 tint, ΔL .035 on §8's .03 floor), and a sidebar rule pinned every icon button to ink-2 through its hover; both measure ΔL .08 light / .09 dark now, beside Settings at .056 / .076 (`docs/design/shell/foot-*`). |
| Field / SearchCapsule | `<Field on="paper" \| "glass" icon trailing>`, `<SearchCapsule shortcut>` (`ui/field.tsx`) | paper: 32, r10, ring `--hair-field` → `--hair-field-strong` on hover → 1.5px blue on focus, Table 14/400. All three states are the same 1px `box-shadow` ring, so the boundary keeps its corners; a settings field takes no patch of its own. `aria-invalid="true"` runs the same ladder in red (§8) — the atom's sixth state. glass: ink fill .055 → .10 on hover, blue ring on focus; never a second material. SearchCapsule = glass field as a capsule (r16) with a `Kbd` at the right. |
| Kbd | `<Kbd>` (`ui/primitives.tsx`) | Kbd 11/500, ink-2, r6, 18 tall; fill from the surface — `--kbd-fill`: white .70 + rim inside a material, ink .05 on paper. |
| Chip | `<Chip emoji \| icon active>` (`ui/chip.tsx`) | pinned tile 28 r14: white .50 fill, highlight + rim, 600 ink; hover tint; `active` = bold icon pair. Matte: ink tint .05. |
| TreeRow / TreeInsertion | `<TreeRow title emoji \| icon depth selected hasChildren expanded onToggle menu dragging dropInto dropEdge dropDepth layoutId>` (`ui/tree-row.tsx`, presentational — `tree/sortable-tree.tsx` adopts it in the train) | 28 capsule r14: hover tint + "…" slot revealed (always on `hover: none`); selected white .78 capsule, 600, flowing on `SPRING_SELECT` via a shared `layoutId` (plain under reduced motion); `dragging` lifts (`--lift`, scale 1.02). A drop means one of two things and the row says which, never both: `dropInto` rings the whole row yellow (the page goes inside this one), `dropEdge` pins `TreeInsertion` — the 2px yellow line with a dot — to that edge at `dropDepth` (the page lands beside it, at that parent's indent). Neither appears where a drop is impossible. |
| Sidebar slot back row | `SlotBackRow` (`shell/sidebar.tsx`, `.brain-sidebar-back`) | while the sidebar slot hosts **Settings**, a quiet `tree-row` (28 capsule, Control 13/500, hover tint, press .97, 44px coarse target) above the slot content — chevron + **"Back"** — returns the way it came, through the surface's close semantics (history.back when entered in-app); the wordmark stays a secondary path. Mail had one of these too while the panel hosted its rail. It navigates itself from the head of its own column now (see §13), so the panel keeps the page tree with the Mail row marked in it, and there is no second surface in the slot to come back from. It said "Brain" until the word was standing twice in four lines, under the wordmark, naming the product the reader was already inside. A place-name cannot replace it either: the row follows history, so Settings opened out of Mail lands in Mail and "Pages" would be wrong exactly there. "Back" names no place and so cannot be wrong, and it matches the mobile settings header — and the phone's search sheet, which says it too (it said "← Editor", a third idiom for one gesture). |
| BreadcrumbPill | `<BreadcrumbPill items=[{ emoji, label, href \| onClick }]>` (`ui/breadcrumb-pill.tsx`) | regular pill 36: parents ink 500 in 28 r14 segments, hover tint + underline, press .97; `›` ink-4; current 600. Meta is not inside. **One segment waits for the title** — see below. |
| ToolbarPill / ToolbarDivider | `<ToolbarPill>` hosting `IconButton size={36}` / `Button variant="quiet"` (`ui/toolbar-pill.tsx`) | regular capsule 36, hairline 18 between groups; self-blurring, no edge band under it. |
| Menu / popover | classes `brain-menu` (on Radix `Content`), `brain-menu-item`, `brain-menu-icon`, `brain-menu-sep`, `brain-menu-label` — `tree/row-menu`, `page-actions-menu`, `template-menu`, `category-picker`, `emoji-picker`, `mail-nav` | regular material r14, padding 6, items 32 r8 ink 500, icon ink-2 → ink on highlight, tint on highlight, disabled .4; Label 11 section titles (sentence case); lists inside scroll under an edge-fade. Materialize on `data-state` (keyframes), exit 120ms. |
| Dialog / sheet | `.brain-dialog` (+ `.brain-sheet` for the mobile form), `ConfirmDialog`, `DialogHeader`, `DialogBody` (`ui/confirm-dialog.tsx`, `ui/dialog-header.tsx`) | thick material r20, no border, L4 scrim (`--scrim-v2`), `dialog-pop` materialize with the sheen + edge-light at 60%; header Subheading 17 without a hairline — the body is `DialogBody`, the fade scroller (12px top once scrolled, 20px bottom while content continues); close = IconButton 28; buttons are `quiet` / `ink` / `destructive` (rename, move, trash, confirm); **list rows are `.brain-dialog-row`** — the palette row's construction on the same material: the r10 control the sheet's radius is derived from, at the body's 10px inset, 36 tall, Control 13/500 in ink, hover the ink tint, the chosen one the white capsule at 600, glyph and title the tree row's atoms so a page emoji stands off its title on the tree's 7px (Move's destinations, History's versions — both used to be r6 on an ink tint with the emoji touching the word); a search inside a dialog is the `Field` atom on glass; two-pane sheets keep the navigation on the material and put the main pane on paper (settings content, history preview — text lives on paper). Mobile sheets keep their slide; the full-screen settings page stays paper. |
| Command palette | `.brain-palette` on the desktop `Dialog.Content`, `.brain-palette-sheet` on the phone (`command-palette.tsx`) | thick r22, 560 × ≤ 60vh at 12vh, input Subheading 17, group headings Label 11, cmdk's list is the fade scroller (`useScrollEdge` with both sentinels: the first row dissolves under the input once scrolled, the bottom edge goes at the end of the list), selected row the white .78 capsule r10. Materialize on `data-state`. **On a phone it is the same surface as a sheet**: the Pages sheet's construction — thick material on the 8px inset over the safe area, r20, rising on `SPRING_SHEET` (a fade under reduced motion), the Radix content the transparent focus scope — with a 44px head (`‹ Back` as a tree row at the left, the SlotBackRow's word; H3 "Search" centred), the `Field` atom on glass as its capsule (16px input, so iOS never zooms), the same headings and rows by the same two rules, the same fade scroller, and the tab bar riding inside as a plain row. It used to be a paper page of its own with uppercase 11/500 labels, r6 rows on an ink tint and a "← Editor" header no other surface on the phone says. |
| Table | `editor/table-block.css` | paper: 1px hairline ring r10 (separate borders, rounded corner cells), th ink .045 600, row hover blue tint, tabular numbers; handles yellow with `--yellow-ink` glyphs, transient; the handle's action group is a regular-material popover r14 (material declared in `globals.css`). |
| Sticker | `stickers.tsx` (`.brain-sticker`, `.brain-sticker-inline`, `.brain-sticker-label`) | r14, `--sticker-gradient` (#FFF5BF → #FFEC95), Label 11 header "Note" with a dot, `--shadow-sticker` at rest, `--lift` added while dragging (spring drag unchanged). |
| Empty-block hint | `editor/milkdown.css` `.brain-slash-hint` | "Press / for a block" in ink-3 behind a 1px ink caret marker at the block's left — the documented placeholder exception: ink-3 may voice a hint on paper (ink-4 vanished on the warm paper at the T3 review); it stays banned on glass. |
| Toast | `Snackbar` (`ui/primitives.tsx`, `.brain-toast`) | opaque ink capsule, `--shadow-3`, Control 600 title + Caption subtitle, countdown ring unchanged, and drawn only where there is a deadline to draw — `durationMs: null` is a pill with no window, which stands until something replaces it or its action is spent and wears no ring while it does; the pill action hovers with the tint. An action that answers with a promise is spent when the promise settles, not at the press: the pill stands, its button out of reach and wearing the message's `pendingLabel` (Done's reads "Undoing…"), and a second press or ⌘Z meanwhile does nothing — the shape of an undo pressed while the work it reverses is still going out. Every pill is a row of ONE bottom-anchored column (`SnackbarStack`, `.brain-toast-stack`), so two that are up at the same beat — a refusal over a live undo — stack on the column's 8 instead of being placed by hand, and no pill carries an offset of its own. **The column is centred on the canvas, not the window** — its left edge is `--canvas-offset` — so a pill stands on the line the editor column is centred on and never on the sidebar's glass: centred on the window it sat 152px left of the canvas centre at 1440, and at 768 it crossed onto the sidebar by 64px, over Settings and Trash. On a phone and once focus mode has settled the offset is 0 and the two centres coincide (`docs/design/shell/toast-*`). The column clears the mobile tab bar below md: it stands on the strip's reserve (`--inset` × 2 + the bar's 54, the same figure `.brain-mail-scrollfoot` keeps), because the bar occupies safe+8 to safe+62 and a pill at safe+24 covered Search, New and Pages for a whole ten-second undo. Kept whether or not the bar is up — a pill that moved with the bar would move under the reader's hand. |
| Skeleton | `<Skeleton>` (`ui/primitives.tsx`, `.skeleton`) | fill from the surface — `--skeleton-fill`: ink .05 on paper, white .40 on glass (paper fill on matte); no pulse under reduced motion. |

**A breadcrumb with one segment says nothing the page does not.** On a root page the crumb holds a single segment — the page's own icon and title, repeated a few centimeters above the icon and title on paper. It is not even a control there: the last segment is the current page, so it renders as text with `aria-current`, links nowhere and opens no menu. What it is instead is the only thing naming the page once the title has scrolled off. So it waits. `.brain-crumb-lone` (the class the topbar puts on a one-item crumb) is hidden at rest and materializes when `.brain-main` takes `data-title-out` — set by an IntersectionObserver on the title itself (`shell/page-head.tsx` → `useTitleReveal`), the scroll-edge atom's pattern from §7: off the scroll event path, and a flag on the DOM rather than in state, so crossing the line never re-renders the shell. The line is the scroller's own top, not the bottom of the pill band. Handing over at the pill band would put the same word in two places at once on a default page, where the pills cover a strip at the left and the document column runs to the right of them, so a title level with the pills is still on screen and still naming itself. But that argument holds only at the 720 measure: on a full-width page or a board the article takes the whole canvas and its text passes directly under the pills. The top edge is the line that is right in **both** layouts, which is why it is the line — and it made the handover exact in both directions on both breakpoints, and deleted a measurement and its resize listener along the way.

Three things it does not do. It does not animate itself into existence: the arrival is the materialize canon of §6 (opacity + scale .96 → 1 over 220ms `--ease-out`, retraced in 120ms ease-in), opacity alone under reduced motion, and the reveal itself stays there — it carries the meaning, it is not decoration. It does not use opacity alone: hidden it is `visibility: hidden`, out of the accessibility tree and out of the tab order, and still holding its box, so the [Share] and [pin │ …] pills at the other end of the absolute layer never move and no gap opens under the scroll. And it does not touch a crumb that carries an ancestor — that one says something the title cannot, and is on screen throughout, on every page below the root.

## 13. Mail — the three-pane surface (P5)

Mail is where the material rules meet content the system does not own, so it is
the one surface documented as a whole rather than component by component.
Layout: the thread list, then the pane that holds either the reader or the
composer. **Account and folder navigation lives in ONE control, in the head of
the column it navigates** — see "One control owns mail navigation" below. It
used to be a glass rail hosted inside the shell sidebar, which made "is the
rail on screen" a question the column had to answer too.

**Compose has one place: the thread column's toolbar pill.** It used
to be portalled into the sidebar head as the shell's accent circle as well,
which put two controls for one action on the same screen and made that circle
mean Compose in mail and New page in notes — the same fill, the same 34 slot,
the same corner, a different action, and ⌘⌥N (the shortcut written on it) went
on making pages either way. The circle is New page on every surface now, and it
came off the composing pen it used to share with that pill: the two were the
same drawing 370px apart, and once one of them made a note and the other a
message the only thing separating them was a fill inversion, which in this
system encodes accent and not meaning — a miss puts an empty page in the tree
and says nothing. Compose keeps the pen and the circle takes the **plus**, so
the two controls are two drawings and the 370px between them separates two
acts. **That plus is drawn bare** (§10 ban 13), which leaves no shape around
the stroke to carry a meaning, and the adds that used to differ by their
enclosure now differ by nothing: the template menu's blank entry, the tree row
menu's New page inside, the palette's New page and New page inside, the board's
card and its section, the account list's Add account. **The word beside the
mark says which add it is.** The palette's two page rows are one drawing and
two words, and what separates them is not the act but the destination — the row
menu's word, not "here". The two adds that carry no word are the same 34 accent
circle making the same page: the sidebar's, whose label, tooltip and ⌘⌥N all
say New page, and the mobile tab bar's centre, wordless between Search and
Pages. What those two carry is the mark for the ACT — `document-text`, the
noun, is the very next slot, under the word "Pages". **`/dev/glass` draws what
the shell draws**: every sample there labelled "New page" wears the bare plus,
since a reference stand that contradicts the product is a second source of
truth.

**One control owns mail navigation** (`components/mail-nav.tsx`). An account and
a folder are one thing — **the address the column stands at** — and the rail
split it into two controls and paid a whole sidebar for the privilege, while
the list beside it stood with no head at all. The control names that address in
one line at the head of the column and opens one menu where accounts, mailboxes,
smart views and Drafts lie in a single list.

**What it says at rest is the DESTINATION**, and the account only where the
account distinguishes one: `All inboxes` in the merged mode, `Inbox` for a lone
account, `Inbox misha` where more than one is connected, the view's own word
where a smart view is open. The address moves rarely and the folder constantly,
so the question the control answers is *what am I looking at*. The account word
is `accountWords()`'s — the shortest token no neighbour shares — and it earns
its place because the single-account rows carry no account word of their own:
with more than one address connected, the trigger is the only thing on that
screen that says which mailbox the column is showing. The full address is one
press away in the Accounts block, where there is one — a lone account has
neither the word nor the block, since neither would say anything (see "The
Accounts block names what "all" is made of"). The two words are
separated by colour, not a mark: ink and ink-3, the same construction as the
`label + count` pill.

**No count on the trigger, ever.** Its one tail slot belongs to the account
word, which has no second home; the count has one. The rule that governs where
a count may stand survives the move word for word — *the count stands only on a
row that names one mailbox of one account* — but it is now a consequence of the
menu's shape rather than a guard: the `Inbox` row carries it, `All inboxes` is
not one mailbox, and an account row would be reporting the loaded merge window.
The trade, stated: the number is one press further away than the rail kept it.
Sitting in the inbox, which is most of the time, it is redundant — the volume
of unread mail reads off the column's own dot rail in one pass.

**Three blocks, and a block is drawn only where the mode has one.** This
account's destinations, then `Smart`, then `Accounts`. Rows are the `brain-menu`
object exactly as it is elsewhere: 32 tall, r8, gap 10, Control 13/500, a 16
Solar glyph in ink-2, the label truncating, and a tail carrying the count and a
**bare** `check` 14 (§10 ban 13). There are two checks in a full menu, one per
block, and they read as the trigger's own line top to bottom: *I am in Inbox,
at misha*. The accounts block is the same shape in every mode and in the same
place, so switching account is always the same gesture at the same point.

**Two blocks, two radio groups** — `Dropdown.RadioGroup`, destinations and
Smart in one and Accounts in the other, so every row is `menuitemradio` and the
current one carries `aria-checked`. The check is a drawing and drawings are
`aria-hidden`: without the group a reader who cannot see it would be told the
destinations and not which one they are standing in, which is the one thing the
rail's `aria-current` did say. The grouping is not a device for that — the two
groups ARE the two checks, and there is exactly one selected row in each.

**Drafts is a destination and stands between Sent and All Mail.** Not a taste
call: `MailDraftsList` renders the same `.brain-mail-list` with the same head,
so it occupies exactly the slot a folder does — and so its head is this control
too, naming `Drafts`, rather than a Back button and a title. The Back button
went with the second door it was: the menu names every destination including
the one you came from. **And pressing that one costs what Back cost.**
Choosing a destination rebuilds the column — it drops the query, the open
thread and the sticky hold, and re-reads that mailbox's stored sort — which is
right for a move and wrong for a return: a reader who searched `invoice`,
looked at Drafts and came back would have been charged a search they never
asked to lose. So the destination the column was already standing on, pressed
while Drafts holds it, closes the drafts list and touches nothing else. One
flag, which is all the button ever set. `"Go to Drafts"` in the palette stays;
it stands outside the head entirely. **The toolbar's drafts icon exists only while
`failedDraftCount > 0`** — a control lives exactly as long as its reason. What
the menu cannot do is shout, and a send that failed has to be visible without a
press; an in-flight send is not a reason, because it corrects itself.

**The trigger is `.toolbar-pill > .btn-quiet`** — the pill and the quiet button
the toolbars already use, so no new material and one backdrop layer rather than
two. `.brain-mail-nav` is a layout modifier on that button and nothing else: it
lets the label truncate and pushes it to the left of the capsule. 36 tall on
`--r-pill`, padding
0 14, Control 13/500 in `--ink` with the account word in `--ink-3` and
`alt-arrow-down` 16 in ink-3 after it. **The chevron does not turn**: the menu
materialising is the feedback, and a second one says the same thing twice. The
trigger holds its hover tint while `[data-state=open]`, because a pressed
control has to stay findable under the thing it opened. The menu is 264 wide
(a 25-character address at Control 13 measures ~172, plus the glyph, the
check and the padding), `side="bottom" align="start" sideOffset={6}
collisionPadding={8}`, with the existing materialize keyframes and no framer.
On a phone it is the same popover, not a sheet — the trigger stays a button and
so keeps Control 13 at every width, and the 16px floor that keeps iOS from
zooming is the search `input`'s rule, not a button's. Its touch target is the
existing `brain-touch-hit` 44.

**The list scrolls, the material does not.** Fourteen rows is 534px, and this
menu is the only way out of an account — so a window shorter than it (a phone
in landscape, an iPad split view, a short laptop window) put the Accounts block
past the foot with nothing to roll, and the keyboard walked focus onto rows
nobody could see. Measured at 1024×420 and 844×390 before the fix: 136 and
166px past the window, three and four rows unreachable, `End` leaving focus off
screen. The body sits in a `ScrollEdge variant="fade"` capped at
`--radix-dropdown-menu-content-available-height` less the material's own 12px
of padding — Radix measures the room and publishes it, and this is what reads
it. Both routes to the last row land on screen now, by pointer and by `End`,
and `e2e/mail-client.spec.ts` holds it at `@release`. It is **this menu's
scroller, not `.brain-menu`'s**, which is the answer this system already gave
three times: `subpages` caps its list on the same variable, and the emoji and
category pickers keep their search field above the scroller and roll only the
list under it (§12: *lists inside scroll under an edge-fade*). `.brain-menu` is
the material — glass, radius, padding, the materialize keyframes and the
`::before` edge-light — and a scroller on it would clip that layer against its
own rounded corner and would roll the pickers' chrome away with their lists.
This menu is all list and no chrome, so the scroller wraps its whole body. The
fade is a mask, not a backdrop layer, so the 7 of 8 above is unchanged.

**Backdrop budget: 7 of §7's 8, counted rather than added up.** Sidebar, nav
pill, search capsule, toolbar pill, the reader's pill, the scroll edge, and the
menu — measured on the surface that carries the most of them (one account, a
thread open, the menu up) by `e2e/mail-shots.spec.ts`. The estimate that
planned this head said 8, because it counted the edge as two layers; the mail
edge runs `steps={1}` and renders one. So there is a layer of headroom, and
one only: a second glass object in this head is the ceiling, not "one more
pill" — which is why Compose rides the toolbar pill rather than taking a pill
of its own.

**Where three panes stop fitting.** The pane switch is mail's own breakpoint —
`--breakpoint-panes`, **1160** — and it answers a different question from `md`.
`md` asks whether the viewport is a phone. This one asks whether the reader
still has room to be a reader, and the two came apart the moment the column
took its 360: with the sidebar reserving 304 (`--inset` × 2 + the 280), a 900px
window left the reader 236 and a 768px one left it 104. The action pill does
not shrink — the pill is `shrink-0` and its buttons carry a fixed 14px padding
— so it ran past the window instead. Measured, its right edge sat at 967.7 at
900, at 820 and at 768 alike, clipped identically, while the subject beside it
was squeezed to exactly 0. Three panes were promised at a width that could not
hold them.

**The number is a judgement inside a band the measurements set, not a figure
they force.** Two things are measured, both in Chromium on the SF stack with a
thread open. **The head** wants 490: `32` for the article column's rule, which
the strip's left edge shares, plus `159` for the subject's box, plus the head's
`10` gap, plus `277` for the pill at its resting labels (Mark unread 105 +
Archive 74 + Reply 62 + the ⋯ menu 36), plus `12` for §4's one inset on the
window side. Three of those figures need a word.

The `159` is **the caption's** number before it is the subject's. "12 messages
· Dec 24, 2025" measures 157 and starts truncating there — an ordinary caption
in this format, measured rather than guessed — and twenty characters of subject
at its own 15/600 happen to land within 3px of it. The twenty was chosen; the 157 was
measured, so the caption is what the floor rests on.

The `277` is measured **on the inbox**, where the direct action reads Archive.
That is the case taken, not the widest one: spam's "Not spam" is a character
longer, about 4px, which fits inside the 6px between 1154 and 1160 without
moving anything. "Mark unread" is the label that stands there at rest, because
opening a thread marks it read.

**The body** wants 456 and does not set the line: `324` for forty-five
characters at the message's own 16px, the floor of the 45–75 measure, inside
`8`+`8` of content padding, `26`+`26` of sheet and `32`+`32` of article.

What the two of them *force* is a good deal less than 490. The subject is
`truncate`, so losing it is a soft failure and the head still works without it
— strip it and the hard floor is `32 + 10 + 277 + 12` = **331**, the width at
which the head stops overflowing. The 490 buys 159 of headroom, and buying it
is a choice. The two bounds also read the room from opposite postures: the head
is generous (give the caption its whole width, though it degrades softly) while
the body is at the floor (forty-five, the bottom of its measure). Read both at
the floor and the body sets the line — 456 + 360 + 304 = **1120**. Read both
generously — the body at sixty characters rather than forty-five, 432 + 132 =
564 — and it moves to **1228**. **1160** is a judgement inside that band:
490 + 360 + 304 = 1154, rounded up to where the pill's right edge lands on
§4's 12 and the subject keeps 165, six pixels over the floor it came from.

One caveat on that 45–75, and it is the product's own. `mail-reader.tsx` caps
the sheet at `max-w-[76ch]`, and `ch` is the zero's advance — about 9.03px at
the message's 16px — while prose averages nearer 7.2px a character, which is
the figure the `324` above is built from. So the cap admits about **95**
characters, not 76; measured on `panes-one-1159-light.png` the longest line
runs 87. A 76-character cap would be about 61ch. The measure is cited above as
the source of a floor, which is where it holds — it is not cited as a ceiling,
because the product's own ceiling overshoots it by twenty characters.
**Known gap**: the `76ch` → ~61ch recalculation predates this change and is
not made here.

**One pane has a second line, and it is the strip's own.** 1160 is where three
panes hold the head at its 490. Below it the reader has the window less the
sidebar, and the head is the same head plus the Back button, which exists
exactly when the list does not: 32 + 20 (the 28 capsule hung 8 into the
gutter) + 10 + 159 + 10 + 277 + 12 = 520, and 520 + 304 = **824**. What used
to decide the resting label was `sm` — 640, a phone's number, right while the
strip was the whole window and wrong the moment the panes switch put it inside
the desktop shell from 768 up. Measured on one pane: 768 left the subject 103
and clipped the caption under it, 800 left it 135, 824 exactly 159. So `Mark
unread` — 105 of the 277 — is drawn from `--breakpoint-strip` up and lives in
the ⋯ menu below it, where it has always also been. **830** is the same
judgement 1160 made, six over the floor: the subject keeps 165 at 830 on one
pane and 165 at 1160 on three, so either switch hands it the same width, and
one pixel under the line it keeps 269 — the 105 back and then some. 768 keeps
208. A phone held sideways at 844 is a desktop with a sidebar to the query,
which is right: it keeps the label and 179. The number is the token and the
`strip:` variant Tailwind makes of it, nothing else — `ops/design-guardrails.test.ts`
holds the sum against the parts it can read and the one call site, and
`e2e/mail-client.spec.ts` reads the line off `:root` rather than carrying a
copy. Frames: `strip-768-{light,dark}` beside their `strip-768-before-*`
pairs, from `e2e/mail-shots.spec.ts`.

**The phone is nine short, and that is written down rather than fixed.** At
390 the strip is the window: 20 + 20 + 10 + 159 + 10 + 172 (the pill without
its resting label) + 8 = 399, and the subject gets 150 — fourteen characters,
and a caption at its widest, `12 messages · Dec 24, 2025`, loses its last two.
The two ways to the floor are design calls, not arithmetic: Reply as a glyph
saves 26 (176), Archive as a glyph saves 38 (188), and Archive has no row in
the ⋯ menu to fall back on. **Known gap** until one of them is chosen; the
e2e holds 390 at its 150 so a move either way is a move someone made.

**Below it mail shows ONE pane, inside the ordinary desktop shell.** The
sidebar is not a phone affordance and a 900px window is a small desktop, so
nothing switches to the mobile chrome: the shell keeps its sidebar with its
page tree in it, and mail alone changes shape. The pane is the behaviour a
phone has always had — the list, or the reader, or the composer, with the
reader's Back leading home and Escape doing the same from the keyboard, and
`j`/`k` still walking the column from inside the reader. The three occupants
are named in that order, so composing over an open message replaces it and
closing the draft gives the pane back to the message.

**It is a jump, not a cliff — and the measure is what jumps.** At 1160 the
reader keeps 496 of pane, about fifty characters to a line; at 1159 it takes
the window and the `76ch` cap lets the line run to about ninety. The list
leaving and Back arriving is the standard idiom and reads at once, so that half
costs nothing. What a reader feels is the measure, and 1159 is the worse of the
two rather than the better: the best frame in the whole set is **900**, at
about sixty-three characters. The band this change opens holds both the best
line length in mail and the worst, and the worst is the cap's doing, not the
switch's.

**What moved with the switch, and what did not.** `md` held several questions
that only looked like this one:

- **Moved** — they belong to *three panes do not fit*: which pane is on screen;
  `.brain-mail-list`'s 360, because a column is only a column when something
  stands beside it, and below the breakpoint it is the whole pane; the reader's
  Back button, which exists exactly when the list does not; the reader's
  "Choose a message" rest state, which is what an empty **third** pane says;
  and Escape's return to the list.
- **Stayed on `md`** — they belong to *the viewport is a phone*: the mobile tab
  bar's reserve at the column's foot (`.brain-mail-scrollfoot`) and the bottom
  edge-blur over it, the surface's own top and bottom chrome reserve, `--inset`
  stepping to 8, the reader strip's 20/32 and the sheet's 18/22 (touch
  density), the 16px form fields that keep iOS from zooming, and the composer's
  drag-to-dismiss, which is a gesture and not a width.

**The head left the width system, and then left the question.** The list head
used to have two modes — two native selects in flow, or a toolbar row floating
over the rows — and which one it drew answered a question about somewhere else
on the screen: *does the rail own account and folder navigation?* No width can
answer that, so the shell handed mail one boolean and the head read it.

That question no longer exists. Navigation has one owner at every width and in
every mode, so the head floats, always, and `--mail-chrome` is the only thing
that varies: 36 for a column whose head is the nav pill alone, 80 for one that
carries the search capsule under it. The two diseases the boolean was written
to cure went with the rail. 768–1023 used to draw the rail **and** the selects
— two account switchers, two folder pickers, and a native `<select>` stretched
to 596 wearing its system chevron at the far edge — because the rail has been
hosted in the sidebar since 768 while the selects hid at `lg`. And focus mode
takes the sidebar off-canvas **and** out of the accessibility tree at any
width, so ≥1024 had no account or folder control on the surface at all, only
the palette. Neither is reachable now, and neither is the cure.

**The pane query is conservative in exactly one place.** Focus mode (⌘\) takes
the sidebar away and hands mail its 304 back, so three panes would fit from 856
up and mail still shows one. Not because CSS cannot see it — the shell already
stamps `data-sidebar-collapsed` on `.brain-shell` and `--canvas-offset` zeroes
itself off that attribute. The attribute lands **only when the collapse spring
settles**, which is deliberate: one reflow at the end instead of a per-frame
padding animation. A pane switch honouring it would therefore arrive as a
visible re-snap about 300ms after the keypress, the layout changing its mind a
third of a second after it was asked. One pane early is never a false promise;
that is.

The number itself is written three times — the token, the raw query that gives
the column its 360, and `MAIL_PANES_MIN_WIDTH` for the Escape handler — because
a media query cannot read a custom property. `ops/design-guardrails.test.ts`
asserts the three agree; two of three agreeing is worse than one wrong number,
since the layout would then switch at one width and the keyboard at another.

The head's own numbers are held on the stand rather than asserted from memory:
`e2e/mail-shots.spec.ts` records the two-row band (120px, worst 1px step 2/255
light and 3/255 dark on the render, 1/255 for the dissolve alone over a flat
plate), the right edges from 768 to 1159 (spread 0.00px — the toolbar pill, the
search capsule and the row capsule land on the same inset at every width in the
band), and the Inbox row's two tail marks (10px between the count and the bare
check, not the 6 the mock read).

`e2e/mail-client.spec.ts` holds the line at `@release`: 1160 keeps the column,
the reader beside it and no Back button, with the pill on §4's 12 and the
subject at or above its 159 floor — read after "Mark unread" appears, since the
resting label is the one the 277 was measured from; 1159 gives the reader the
whole pane; and 900 — the width the pill used to overflow by 68px — puts the
pill back on the inset with a subject beside it. A second test holds the owner:
one navigation control at 390, 900, 1160 and 1280, in focus mode and out of it,
in the merged mode and the single-account one — one at every stop, never two
and never none. A third holds the strip's own line, read off `:root`: the
resting label in the pill at `--breakpoint-strip` with the subject at or above
159, in the ⋯ menu one pixel under it with the subject at or above 264, and in
the menu at 768 and at 390 with the pill on the inset at both.

**"One ink-filled primary per surface" means per PANEL, not per window.**
`confirm-discard-light.png` has two on screen — the sidebar's New page circle
and the composer's Send — and that is the rule holding, not breaking: the
sidebar is one surface and the sheet over the pane is another, each with
exactly one. Read the other way the rule would demote a control every time a
sheet opened, which is the demotion this PR removed. Classes live in the
`Mail surfaces (v2, P5)` block of `globals.css`.

**The canvas is the only ground (v3).** No pane declares paper. `.brain-mail-list`
and the reader/composer pane both stand on the canvas the shell stands on, and
separation is carried by distance, density and the scroll edge — never by a
plane. The plate that used to hold the column had an edge, and that edge read as
a seam down the sidebar gutter; removing the plate removes the seam, because
there is nothing left to draw a boundary. **The rule down the column's right
edge went the same way (v4)**: 360px of two-line rows beside an article column
is not a pane a reader can confuse with its neighbour, and the reader's own left
padding is wider than any hairline could be. Measured on the stand
(`e2e/mail-shots.spec.ts`): the canvas under the column is L 0.979 in
light and L 0.203 in dark, ink holds 15.85:1 / 14.17:1 on it, ink-2 6.18 /
8.12, and ink-3 — the snippet, the time, the account word, the count chip —
4.78 / 4.95, so the quietest register on this surface still clears 4.5:1.

**The one exception is the message body.** HTML mail is foreign content written
for a white page, so each message keeps its own **paper sheet** at r14 with a
`--hair-soft` ring (`.brain-mail-sheet`) inside the reader, while our own
sender and meta markup sit on the canvas around it. The sheet is opaque and
nothing floats over it, so the ban on glass over the message iframe is
satisfied by construction rather than by vigilance. In light the sheet's paper
and the canvas beside it measure ΔL 0.000 — the sheet is its hairline, not a
tone.

**Inside the sheet a picture is bound by the box around it** (`max-width:100%`,
`lib/mail/reader-html.ts`), which is how every mail client draws one and what
the commonest newsletter shape depends on: a hero in a padded cell. Bounding
every sized picture by the column instead widened that hero past its cell by
the padding, and the whole message panned 36px at 390 and at 620. The column
is the bound only where nothing nearer applies — a picture sized by height
alone — and, picture by picture, where the sender declared the box NARROWER
than the picture and meant it to overflow (a 16px badge in an 8px
cell, its 101px wordmark in an 84px anchor): the builder finds those in the
markup and writes the column bound inline. A cell with a pixel width is read
the way email writes it, width for the content box and padding on top
(`box-sizing:content-box`), so a 48px logo in a `width:48px;padding-right:8px`
cell is 48 and the cell 56. The column is `100cqw` of the frame's root, not
`100vw`: it reads the content box, scrollbar excluded. Measured by
`e2e/mail-shots.spec.ts`, frames `image-hero-*` beside `image-*`.

**The reader strip declares no ground either (v6).** It painted opaque paper,
and the reason given was that it is the one thing the message scrolls under.
It is not. The strip is a flex sibling **above** the reader's scroller, and
the scroller clips the frame at its own top edge: a tall message keeps its
whole box in the layout and that box does run up behind the strip, but no
pixel of it is ever painted there — which is why `e2e/design-audit.spec.ts`
measures the rule against the **visible** part of the iframe. The plate was
defending a case this layout does not have.

What paid for it was the tint. The canvas is paper plus the two edge radials
(§2), and the sky one is 900×560 at the window's top-left corner. On a desktop
the reader pane starts past 700px, where that radial is spent, and flat paper
there measures ΔL 0.001 light / 0.004 dark against the canvas — the figure
"invisible at rest" was read off. **On a phone the reader is the window**: the
strip sits in the radial's hot corner, and the same flat paper measured 13/8/2
in RGB against the canvas beside it at 390. That is a lit band with a hard
horizontal edge under it, sitting at the top of the screen — and it gets read
twice over, once as a plate laid over the page and once as a progressive blur
that has fired before anything scrolled. One artefact, two complaints. The paper is gone: the canvas runs behind the subject the way
it runs behind every other piece of chrome in this product, the same column
now measures ≤1 in every channel top to bottom, and §7's one edge here is the
scroller's own fade, which stays at 0 until `data-scrolled`.

**What ruled the glass out was its shape, not its absence.** There is glass in
that band and there always was. `.toolbar-pill` carries
`backdrop-filter: var(--blur-reg)` like every pill in the product, and the
reader's action pill stands inside the top 52 of the phone screen: before the
change the band held two of them, the shell's breadcrumb pill and this one, and
it still holds this one — measured 172.2 × 36 at x 209.8, the only
`backdrop-filter` intersecting the top 260px of the reader at rest. Neither is
the shape the complaint describes. A blurred capsule 172 wide, r18 at both
ends, with a rim and a shadow and 8px of canvas past its right edge, is an
object with visible ends; what was reported was a lit band the full 390 across
with one hard horizontal line under it, and the only element in that layout shaped like that
was `.brain-mail-reader-head` with `background: var(--paper)` — full width by
construction, its bottom edge exactly on the scroller's top. The gate was
doing what it claims at the same time (at rest the scroller carries
`data-scroll-more`, no `data-scrolled`, and its mask reads
`transparent 0px, black 0px` — the top step is zero until something moves),
but a gate that fires correctly is not evidence about what is painted, which
is §7's rule and the reason the pill's presence changes nothing here. The pill
stays: glass over the canvas is what glass is for, and the ban it has to clear
is the one about the message below, which it clears by standing above the
scroller rather than over the frame.

**Mail has no title row on a phone.** The shell's mobile slot carries a
breadcrumb, which names an ancestor the page's own title does not. Mail put
the word "Mail" in it — the one fact the screen already states twice, in the
lit tab-bar slot and in the mailbox underneath. It was a `<span>`, so it was
not the way back from the reader either: that is the reader's own arrow, and
`ShellTopbar` returns nothing for mail on mobile the way it already does for
settings. The row went with the word, and mail's own head — the list's account
and folder selects, the reader's subject strip — moves up under the status
bar. The surface's height followed: it subtracted a bare 52 for that row while
the row is `52 + safe-area-inset-top` tall, so on any phone with an inset the
mail screen stood ~59px taller than its slot and could be dragged inside the
shell's scroller. It is `100dvh` with the top inset as padding now.

**Three things that paragraph does not buy, named so nobody reads them off
it.** *The composer's Send is still under the keyboard.* `dvh` does not shrink
for it, and `.brain-composer-actions` is `flex-shrink: 0` outside
`.brain-composer-scroll`, so the sheet's footer is a fixed row at the bottom of
a box the keyboard covers — Saved / Discard / Send included. Dropping the title
row moved the whole surface up by the 52 it was costing, which lands the footer
on the window's bottom edge instead of below it, and nearer is not reachable.
That is the standing `@mobile … without zoom triggers` failure, which this
branch neither fixes nor moves: it measures the composer's bottom against the
tab bar's top and returns 817–821 against a 783 bar, drifting a few pixels
between runs on reflow timing and never approaching the line. (An earlier note
called two of those runs byte-identical; four runs here say the figure is not
stable, only the verdict is.) No frame in this set was shot with a keyboard up
either — the composer frame blurs the active element first. *The strip's
separation now rests on one thing.* With the plate gone, what stands between
the subject and the message is the scroller's own 12px `data-scrolled` mask and
nothing else — on a desktop the tone it replaces was ΔL 0.001 and below
noticing, but on a phone it measured 13/8/2 and was carrying part of the load.
The review reads the mask as sufficient and Chromium agrees; it has not been
read on a device, and a 12px fade at three device pixels per CSS pixel is
something a screen decides. *And `pt-[env(safe-area-inset-top,0px)]` carries no
`md:` guard*, so this is not only a phone rule: on an iPad in standalone
portrait the mail panes now start 24px lower. That is where they belong — the
sidebar beside them already stands at `--inset + safe-area-inset-top` and the
panes were running under the status bar — but it is an md+ move made inside a
mobile change, so it is written down rather than left to be found.

**Its two edges answer to two different rules.** The left one belongs to the
message: 20 below md, 32 above it, the article column's own padding, so the
subject and the sender under it stand on one rule. The right one belongs to
the window, and §4 knows one inset for that. Twelve — what the page's [Share]
and [pin │ …] pills keep on the absolute topbar layer, and what the column's
boundary rule, its row capsule and its Compose pill each keep at the edge
they belong to. The strip used to take the article's 32 on both sides, which
is symmetry borrowed from the left rule. Symmetry is not a reason, and this
one stood the only pill in mail 20px further off the window than every other
pill in the product — a difference visible in two screenshots side by side
before anyone measured it. Below md the reader is the whole window and keeps the
same rule at 8, beside the mobile topbar's own. Like that row it takes
`max(--inset, safe-area-inset-right)`, because a strip in flow at the
window's edge loses to the safe area when a phone is held sideways.
`e2e/design-audit.spec.ts` measures both ends of the rule against the window
in one pass at `@release`.

**A pill means the same thing everywhere.** `ToolbarPill` is chrome that
travels over content it does not own, so §1's ink-only rule and the pill's
14px button padding belong to `.toolbar-pill` itself, not to any one host —
the topbar, the reader strip and the thread-list toolbar all get them from the
same two rules. The corollary decides where a pill may not go: in the composer
the buttons float over nothing, because they are the sheet's own footer, so a
capsule there would be a borrowed sign (and a material inside a material,
ban #1). The reader is the opposite case — the pill belongs there precisely
because the message is not its content.

**The hard rule.** Glass may never overlay content the reader did not write:
HTML mail is foreign, arbitrarily dark, arbitrarily busy, and no fill passes
contrast over all of it (§1 → Materials, §2 → the contrast table). Anything
that floats over a message has to be an **opaque paper strip** with the pills
on top of it — and the way this surface keeps the rule is by having nothing
that floats over one: every piece of reader chrome is in flow above the
scroller, and the scroller clips the frame at its own top edge.
`e2e/design-audit.spec.ts` holds it at `@release`: with a tall HTML
message open, no element carrying a `backdrop-filter` may intersect the visible
part of an iframe at any scroll position. The frame is clipped to its
scrollports first — a tall message keeps its whole box in the layout, so while
the reader is scrolled the box runs up behind the strip, and only what a reader
can look at is the rule's business.

**A mode may drop a control, never restyle one.** Two lists share the list
slot — the single-account thread list and the unified inbox — and a reader who
switches between them must not feel a change of product. So the column, the
head, the row, the edge and the hover states are the same objects with the same
classes, and the only thing unified is allowed to do differently is offer
*less*: no search capsule, because search reads one account's cached headers
and no cross-account index exists behind it; no sort, because the sections are
the order; no drafts and no manual sync, because both are account-scoped (the
nav menu drops Drafts in unified for the same reason, and without a guard —
Drafts lives in the destinations block, and unified has no destinations
block). What is left in the head is the nav pill and the compose pill, and
compose keeps the toolbar's place at the column's right edge in both modes
rather than moving somewhere a lone control would look better. The corollary
runs the other way too: an absent control takes its chrome with it — an account
that cannot compose leaves the pill unrendered. The head itself no longer goes
with it: the nav pill is always there, so the scroll pad and the edge-blur are
unconditional and both read `--mail-chrome`.

**A section is a group bounded by ONE rule (v4).** It was a *hierarchy* of
separators: a soft hairline under every row, inset to the text rule, under a
heavier one across the column between groups. Two axes at once, and legible as
a hierarchy — and still wrong. Sixty rows of it made a **grid**: the reader met
a table before a single sender, and the boundary that carries the whole
structure had to be heard over its own children. So the per-row hairline is
gone, and what is left is one line in the column — the group's boundary, on
§4's `--inset` (12, 8 below md) at `--hair`'s full weight, a weight it can now
afford because
nothing else in the column is a line. Inside a group the letters separate the
way two paragraphs do: on the space between them. Air belongs to the block
below: 24px over the boundary rule, 12 between the rule and the header it
opens, 4 under the header.

Rhythm carries what the hairlines used to. The row runs on a **64px pitch** —
60 of row and 4 of air, the gap on the presence wrapper rather than the row's
own margin, which would collapse to 2. That gap is not decoration: the open
thread and the row under the pointer sit side by side, and two fills that touch
read as one taller fill.

The row's fill is a **capsule on §4's `--inset`**, r14, not a band across
it — 12 at the column's own width, 8 below md where `--inset` steps down, and
the same value the boundary rule and the Compose pill ride, so nothing in the
column has an edge of its own. It sat at a hard 8 while the boundary sat at 12,
which put the fill 4px OUTSIDE its own section on the first and last row of
every group. One row geometry in both lists, the same capsule in both, and one
left rule at 74 (70 below md) carrying the section label, the senders and both
digests. The
column's **first** group draws no boundary — there is nothing above it to be
divided from, and a rule under the pill would be a line between chrome and
scroll (ban #3). Everything else in the column is a group on the same terms: a
failed stream's notices, the loading window at the foot.

**A collapsed section is the same group holding one digest row.** Three rows can
stand for four threads; they cannot stand for sixty-four. So the collapsed
state has two forms and one rule: while a section hides no more than it shows
it **previews** its first `UNIFIED_SECTION_PREVIEW` (3) rows, and as soon as it
hides more it **bundles** into a single 64px row — the two freshest distinct
senders stacked in the **row's 32 avatar gutter** (the same gutter the header's
16 glyph rides, so the digest starts on the senders' rule at 74), "Field
Notes, Product Weekly and 62 more" (the names truncate, the count never does),
the newest subject under it and its time. Two faces, not three, because two is
what the line beside them names and the third would be one of the faces the
count has already promised to hide; they separate on a **cut** — 2px of the
mark behind is masked away around the one in front — never on a ring in the
ground's colour, which would break the moment a tint ran under the stack.
Sixty-four newsletters occupy sixty-four pixels. Seen hides all of itself,
so it always bundles, and its digest is a count on the same rule with the
rail and the gutter standing empty: "9 threads, nothing unread". A section
can cross the line without the reader touching anything — a refresh takes
Newsletters from 6 to 7 — so preview and bundle **swap through presence**: the
outgoing form leaves the flow and fades, the incoming one fades in, never a
cut. The height itself is **not** animated. It was, while the ring carried it,
because a contour that jumps 104px is a contour a reader watches jump; with no
contour left the animation had a box and no edge, and it only ever smoothed
itself — the DOM height changes at once, so every group below snapped while the
box's ghost went on shrinking over them. The column moves in one piece instead.
The
control is the chevron already in the header — a bundle is a different default
state of an object the system already had, never a new one, and the digest row
itself is inert so no second control says the same thing. Which sections are
open lives in `sessionStorage` (`brain.mail.unified-expand`, an external store
read through `useSyncExternalStore`): bundling answers the pile in front of
you, so it has to survive a mode switch, a thread, and a reload inside one
sitting, and be forgotten by tomorrow when the pile is a different pile.

**The Accounts block names what "all" is made of.** All inboxes has one mailbox
and no smart views, so a menu opened there has no destinations block and no
Smart block — the mode does not change the object, it takes out of it what the
mode does not have — and what is left is honest rather than empty: an
`Accounts` label over `All inboxes` and every connected address, each row
opening that account's own mailbox. No per-account unread counts: the menu
reports only a number it can stand behind, and a count here would be the loaded
merge window rather than the mailbox. The address rows wear the envelope, not
the inbox tray of the destinations block above them — these are addresses, not
mailboxes, and four identical trays in one column named neither — and
`All inboxes` wears a **stack** (`layers-minimalistic`) for exactly that
reason: the tray stands one block up meaning one mailbox, and "all" is not one
of them.

**And the block exists only where there is a second address.** A lone account
opens mail into its own Inbox, never the merge. `All inboxes` over one inbox is
a mode with nothing in it, and the row's account word — unique across the
connected accounts or the field says nothing — said nothing on every row of
the first screen a new user saw. The menu draws no Accounts block for one
account: its two rows would be a merge the surface never enters and the
address the reader is already at, and a block of one row is not a block. The
surface re-reads the account list on every refresh, so the moment a second
account connects the block appears with `All inboxes` in it and the trigger
takes the account word, with no reload — and a second account leaving closes
the merge the same way. The palette's `goto-*` routes straight through for
one account, since there is no merge to leave. `mail-surface.test.tsx` holds
both directions and the palette; `mail-nav.test.tsx` holds the block. Frames:
`single-inbox-*` and `single-menu-*` beside their `-before-` pairs, from
`e2e/mail-shots.spec.ts`.

**The row, and its rails.** Both lists render the same object
(`components/mail-row.tsx`), so a reader switching between them never meets a
second design. Two lines on a 64px pitch — a 60px capsule and 4px of air:

- **The snippet is a continuation, not a field.** It follows the subject on the
  same line after a `·`. If sanitising leaves nothing, the line ends — absence
  is shown by absence, and the words "No preview" appear nowhere in the
  product.
- **Snippet sanitising is a rule applied at render**: entities expanded,
  `[image]`-style extractor leftovers dropped, whitespace collapsed. Bounded on
  purpose, so `[Urgent] the lease` keeps its bracket.
- **A bracketed prefix that repeats the sender is dropped**: `[GitHub] The
  "Daily…"` → `The "Daily…"`. The sender is already on the line above and the
  prefix was eating a third of the subject. It fires only when the bracket
  really is the sender's name or its sending domain.
- **Unread is a rail, not a dot inside the text.** The 6px ink dot has its own
  10px column left of the avatar, so every dot in the column lines up and the
  volume of unread mail reads in one pass. Colour is never the only signal —
  unread text stays ink, read falls to ink-2 / ink-3.
- **The message count is a chip**: 16px, `--fill-tint`, Label 11/600 tabular,
  beside the sender. Never left of the date, where two tabular runs read as one
  number.
- **Attachment has a right-hand column** on the second line — a rail that
  truncation cannot eat, unlike the tail of the snippet where the paperclip
  used to live.
- **The source account is a word in the first line's meta column** (Caption
  ink-3, before the time), on every row of the unified list. The word has to
  be **unique across the connected accounts** or the field says nothing:
  `accountWords()` gives each account the shortest token no other account is
  offering at the same step — its local part, else the domain's first label,
  else the address in full — so `misha@example.test` and
  `misha@studio.example` read "example" and "studio" while
  `p.hart@work.example` reads "work". Data the reader cannot mis-set, unlike
  a display name. The single-account list drops the field, the way it drops
  the avatar: it knows whose mailbox it is showing.
- **`dir="auto"` on the subject and on the snippet**, so an Arabic subject
  flips its line and takes its ellipsis to the left while the sender, the
  account word and the time stay where they are.
- **Selected** is `--blue-tint-2` (blue .18 / .24) plus a 1px `--blue-rim`
  around the capsule; **hover** is `--blue-tint` (.07 / .10) in the same
  capsule; **press** is §8's scale .97, because a press that repaints the fill
  hover already wears says nothing. The selection used to be one tint step over
  hover with a hairline above and below, and those hairlines were the condition
  the review put on it: the step between the two fills measured ΔL .020 in
  light, under §8's .03 floor. They went with the rest of the grid, so the
  second signal had to come from somewhere that is not a line across the
  column — the rim, and a wider step. Measured on the canvas
  (`e2e/mail-shots.spec.ts`): ΔL rest→hover .035 light / .051 dark,
  rest→selected .090 / .122, and **hover→selected .055 / .071**. The open row
  keeps all five states of its own: its fill IS the blue capsule, so hover
  there is §8's other mechanism — the ink tint on a layer, fading by opacity
  over the blue — at ΔL .041 / .060.
- **Section header**: Label 11/600 in **full ink**, count tabular ink-3, the 16
  Solar glyph riding the row's avatar gutter so the title starts on the
  senders' left rule at 74 (70 below md, where `--inset` is 8). Register down,
  colour up — the rule above says
  where the group starts, so the header no longer has to compete with the rows
  for size.

| Surface | Where | Spec |
|---|---|---|
| Thread list (P5-a) | `mail-thread-list.tsx` — `.brain-mail-list` | column 360 **on the canvas** (v3 — no ground of its own), and 360 only above `panes`, where something stands beside it — below the breakpoint the column is the whole pane (see "Where three panes stop fitting") and no rule down its right edge either (v4 — distance and a change of density separate the panes). Head: **two rows, floating over the rows in every mode** (`.brain-mail-head`, absolute on `--inset`) — row A the nav pill (see "One control owns mail navigation") at the left and a `ToolbarPill` of 36 icon buttons at the right (the failed-send alarm, compose, sort, sync), row B the search capsule (`.brain-mail-search`, a regular material of its own, blue ring on `:focus-within`) at the column's full width. It used to have a second mode — selects in flow — drawn wherever the rail was not on screen; there is no such question now. `data-chrome-rows="2"` gives the column `--mail-chrome: 80px` (36 + 8 + 36), and the scroll pad and the edge-blur are both derived from it (`ops/design-guardrails.test.ts` holds the number against the heights it is made of). One edge-blur step (`<ScrollEdge variant="blur" steps={1}>`, only where the pills overlap the rows) and one at the **bottom below md**, where the column runs under the mobile tab bar — the scroller reserves the bar's height so the list can still end above it. Rows: `MailRow` (see "The row, and its rails" above) with two fields dropped — no avatar and no account word, because one account needs neither. No separators between them (v4) — the 64px pitch is what divides one letter from the next — and the sync/search status lines sit on the bare list's 28 rule. |
| Unified inbox (P5-d) | `mail-unified-list.tsx`, `mail-nav.tsx` — `.brain-mail-list`, `.brain-mail-section*` | the default mail screen where two or more accounts are connected — a lone account opens into its own Inbox (see "The Accounts block names what "all" is made of") — the thread list's column, rows, edge-blur and blue hover/selection, with its own head and three things besides. **The head is ONE row** (`data-chrome-rows="1"`, `--mail-chrome: 36px`): the nav pill and, at the right edge, the toolbar pill with Compose in it. No search capsule — unified reads no cross-account index — and so no second row. No folder row either, and never was: unified has exactly one folder by construction, so the nav pill names it once and nothing else here can be pressed to change it. **Compose no longer travels.** It used to ride the free right edge of the account select here and sit in the toolbar over there, on the argument that a toolbar row holding one right-aligned button is 52px of empty paper — so switching from All inboxes to one account on a phone moved the button between rows. The nav pill fills that row in both modes, so the toolbar has a right edge to keep and only one "New message" is ever in the a11y tree. **Sections** — People (sub-grouped by account when more than one contributes), Notifications, Newsletters, Seen — are **groups bounded by one rule** (see "A section is a group bounded by ONE rule" above), each carrying a **Label 11/600** sentence-case title in full ink above its rows, the count beside it in the same register, ink-3 and tabular, and the 16px Solar glyph riding the row's avatar gutter so the title starts on the senders' left rule. Sections separate on that boundary rule and on 24px of air; inside a group nothing separates the rows but the 4px between their capsules. **The column has one edge**: the boundary rule, the row capsule and the Compose pill all ride §4's `--inset`, and from it the two left rules follow — `--mail-rule` for a row with an avatar (inset + 4 of the row's own padding + the 10 unread rail + 6 + the 32 avatar + 10 = 74) and `--mail-rule-bare` for one without (32), which is where a failed stream's status line stands. The capsule used to sit at a hard 8 while the boundary sat at 12, so the fill reached 4px OUTSIDE its own section on the first and last row of every group — two rows out of three in a preview. Both ride `--inset` now: 12 at the column's own width, 8 below md, and the two left rules follow it down to 70 and 28 there. The boundary is the structural mark and stays outermost. The header is **one object for every section**, a `<div>` carrying two 28 `IconButton`s at its right edge so neither nests inside the other. **Done** clears the whole section: it archives every thread in it and marks each one read on the way out, so the group leaves the column — which is the point of pressing it. Archive alone is not enough; the provider's archive drops the INBOX label and touches nothing else, so both mutations are sent, archive first, because that is the one that can fail without moving a letter. It takes the section and the count it will MOVE in `aria-label` and `title` ("Done — archive all 8 in Newsletters"), and it acts on the section's **whole** contents — a bundled Newsletters showing one digest row still hands Done all sixty-four. **The count is what Done can archive, not what the section holds.** Not every account can: an account whose service withholds thread mutations puts rows in a section that Done will never move, and the label says so before the press — "Done — archive 11 of 14 in Newsletters". "All 14" would be a promise the button cannot keep, and the three left behind would sit in the column with nothing said about them, which unlike a rollback never corrects itself. Where Done can move **nothing** it is not drawn at all: an always-visible destructive control that silently does nothing is worse than an absent one, and an absent control takes its chrome with it (the rule above). Everywhere else it is **always drawn**, at the IconButton's resting ink-2 beside the chevron. It used to fade in on the header's hover, the tree row's "…" convention, which was right while it only marked mail read: a cheap action can afford to be found where the pointer already is. A control that REMOVES sixty-four letters cannot be one a reader meets by accident, and one nobody can find is not a feature. What makes it safe is not hiding it but the **undo**, and the order of the two buttons — the harmless chevron keeps the column's edge, the easiest target in the row, with Done inboard of it. **The section leaves the column at the press, in one commit, before a single request goes out**, and the report appears with it. It used to empty row by row as the loop landed and report only after the last thread: on sixty-four newsletters that is the protection arriving half a minute after the gesture that needed it, long after the reader has looked away — and an always-drawn destructive control is defensible only because that protection is there. The count in that first message is a statement about the COLUMN, true when it is made: this many letters just left the list. It is not a receipt from the provider. What the loop then fails to move comes back to the column and the same message corrects itself in place — two messages sharing a toast `id` are one sentence said twice, so the correction takes the pill rather than queueing behind its own undo. The report is the shell's snackbar with an Undo, and **its lifetime is the RUN's, not a number computed from the count**. It is posted at the press with NO window and stands until the loop settles; the report then says the same sentence again under the same id with the plain 10s, counted from where the work ended rather than from a press that may be minutes old. The window used to be predicted — 10s plus 6s a thread — and that guess was wrong in both directions. Too short, because a thread is up to two mutations and each may spend the service's whole request budget, so the estimate could expire mid-run and take the way back away from work still going out. Too long, because 40 threads armed 250 seconds: the ring crawled a pixel a second, and a countdown that does not visibly count reads as a pill that has hung. **A ring is a promise of a deadline**, so while the loop is sending there is none to draw and the icon slot holds its glyph alone — the ring APPEARING is the finish line. **The sentence does not count the run out loud** and that is a decision, not an omission: the pill is one `role="status"` with `aria-atomic`, so a live "12 of 40" is the whole message re-announced once per thread; the number would be a provider receipt inside the one line deliberately kept as a statement about the column; and it changes no decision, since Undo is live at every value of that counter and does the same thing at each. **The mutation lock is held for the whole run** and 40 threads is minutes of "Finish the current mail action first" for every other mail action — that is the run's length, not the pill's, and it gets shorter only when the mutations stop being one-at-a-time (a batch through the mail service's private HTTP surface, deferred). It is not held for good any more: a thread mutation nobody answers is ended by the client's own clock at 15 seconds (`MAIL_MUTATION_TIMEOUT_MS`, above every deadline below it, so a slow answer still arrives as itself), an account that went quiet is closed for the rest of the run the way a refused one is and named apart from it (`that account stopped answering` — "no folder for it" would be a lie), and the lock goes with the run. A run the reader walked out of — All inboxes left while it was still sending — lets the request in flight land, sends nothing more, and says so (`2 archived, 1 stayed put, stopped when you left All inboxes`) rather than leaving "stayed put" to imply a refusal; the single list the reader walked into loaded before that last archive landed, so it is asked again the moment it is ready instead of showing the row for the next minute. A letter opened while the lock is held is marked read once the lock lifts; it used to spend its one chance and skip. A letter the service no longer recognises (`mail_thread_stale`: moved by another client, or its mailbox re-keyed under the list) is neither refused nor stayed — it is named (`2 archived, 1 changed on the server`), kept out of the column, and not undone, since nothing of ours is on it. There are **four forms**, and two of them are made before any request goes out — the press-time message has two titles, because a press that leaves rows behind has not cleared the section and the title is the first thing read: `Newsletters cleared / 8 threads out of your inbox` when Done can move the whole section — the column's fact in the column's words, since "archived" is the provider's verb and this sentence is not its receipt — and `Newsletters partly cleared` on the same press when part of the section sits on an account that cannot archive. Then `Newsletters partly cleared / 6 archived, 2 stayed put` when the provider refused some — a failed archive leaves that thread exactly where it was, unread and in its section, and the loop keeps going rather than stopping at the first refusal — and `Couldn't clear Newsletters / 8 threads stayed put` when it refused all of them, which carries **no Undo**, because there is nothing to take back. Threads on an account that cannot archive are named in whichever form appears, after the count (`11 threads out of your inbox, 3 can't leave`). It says LEAVE, not archive: that clause rides beside the column's own words and one sentence cannot carry both registers. A section made only of them refuses out loud instead: `Nothing in Newsletters can leave this account` — a whole sentence of its own, free to name where the limit lives. Neither says "yet": an account that reports no thread mutations is saying what it is, not where it stands in a queue, so "yet" would promise a later that may never arrive for that mailbox — the same kind of promise the count above refuses to make. A second refusal lives one layer down and never reaches this clause. A custom-domain account mutates threads through IMAP — `\Seen` and `\Flagged` in place, archive and trash as a MOVE into a folder found by SPECIAL-USE or by a well-known name — and a server that advertises no such folder and names none has nowhere to move mail TO. That is refused per thread at the press, lands in `stayed put` where the loop counts it, and on a single thread says `Your mail server has no folder for that.` rather than the generic failure, because "try again" would be a lie about a folder that does not exist. The clause above is about the account and can be known before the press; this one is about the folder and cannot. **Undo reports too**, in the same all / some / none shapes and without a way back of its own: `Back in your inbox / 3 threads restored`, `Put back 5 of 7 / 2 stayed archived` when the un-archive was refused for some, and `Couldn't put anything back / Your mail is where the archive left it. Try again.` when it was refused for all. The count is what came BACK from the archive: rows the loop never reached return to the column with no request and are not counted — "40 threads restored" over a run that had moved five was the same lie as a receipt, the other way round — and an Undo that arrives before anything has left says `Nothing had left yet`. A letter the server no longer recognises on the way back is `1 changed on the server`, not "stayed archived", and comes off the column; when nothing came back for that reason alone the sentence is `Your mail changed on the server. Refresh Mail to see it.`, and never "try again", which could not help. The same code on a single action says `That conversation changed on the server. Refresh Mail to see it.` **Undo has a press-time pill of its own**, the mirror of Done's: the rows return to the column in one commit and the un-archives go out one request at a time — forty on a slow account is ten seconds — so `Putting back… / 40 threads on the way back` stands under the SAME id, with no window, no ring and no way back of its own, until the report replaces it. Measured before it existed: the column said "back" and the pills said nothing until the finish. **Undo can arrive while the loop is still sending**, which is the price of offering it at the press: it sets the run's abort flag, waits for the loop to drop the mutation lock, and reverses what has gone — everything still queued never leaves at all. The press is taken but not spent: the pill stands, its button out of reach and reading `Undoing…`, until the loop settles, and a request in flight is left to land (or to run into the client's deadline) rather than cut, because a cut request has an outcome nobody knows and the reversal has to know exactly what left. Taken down at the press, the way back looked spent over a run that was still sending, and once that run hung on one request there was nothing left on screen to press. It un-archives exactly the threads that moved and returns the unread flag to the ones Done marked read (`archive: false` is a real mutation on the service, not a client-side illusion), and the rows come back in one commit before its own requests, the same way they left. Two Dones inside one window cannot eat each other: a second press while the lock is held is refused out loud (`Finish the current mail action first`, the sentence the undo has always used), and a REPORT arriving while a live Undo is standing waits for that window to close instead of replacing it. **A refusal does not wait.** It answers a gesture the reader has just made, so it speaks at once or not at all — queued behind a ten-second undo it would surface long after the press, detached from it and by then untrue. So a refusal takes a pill of its own, in an assertive live region, at the head of the pill column (`ToastOptions.urgent`), and never touches the queue. It used to be placed by hand, 60px over whatever stood below it — a figure measured on a one-line pill, which the mixed-account subtitle above wraps to two on a 390 phone, landing the refusal back on the report it was clearing. The column places them now (see Toast in the components table). **The refusal carries no icon**, and that is the rule rather than an omission: the icon slot is the countdown ring's HOST, so a pill with a window to count wears the ring and a pill with nothing to take back carries neither — the two save pills that offer no way back are bare for the same reason. The slot and the ring are separable, and Done's press-time report is where they separate: it has a way back, so it keeps its glyph, and no deadline yet, so it wears no ring until the run lands. The alternative, disabling Done while a run is live, was rejected: a disabled control with no stated reason is its own disease. An Undo the lock refuses is not spent — the press returns `false`, the pill keeps standing and the reader can press again. **Seen gets Done too.** It was the one section without it, on the argument that a read pile holds nothing to finish — a mark-all-read argument that outlived mark-all-read. Done files mail away, and a pile already read is precisely the pile a reader wants out of the column; the other half of that argument, that a stray press would remove what someone deliberately kept, is the one this section rejects when it says the protection is the undo and not the hiding. Spark puts the same control on the same header, so the position has precedent. **⌘Z reaches the Undo**, the way it already reaches a pending page delete: the pill is a `role="status"`, focus never moves there and the Tab order does not pass through it, so without the binding the ten seconds a bulk archive offers were mouse-only. One effect on the standing toast's own action, the model of the one page delete has had all along. **Known gap**: the pill still cannot be reached by Tab, so a keyboard reader who does not know ⌘Z has no way in. The **disclosure** is the chevron beside it, turning 90° over 200ms `--ease-out`, present wherever the collapsed section hides rows — always on Seen, past the 3-row preview on the others — and **its 28 slot is kept even when there is nothing to disclose**: People with two threads is the ordinary case, and without the spacer Done would inherit the column's edge there, which is the position the argument above reserves for the harmless control, and would shift 34px between one section of a column and the next. On touch the header spreads the two controls to 44 between centres, because two 28 controls 6 apart put their 44 hit strips 10px into each other and which one owned the contested strip was decided by document order — and it is the control for the bundle too, never a separate one under the rows: a reader who learns that the chevron opens Seen has to find the same chevron in the same place on Newsletters. The row is `MailRow` with both optional fields present — a 32 sender avatar in the leading gutter and the account word in the meta column: the merged list is the one place a reader has to tell accounts and senders apart at a glance. The bottom of the merge window is **loading skeletons**, not a button: the column continues and reaching them is the request (`IntersectionObserver`, re-armed only when the loaded count moves), with an `sr-only` "Load more" kept for the keyboard and for assistive technology, since scrolling is a pointer gesture. They stand as **a group like everything else** — a loading state has the shape of the loaded state, bounded by the same rule — and so does a failed stream's notice. The bundle row is a `role="listitem"` and says its unread count in an `sr-only` word, because its dot is a mark and a mark is not announced. |
| Drafts column | `mail-drafts.tsx` — `.brain-mail-list` | the third column built on this class, and the one with the shortest head: **one row** (`data-chrome-rows="1"`, so `--mail-chrome` keeps its base 36 and nothing overrides it), the nav pill naming `Drafts` and nothing beside it. There is no cross-draft search and no sort, so neither row B nor the toolbar pill is drawn, and an absent control takes its chrome with it. Drafts is a destination reached and left through that pill (see "One control owns mail navigation"), so the head carries no Back button and no title of its own. Both edge-blurs stay: one step at the top where the pill overlaps the rows, one at the bottom below md where the column runs under the mobile tab bar. **The rows are not `MailRow`.** A draft has no unread rail, no avatar and no account word, and side by side its two fields read as one clipped sentence — so they stack: the subject at Control 13 in ink (`(no subject)` where there is none) with the draft's own time beside it (Caption ink-3, tabular — the subject gives way first when the line runs out, the time never), and under it what the draft is — `New message`, `Reply`, `Forward` — at Control ink-2, with a send state after a `·` in full ink where there is one. A draft the service will not reopen, mid-send or left ambiguous, is listed so the writer can see it and drawn as plain text, because a control that does nothing is worse than none. Delete stands on the row's text rule at rest — a 28 `IconButton` 8 inside the capsule at either inset, where the mailbox row keeps its time and its paperclip — the row reserving its room rather than handing it to a hover: the two lines reserve 36 before it, the capsule plus the rule, on one wrapper. The reserve used to be a `pr-10` on the row, which `.brain-mail-row`'s own padding in `globals.css` beat (a utility loses to an unlayered rule), so it was never there. Measured at 1440: a 39-character subject put its date 16px under the button, and a 95-character one grew the line past the capsule — a line left to fit its content under `align-items: flex-start` had no width to truncate against — and took the date 300px off the row. The lines take the row's width now (`self-stretch`), and the button, anchored on the window's inset before, stood 4px past the capsule on the desktop and flush with it on a phone. `e2e/mail-client.spec.ts` holds the date inside the capsule and 8 clear of the button at 336 and at 374, and `drafts-*.png` stands beside `drafts-before-*.png`. It asks before it deletes (see Mail confirmations). Loading is three skeleton rows, and empty and error are one centred message — Table ink over a Caption line, with `Try again` under the error. |
| Mail confirmations | `ConfirmDialog` (`ui/confirm-dialog.tsx`) | Two questions, and both were `window.confirm` until a review screenshot arrived asking what the browser window was — a system alert wearing the origin as its title, in the OS's own type, saying nothing about what would disappear. They are the system's `ConfirmDialog` now: **deleting a saved draft** from the Drafts list, and **Discard** in the composer. Nothing else in mail asks, and that is the rule — the thread mutations all have inverses and the section Done has an undo, so deleting a stored draft is the only mail action with no way back. **Discard is not Close**: closing keeps the draft, which is already saved and waiting in Drafts, and asks nothing; Discard deletes it from the provider, which is why it is the one that asks. Each question **names what leaves** (the draft's own subject in quotes) rather than saying "this draft". What the native dialog gave for free is paid for explicitly: Esc dismisses (Radix `AlertDialog`), **Cancel holds focus on open** so Enter can never be the destructive answer, and `returnFocus` hands focus back to the control the press came from — Radix restores whatever was focused when it opened, which is not the button on a platform that does not focus buttons on click. |
| Reader strip (P5-b) | `mail-reader.tsx` — `.brain-mail-reader-head` | in flow above the scroller, **on the canvas** and with no ground of its own (v6) — no fill, no radius, no hairline, so it has no contour anywhere on the window, not only where the edge tint happens to be spent. It used to paint `--paper`, defended as the thing the message scrolls under, which the frame's clip at the scroller's top edge makes untrue; the plate measured ΔL 0.001 on a desktop and 13/8/2 in RGB at 390, where the reader is the window and the strip sits in the sky radial's corner. **Its two edges take two rules**: left padding on the article column's (20 / 32) so the two share a left edge, right padding on §4's one inset — `max(--inset, safe-area-inset-right)`, the 12 the page's own pills keep at the window and the 12 the column's marks ride at theirs — because the pill at that end is chrome on the window's edge, not a mirror of the text rule. The back button hangs its capsule into the left gutter at `-ml-2`. It carries the **subject** (H3 15/600, the `<h1>`) and the **message count** with the thread's last date on a `·` (Caption ink-2) — the one line every message in the thread shares. It carries no sender: the thread's first participant is the wrong name the moment you scroll to a reply, so each article names its own. Actions are `quiet` buttons in a `ToolbarPill` (ink by the pill rule above). `Mark unread`, the resting label, is drawn from `--breakpoint-strip` up and lives in the ⋯ menu below it (see "One pane has a second line"). |
| Reader scroller (P5-b) | `mail-reader.tsx` | the message — sandboxed iframe included — is clipped by this scroller's own top edge and never painted under a backdrop layer. `<ScrollEdge variant="fade">`: no scroll edge in Brain hard-clips, and inside mail the edge must be a **mask**, because a backdrop layer over the frame is the hard rule's exact violation. Each article opens with its own sender (Table 14/600), address and recipients (Caption ink-3) and date **on the canvas**, and its body sits on the article's own `.brain-mail-sheet` (r14 + `--hair-soft`) — the sheet's edge is the boundary between messages, so no rule runs between articles and the iframe draws no ring of its own. Attachments are 28 paper capsules r14 with a hairline ring, paperclip glyph, filename and tabular size, inside the sheet. The security model (sandboxed iframe, sanitizer, remote images on open) is untouched by the restyle. |
| Composer sheet (P5-c) | `mail-composer.tsx` — `.brain-composer-sheet` | a **thick sheet** on the pane's inset, r20 (control 10 + padding 10), max 700 — the editor column's width. At md+ it materializes on `data-state="open"` (keyframes; the sheen and edge-light ride `::before` and arrive at 60%). Below md it keeps the sheet form: framer slides it in on `SPRING_SHEET` and the grip drags it away from the current value, releasing on `SPRING_SHEET_GESTURE` or past 120px / 800px·s⁻¹ into a dismiss (ban #8 — a gesture never runs on a CSS transition). |
| Composer fields | `.brain-composer-fields`, `.brain-composer-field`, `.brain-composer-from`, `.brain-composer-copies` | column on the 4px step. To/Cc/Bcc/Subject are the `.field` atom with the label inside at ink-3 (16px on touch so iOS never zooms, Table 14 at md+). `flex: 1` belongs to the **row**, never to the field atom: in the column the same declaration resolves on the main axis and collapses a field to its content height. `From` is not a field — the composer cannot switch account, so it reads as meta on the fields' label rule rather than sitting in the header as the one thing nobody can click. The `Cc Bcc` toggle takes the field's paper box so the To row ends on the same rule as the Subject row under it. |
| Composer body | `.brain-composer-body` | a paper block r10 carrying the field's ring convention — hairline → `--hair-strong` on hover → 1.5px blue `:focus-within`. Glass never sits under editable text (ban #2). It shares one fade scroller with the fields (`<ScrollEdge variant="fade">` — inside a glass panel the edge is a mask, never a second backdrop layer), invisible until the draft runs past an edge. |
| Composer actions | `.brain-composer-actions` | `quiet` buttons and **one** `ink` primary (Send) directly on the sheet — no `ToolbarPill` (see the pill rule above). Discard is `destructive` (red 600 text, red tint on hover, never a red fill). The send shortcut wears the `Kbd` atom, not the button register beside it. Compose is a `quiet` 36 IconButton in the column's toolbar pill, so the sheet's Send is the only ink-filled primary on the surface without anything having to step down for it. |

Not built: compose-time attachments. `MailSendInput` carries no attachment
list and the draft API stores none, so the sheet has no attach control — adding
one is a mail-service change, not a design one. What the sheet does owe the
writer is the guard: `dragover` and `drop` are cancelled over the composer, so
a file dragged onto it cannot navigate the window away and take the unsaved
draft with it, and a toast says the feature is not there yet.

## Migration from v1

Retired v1 rules (the old tokens stay in `globals.css` until the last surface is restyled):

- **The No Accent Rule** — system blue (links, focus, selection) is in and the ink-only focus ring is replaced by the blue ring. The primary stays ink: one ink-filled control per surface (`--accent` / `--accent-ink`, inverted in dark). Yellow is transient (handles) and content (stickers), never chrome.
- **The Flat by Default Rule** — floating chrome carries material shadows graded by thickness; paper stays flat.
- **No glassmorphism / no gradients** — functional glass (three materials with fallbacks) and the static edge tints are in; *decorative* glass and gradient text stay banned.
- **"Compact and quiet chrome"** — chrome is a separate floating layer with inset 12 and its own physics.
- **Body 16/1.7** → 16/1.5 under SF; **title 28–30/600** → 30/700; the "UI label 13–15" range → fixed registers.
- **Radii xs/sm/md/lg/xl** → concentric radii per component; the old scale stays for surfaces not yet restyled.
- **`--surface`** (raised paper) goes away once the sidebar is glass — there is one paper.
- **Transitional tokens**: `--ink-v2`, `--ink-2-v2`, `--ink-3-v2`, `--scrim-v2` carry the v2 values while `--ink`, `--ink-2`, `--ink-3`, `--scrim` keep the v1 ones for the current UI. Phase 2 points the old names at the new values and the `-v2` names are deleted in Phase 6.
