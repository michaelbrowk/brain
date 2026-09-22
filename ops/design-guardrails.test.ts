import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Static design guardrails for the Liquid Glass migration. Same shape as
// ci-cost-guardrails: read files, assert, no browser. Each rule names the
// migration phase that moves an allowlisted file onto the real material.

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  ".wrangler",
  "playwright-report",
  "test-results",
  "__pycache__",
]);
const SOURCE_DIRS = ["app", "components", "lib"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function relative(file: string) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function sourceFiles() {
  return SOURCE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    .filter((file) => !/\.(test|spec)\.tsx?$/.test(file))
    .map(relative)
    .sort();
}

function lines(file: string) {
  return readFileSync(path.join(ROOT, file), "utf8").split("\n");
}

describe("design guardrails", () => {
  it("keeps backdrop blur inside the material layer", () => {
    // Glass is one utility, not a per-component `backdrop-blur` sprinkle.
    // The utility lives in globals.css (`mat-*`, `.edge`) and the material
    // primitive; every other file has to compose those.
    const MATERIAL_FILES = new Set([
      "app/globals.css",
      "components/ui/material.tsx",
      // The scroll-edge atom owns `.edge`; its blur lives in globals.css and
      // the component only documents it.
      "components/ui/scroll-edge.tsx",
    ]);
    // Pre-migration surfaces that still blur on their own. Each entry is
    // removed by the phase that restyles it — do not add to this list.
    const ALLOWLIST = new Map<string, string>([
    ]);
    const pattern = /backdrop-filter|backdrop-blur|backdropFilter/;

    const offenders: string[] = [];
    const unusedAllowlist = new Set(ALLOWLIST.keys());
    for (const file of sourceFiles()) {
      if (MATERIAL_FILES.has(file)) continue;
      const hits = lines(file)
        .map((line, index) => (pattern.test(line) ? index + 1 : 0))
        .filter(Boolean);
      if (hits.length === 0) continue;
      if (ALLOWLIST.has(file)) {
        unusedAllowlist.delete(file);
        continue;
      }
      offenders.push(`${file}:${hits.join(",")}`);
    }

    expect(
      offenders,
      "backdrop blur outside the material layer — compose `mat-*` / <Material> instead",
    ).toEqual([]);
    expect(
      [...unusedAllowlist],
      "allowlist entry no longer blurs — drop it from ALLOWLIST",
    ).toEqual([]);
  });

  it("keeps type sizes inside components/ui on the register set", () => {
    // DESIGN.md v2 → Typography: ten registers, no other size. The atoms in
    // components/ui and their classes in globals.css (the "Components (v2)"
    // block) are the first surfaces held to it; the rest of the app joins
    // surface by surface in the train.
    const REGISTER_SIZES = new Set([11, 12, 13, 14, 15, 16, 17, 22, 30]);
    const tailwindSize = /text-\[(\d+(?:\.\d+)?)px\]/g;
    const cssSize = /font-size:\s*(\d+(?:\.\d+)?)px/g;

    const offenders: string[] = [];
    const check = (file: string, text: string, pattern: RegExp) => {
      text.split("\n").forEach((line, index) => {
        for (const match of line.matchAll(pattern)) {
          const size = Number(match[1]);
          if (!REGISTER_SIZES.has(size)) offenders.push(`${file}:${index + 1} ${match[0]}`);
        }
      });
    };
    for (const file of sourceFiles()) {
      if (!file.startsWith("components/ui/")) continue;
      check(file, readFileSync(path.join(ROOT, file), "utf8"), tailwindSize);
    }
    const globals = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    const start = globals.indexOf("/* ── Components (v2)");
    const end = globals.indexOf("/* ── Background under glass (v2)");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    check("app/globals.css (Components v2)", globals.slice(start, end), cssSize);

    expect(offenders, "a size outside the register set — pick a register").toEqual([]);
  });

  it("draws a plus, a cross and a check bare", () => {
    // DESIGN.md v2 → Named bans 13. The control already supplies the shape, so
    // a ring or a box around one of these three glyphs is a second shape for
    // one action, and at 14–18px the enclosure takes the weight the glyph
    // needs to read. The bare names live in `scripts/gen-icons.mjs` → BARE.
    //
    // Anchored at the start of the name on purpose: this bans the ENCLOSURE of
    // a plus, cross or check, not every icon that happens to contain a circle
    // or a square. `smile-circle` and `sticker-smile-circle-2` are faces,
    // `pen-new-square` and `code-square` are a page, `clock-circle`,
    // `plug-circle` and `user-circle` are objects, `text-cross` is a
    // strikethrough — those are drawings, and they stay.
    const GLYPHS = ["add", "plus", "close", "cross", "check", "minus"];
    const ENCLOSURES = ["circle", "square"];
    const VARIANTS = [
      "linear",
      "bold",
      "outline",
      "broken",
      "line-duotone",
      "bold-duotone",
    ];
    // Quote characters only, not backticks: an icon name in this repo is
    // always a plain string literal, and prose above a call site has to be
    // able to say which glyph it replaced.
    const banned = new RegExp(
      `["'](?:${GLYPHS.join("|")})-(?:${ENCLOSURES.join("|")})` +
        `(?:-\\d+)?(?:-(?:${VARIANTS.join("|")}))?["']`,
      "g",
    );

    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      lines(file).forEach((line, index) => {
        for (const match of line.matchAll(banned)) {
          offenders.push(`${file}:${index + 1} ${match[0]}`);
        }
      });
    }
    expect(
      offenders,
      "an enclosed plus/cross/check — use the bare `add` / `close` / `check`",
    ).toEqual([]);

    // The rule is only worth having if it still lets the drawings through.
    const drawings = [
      '"smile-circle-linear"',
      '"sticker-smile-circle-2-linear"',
      '"pen-new-square-linear"',
      '"code-square-linear"',
      '"clock-circle-linear"',
      '"plug-circle-bold"',
      '"user-circle-linear"',
      '"text-cross-linear"',
      '"cloud-cross-linear"',
      '"text-cross-circle-linear"',
    ];
    expect(drawings.filter((name) => banned.test(name))).toEqual([]);

    // And the three bare glyphs have to exist, or every call site renders
    // nothing: <Icon> falls back to null on a name the set does not carry.
    const generated = readFileSync(
      path.join(ROOT, "components/ui/solar-icons.generated.ts"),
      "utf8",
    );
    for (const name of ["add-linear", "close-linear", "check-linear"]) {
      expect(generated, `${name} is missing — run node scripts/gen-icons.mjs`).toContain(
        `"${name}"`,
      );
    }
  });

  it("draws every date and every time itself, everywhere it ships", () => {
    // D4: `components/tasks-when-picker.tsx` is the one date and time control
    // in this app, on a pointer and on touch alike. The native input is four
    // different controls across the browsers this runs in, it renders its own
    // chrome in its own metrics inside a menu the spec calls quiet, and on
    // touch it hands the gesture to a sheet Brain does not draw.
    //
    // Whole-file text rather than line by line: JSX puts the attribute on its
    // own line, and `[^>]` matches a newline inside a character class.
    const jsx = /<input\b[^>]*\btype\s*=\s*["'](date|time|datetime-local|month|week)["']/g;
    const dom = /\.type\s*=\s*["'](date|time|datetime-local|month|week)["']/g;

    // EVERY SOURCE DIRECTORY, not only `components/`. The spec's wording was
    // where the four call sites were; a native input a directory over is the
    // same second date control, and `app/` and `lib/` were already being
    // walked and then thrown away.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      for (const pattern of [jsx, dom]) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(`${file}:${line} ${match[1]}`);
        }
      }
    }
    expect(
      offenders,
      "a native date or time input: use <TasksWhenPicker> or renderWhenPicker",
    ).toEqual([]);

    // The rule is only worth having if it still lets the others through.
    expect([...'<input type="text" />'.matchAll(jsx)]).toEqual([]);
    expect([...'const property = { type: "date" };'.matchAll(dom)]).toEqual([]);
  });

  it("has no macOS Finder duplicate files", () => {
    // iCloud / Finder produce `name 2.tsx` next to `name.tsx`. vitest's glob
    // would run a stale `*.test 2.tsx` as a real test, and tsc would type it.
    const dupes = walk(ROOT)
      .map(relative)
      .filter((file) => / \d+\.[a-z0-9]+$/i.test(path.basename(file)))
      .sort();
    expect(dupes, "delete the Finder copies (diff against the original first)").toEqual(
      [],
    );
  });

  it("keeps mail's pane breakpoint at one number in all three places", () => {
    // 1160 is written three times and a media query cannot read a custom
    // property, so nothing but a test can hold them together: the token
    // (`--breakpoint-panes`, which Tailwind turns into the `panes:` variant),
    // the raw query that gives the column its 360, and the constant the
    // Escape handler matches on. Two of the three agreeing is worse than one
    // wrong number — the layout would switch at one width and the keyboard at
    // another. See DESIGN.md §13 -> "Where three panes stop fitting".
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    const surface = readFileSync(
      path.join(ROOT, "components/mail-surface.tsx"),
      "utf8",
    );

    const token = /--breakpoint-panes:\s*(\d+)px;/.exec(css)?.[1];
    expect(token, "--breakpoint-panes is missing from globals.css").toBeDefined();

    const constant = /const MAIL_PANES_MIN_WIDTH = (\d+);/.exec(surface)?.[1];
    expect(
      constant,
      "MAIL_PANES_MIN_WIDTH is missing from mail-surface.tsx",
    ).toBe(token);

    // the column's 360 hangs off the same number
    expect(
      css.includes(`@media (min-width: ${token}px) {\n  .brain-mail-list {`),
      `the .brain-mail-list width query does not read (min-width: ${token}px)`,
    ).toBe(true);
  });

  it("keeps the reader strip's label line on the numbers it is made of", () => {
    // `--breakpoint-strip` is where the action pill's resting labels stop
    // fitting beside the subject on ONE pane. What it is made of sits in
    // three places: the sidebar, the inset, the strip's rule and gap are
    // CSS; the Back capsule's size and hang are markup; the pill's 277 and
    // the subject's 159 are measurements DESIGN.md §13 records. The sum is
    // checked rather than restated, and the one call site has to read the
    // variant Tailwind makes of the token — a `sm:` or a `min-[…]` there
    // would be a second number. See DESIGN.md §13 -> "One pane has a second
    // line".
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    const reader = readFileSync(
      path.join(ROOT, "components/mail-reader.tsx"),
      "utf8",
    );

    const token = /--breakpoint-strip:\s*(\d+)px;/.exec(css)?.[1];
    expect(token, "--breakpoint-strip is missing from globals.css").toBeDefined();
    expect(
      /@theme static \{[^}]*--breakpoint-strip/.test(css),
      "--breakpoint-strip has to be `@theme static`, or :root never carries it and the e2e cannot read it",
    ).toBe(true);

    const inset = /--inset:\s*(\d+)px;/.exec(css)?.[1];
    const sidebar = /--sidebar-w:\s*(\d+)px;/.exec(css)?.[1];
    const gap = /\.brain-mail-reader-head \{[^}]*?gap:\s*(\d+)px;/.exec(css)?.[1];
    const rule =
      /@media \(min-width: 768px\) \{\s*\.brain-mail-reader-head \{[^}]*?padding:[^;]*?\s(\d+)px;/.exec(
        css,
      )?.[1];
    expect(inset, "--inset is missing").toBeDefined();
    expect(sidebar, "--sidebar-w is missing").toBeDefined();
    expect(gap, "the reader strip declares no gap").toBeDefined();
    expect(rule, "the reader strip's md+ left padding is missing").toBeDefined();

    const back =
      /aria-label=\{`Back to \$\{[^`]*`\}[\s\S]*?className="[^"]*-ml-(\d+)[^"]*"/.exec(
        reader,
      )?.[1];
    expect(back, "the Back button no longer hangs into the gutter (-ml-N)").toBeDefined();
    const BACK_CAPSULE = 28; // IconButton size={28}
    const SUBJECT_FLOOR = 159; // the caption's 157 + 2 — §13
    const PILL_AT_REST = 277; // Mark unread 105 + Archive 74 + Reply 62 + ⋯ 36 — §13
    const HEADROOM = 6; // the six 1160 keeps over its floor, kept here too

    const line =
      Number(sidebar) +
      Number(inset) * 2 +
      Number(rule) +
      (BACK_CAPSULE - Number(back) * 4) +
      Number(gap) +
      SUBJECT_FLOOR +
      Number(gap) +
      PILL_AT_REST +
      Number(inset) +
      HEADROOM;
    expect(Number(token), "the token no longer adds up to its parts").toBe(line);

    // the one call site reads the variant, and nothing else on that button
    // names a width
    const toggle =
      /onClick=\{\(\) => onAction\(thread, "toggle-read"\)\}/.exec(reader)?.index ??
      -1;
    expect(toggle, "the reader's Mark unread button is gone").toBeGreaterThan(0);
    const button = reader.slice(reader.lastIndexOf("<Button", toggle), toggle);
    expect(button).toContain("strip:inline-flex!");
    expect(button).not.toMatch(/\b(sm|md|lg|xl|panes|min-\[)[^ "]*:inline-flex/);
  });

  it("keeps mail's head height on the rows it is made of", () => {
    // `--mail-chrome` is the second place the head's height lives: the rows
    // are in the markup and the number is in CSS, and nothing but a test can
    // hold the two together. The column declares how many rows it draws
    // (`data-chrome-rows`) and the scroll pad and the top edge-blur both read
    // the variable, so a row added or dropped has to move the number with it.
    //
    // One row is the nav pill alone; two rows is the pill, the head's own gap
    // and the search capsule. All three of those heights are readable here,
    // so the arithmetic is checked rather than restated. See DESIGN.md §13 ->
    // "The head has one mode".
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");

    const pill = /\.toolbar-pill \{[^}]*?height:\s*(\d+)px;/.exec(css)?.[1];
    expect(pill, "the toolbar pill has no height in globals.css").toBeDefined();
    const search = /\.brain-mail-search \{[^}]*?height:\s*(\d+)px;/.exec(css)?.[1];
    expect(search, "the search capsule has no height").toBeDefined();
    const gap = /\.brain-mail-head \{[^}]*?gap:\s*(\d+)px;/.exec(css)?.[1];
    expect(gap, "the mail head declares no gap between its rows").toBeDefined();

    const oneRow = /\.brain-mail-list \{[\s\S]*?--mail-chrome:\s*(\d+)px;/.exec(
      css,
    )?.[1];
    expect(oneRow, "--mail-chrome is missing from .brain-mail-list").toBe(pill);

    const twoRows =
      /\.brain-mail-list\[data-chrome-rows="2"\] \{\s*--mail-chrome:\s*(\d+)px;/.exec(
        css,
      )?.[1];
    expect(
      twoRows,
      `a two-row head is ${pill} + ${gap} + ${search}`,
    ).toBe(String(Number(pill) + Number(gap) + Number(search)));

    // and the two consumers read the variable rather than a literal
    expect(
      /\.brain-mail-scrollpad \{\s*padding-top:\s*calc\(var\(--inset\) \+ var\(--mail-chrome\) \+ 8px\);/.test(
        css,
      ),
      "the scroll pad does not derive from --mail-chrome",
    ).toBe(true);
    expect(
      css.includes(
        "--edge-size: calc(var(--mail-chrome) + var(--inset) + 28px);",
      ),
      "the top edge-blur does not derive from --mail-chrome",
    ).toBe(true);

    // every mail column declares which head it draws, or the variable falls
    // back to one row on a column that draws two
    const columns = sourceFiles().filter((file) =>
      readFileSync(path.join(ROOT, file), "utf8").includes(
        'className="brain-mail-list"',
      ),
    );
    expect(columns.length).toBeGreaterThan(0);
    for (const file of columns) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      expect(
        /className="brain-mail-list"\s*\n\s*data-chrome-rows="[12]"/.test(text),
        `${file} renders .brain-mail-list without data-chrome-rows`,
      ).toBe(true);
    }
  });

  it("keeps the tab bar's slot and its derivation on the same number", () => {
    // The slot is 56 because the widest label is 37.6 and §4's air either
    // side of it is 9.2. That derivation is written twice in prose (in
    // DESIGN.md §4 and in the block comment over `.brain-mobile-tabbar`) and
    // once as a value, and a review found the prose stating a figure the CSS
    // does not produce. The arithmetic is not checkable from a file, but the
    // numbers it runs on are: the slot, the track count, the track floor, the
    // height the two objects share, and the widths those make. Five tracks
    // since New left the bar for its own circle at the other inset, and five
    // is now the rule's default rather than a literal in it: the module
    // switches take a slot out, so the count travels as `--tabbar-slots`
    // written per render by `components/mobile-tab-bar.tsx`. Every figure
    // below is the five-slot bar, which is what an installation with both
    // modules on draws and what both prose copies describe.
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    const design = readFileSync(path.join(ROOT, "DESIGN.md"), "utf8");

    const slot = /--tabbar-slot:\s*(\d+)px;/.exec(css)?.[1];
    expect(slot, "--tabbar-slot is missing from globals.css").toBeDefined();

    const slots = /--tabbar-slots:\s*(\d+);/.exec(css)?.[1];
    expect(slots, "--tabbar-slots is missing from globals.css").toBe("5");

    const floor =
      /repeat\(var\(--tabbar-slots\), minmax\((\d+)px, var\(--tabbar-slot\)\)\)/.exec(
        css,
      )?.[1];
    expect(floor, "the tab bar grid is not minmax(<floor>, --tabbar-slot)").toBeDefined();

    // both objects stand 54 tall and the plus is that square
    const height = /--tabbar-h:\s*(\d+)px;/.exec(css)?.[1];
    expect(height, "--tabbar-h is missing from globals.css").toBeDefined();

    // five slots plus the row's 4px ends: the number both prose copies quote
    const width = Number(slot) * 5 + 8;
    expect(
      design.includes(`Five of them plus the ends is ${width}`),
      `DESIGN.md §4 does not derive ${width} from a slot of ${slot}`,
    ).toBe(true);
    expect(
      css.includes(`Five of them plus the row's 4px ends is ${width}`),
      `the .brain-mobile-tabbar comment does not derive ${width} from a slot of ${slot}`,
    ).toBe(true);

    // the width where the bar is at its 288 and the air is down to the inset:
    // w - 8 - 8 - 8 - 54 = width, so the slots start giving one pixel below it
    const holdWidth = width + 8 * 3 + Number(height);
    expect(
      design.includes(`holds ${width} down to ${holdWidth}`),
      `DESIGN.md §4 does not hold ${width} down to ${holdWidth}`,
    ).toBe(true);
    expect(
      css.includes(`holds ${width} down to ${holdWidth}`),
      `the .brain-mobile-tabbar comment does not hold ${width} down to ${holdWidth}`,
    ).toBe(true);

    // and the width where those tracks reach the floor: the bar is five
    // floors plus the ends, and the three insets and the plus are beside it
    const floorWidth = Number(floor) * 5 + 8 + 8 * 3 + Number(height);
    expect(
      design.includes(`reach their floor at ${floorWidth}`),
      `DESIGN.md §4 does not put the ${floor}px track floor at ${floorWidth}`,
    ).toBe(true);
    expect(
      css.includes(`reach their floor at ${floorWidth}`),
      `the .brain-mobile-tabbar comment does not put the ${floor}px track floor at ${floorWidth}`,
    ).toBe(true);
  });

  it("inventories z-index literals outside the --z-* scale", () => {
    // Report-only until phase T1 moves every literal onto the scale: the
    // `--z-drawer` / `--z-modal` / `--z-toast` vars, used directly or inside
    // `calc()`. (Not spelled out as a class here on purpose — Tailwind scans
    // this file too and would compile a wildcard candidate into broken CSS.)
    // TODO(glass T1): flip this to a hard failure once the list is empty.
    const tailwindLiteral = /(?:^|[^\w-])(?:-?z-(?:\d+|\[(?!var\(|calc\(var\()[^\]]+\]))(?![\w-])/g;
    const cssLiteral = /z-index\s*:\s*-?\d+/g;

    const inventory: string[] = [];
    for (const file of sourceFiles()) {
      const pattern = file.endsWith(".css") ? cssLiteral : tailwindLiteral;
      lines(file).forEach((line, index) => {
        const hits = line.match(pattern);
        if (!hits) return;
        inventory.push(`${file}:${index + 1} ${hits.map((h) => h.trim()).join(" ")}`);
      });
    }

    // `process.stdout` rather than `console.log`: the default reporter hides
    // console output of passing tests, this list must land in the CI log.
    process.stdout.write(
      `[design-guardrails] z-index literals outside the --z-* scale: ${inventory.length}\n` +
        inventory.map((entry) => `  ${entry}\n`).join(""),
    );
    expect(Array.isArray(inventory)).toBe(true);
  });
});
