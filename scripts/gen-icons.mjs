// Extracts the Solar icons we use from @iconify-json/solar into a tiny
// generated module — offline, no runtime fetch, no full-set bundle.
// Run: node scripts/gen-icons.mjs   (re-run after adding names below)
//
// Three lists: WANT holds full names (one variant each); PAIRS holds base names
// that ship as a linear + bold pair — linear at rest, bold in the selected
// state (SF Symbols regular/fill). <Icon name="home" variant="bold" /> resolves
// to "home-bold", so a pair is the only way to request a bold variant. BARE
// holds the three glyphs Solar does not draw on their own (DESIGN.md §10 ban
// 13) — see the block above it.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { icons } = require("@iconify-json/solar");

const WANT = [
  "magnifer-linear",
  "pen-new-square-linear",
  "settings-linear",
  "hamburger-menu-linear",
  "trash-bin-trash-linear",
  "cloud-cross-linear",
  "danger-triangle-linear",
  "alt-arrow-left-linear",
  "alt-arrow-right-linear",
  "sun-linear",
  "moon-linear",
  "document-text-linear",
  "hashtag-linear",
  "menu-dots-bold",
  "lock-keyhole-minimalistic-linear",
  "lock-keyhole-minimalistic-unlocked-linear",
  "eye-linear",
  "eye-closed-linear",
  "share-linear",
  "copy-linear",
  "link-linear",
  "text-bold-linear",
  "text-italic-linear",
  "text-cross-linear",
  "code-linear",
  "list-linear",
  "smile-circle-linear",
  "palette-linear",
  "plug-circle-linear",
  "earth-linear",
  "text-linear",
  "widget-2-linear",
  "gallery-add-linear",
  "sticker-smile-circle-2-linear",
  "magic-stick-3-linear",
  "inbox-linear",
  "letter-linear",
  "history-2-linear",
  "clock-circle-linear",
  "arrow-left-linear",
  "arrow-right-linear",
  "restart-linear",
  "ghost-linear",
  "code-square-linear",
  "text-field-linear",
  "calculator-minimalistic-linear",
  "widget-4-linear",
  "list-arrow-down-linear",
  "pin-bold",
  "pin-linear",
  "star-linear",
  "plain-linear",
  "archive-linear",
  "danger-linear",
  "letter-unread-linear",
  "mailbox-linear",
  "user-rounded-linear",
  "paperclip-linear",
  "sort-vertical-linear",
  "alt-arrow-down-linear",
  "bell-linear",
  "align-left-linear",
  "align-horizontal-center-linear",
  "align-right-linear",
  // "all inboxes": a stack, never the tray. The tray already stands one row
  // above it in the same menu meaning one mailbox, and §13 refuses four
  // identical trays in a column that names none of them.
  "layers-minimalistic-linear",
];

/**
 * A plus, a cross and a check, drawn bare (DESIGN.md §10 ban 13).
 *
 * The Solar this repo is pinned to (1.2.5) ships none of the three on their
 * own: every plus, cross and check in it is already inside a circle or a
 * rounded square. Solar 1.2.10 added bare `add` and `close` — so the two
 * bodies below are that version's OWN drawings, copied verbatim and keyed
 * under the same names. Backporting rather than inventing means the upgrade
 * (which also has to deal with `magnifer` → `magnifier`) moves no pixels: the
 * loop below prefers Solar's copy the moment it exists and stops the build if
 * the two ever disagree.
 *
 * `check` Solar still does not draw bare at any version, so that one is its
 * own `check-circle-linear` glyph lifted out of the ring and scaled about
 * (12,12) onto the same 4→20 box the other two fill. Weight, caps and joins
 * are Solar's throughout — these belong to the set, they are not a second one
 * (ban 12).
 */
const BARE = {
  // Solar 1.2.10 `add-linear`, verbatim.
  "add-linear":
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path d="M4 12L20 12"/><path d="M12.0204 4L12.0205 20.0003"/></g>',
  // Solar 1.2.10 `close-linear`, verbatim.
  "close-linear":
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path d="M19.0068 5L5.00684 19"/><path d="M19 19L5 5"/></g>',
  // Derived: `check-circle-linear` · m8.5 12.5l2 2l5-5 (7 wide) × 16/7, the
  // elbow left at Solar's own 2/7 along the stroke.
  "check-linear":
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 13l4.5 4.5L20 6.5"/>',
};

/** Linear + bold pairs for active states (sidebar, settings nav, tab bar). */
const PAIRS = [
  "home",
  "inbox",
  "letter",
  "settings",
  "trash-bin-trash",
  "magnifer",
  "pen-new-square",
  "star",
  "folder",
  "document-text",
  // settings surface sections
  "palette",
  "plug-circle",
  "earth",
  "user-circle",
];

const names = [...new Set([...WANT, ...PAIRS.flatMap((b) => [`${b}-linear`, `${b}-bold`])])];

const out = {};
for (const name of names) {
  const data = icons.icons[name];
  if (!data) {
    console.error(`MISSING solar icon: ${name}`);
    process.exit(1);
  }
  out[name] = data.body;
}
/** Solar's own body for a name, following one level of alias. */
function shipped(name) {
  const alias = icons.aliases?.[name];
  const data = icons.icons[name] ?? (alias ? icons.icons[alias.parent] : undefined);
  return data?.body;
}

for (const [name, body] of Object.entries(BARE)) {
  const own = shipped(name);
  if (own && own !== body) {
    console.error(
      `Solar's ${name} is not the drawing BARE carries — compare the two and ` +
        `either take Solar's or rename ours. Do not let it change silently.`,
    );
    process.exit(1);
  }
  out[name] = own ?? body;
}

const file = `// AUTO-GENERATED by scripts/gen-icons.mjs — do not edit by hand.
// Icons: Solar by 480 Design (CC BY 4.0) via @iconify-json/solar. add/close/
// check are Solar glyph paths taken out of their ring and scaled — see BARE.
export const SOLAR: Record<string, string> = ${JSON.stringify(out, null, 2)};
`;
writeFileSync(new URL("../components/ui/solar-icons.generated.ts", import.meta.url), file);
console.log(
  `wrote ${names.length + Object.keys(BARE).length} icons ` +
    `(${PAIRS.length} linear/bold pairs, ${Object.keys(BARE).length} bare glyphs)`,
);
