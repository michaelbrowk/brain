// Gate artifacts for the Liquid Glass dev stand (Phase 1; the Phase 0 set in
// docs/design/phase0 is frozen).
// Usage: BRAIN_E2E_PORT=3031 node scripts/e2e-dev.mjs   (in one terminal)
//        node scripts/glass-stand-shots.mjs [--webkit]    (in another)
// Writes docs/design/phase1/*.png (lossless, git-ignored), the same frames as
// *.webp (the review copies), docs/design/phase1-contrast.md (the
// runtime contrast table) and docs/design/phase1-hover.md (ΔL rest → hover
// measured from pixels of the §9 components grid).
//
// The directory it writes into is on the publication denylist
// (scripts/publication-denylist.mjs), so this repository carries none of
// these frames. Shoot them, read them, throw them away — but do not commit
// them here: the forbidden-path step of `pnpm check` refuses a tracked path
// the list names.

import { chromium, webkit } from "playwright";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const port = process.env.BRAIN_E2E_PORT ?? "3031";
const origin = `http://127.0.0.1:${port}`;
const outDir = fileURLToPath(new URL("../docs/design/phase1/", import.meta.url));
const out = (f) => `${outDir}${f}`;
mkdirSync(outDir, { recursive: true });
const want = new Set(process.argv.slice(2));
const engines = [["chromium", chromium], ...(want.has("--webkit") ? [["webkit", webkit]] : [])];

const contrast = {};
const hover = {};
let session = null;

/** oklch lightness of an sRGB pixel */
function lightness([r, g, b]) {
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** Mean colour of a 3×3 patch near the left edge of an element's fill (x 4,
 *  vertical centre — inside every capsule, outside every glyph). */
async function sampleFill(locator) {
  const png = await locator.screenshot({ type: "png" });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const cy = Math.floor(info.height / 2);
  const acc = [0, 0, 0];
  let n = 0;
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = 3; x <= 5; x++) {
      const i = (y * info.width + x) * info.channels;
      acc[0] += data[i];
      acc[1] += data[i + 1];
      acc[2] += data[i + 2];
      n++;
    }
  }
  return acc.map((c) => c / n);
}

/** ΔL rest → hover for every [data-measure] pair on the §9 grid. */
async function measureHover(page) {
  const keys = await page.$$eval("[data-state-cell='rest'] [data-measure]", (els) =>
    els.map((el) => el.getAttribute("data-measure")),
  );
  const rows = [];
  for (const key of keys) {
    const rest = page.locator(`[data-state-cell='rest'] [data-measure='${key}']`).first();
    const hov = page.locator(`[data-state-cell='hover'] [data-measure='${key}']`).first();
    // the breadcrumb's hover lives on its parent segment
    const pick = (loc) => (key === "crumb" ? loc.locator(".crumb-seg").first() : loc);
    const a = await sampleFill(pick(rest));
    const b = await sampleFill(pick(hov));
    const la = lightness(a);
    const lb = lightness(b);
    rows.push({ key, rest: la, hover: lb, delta: Math.abs(la - lb) });
  }
  // the static menu item: rest vs the [data-hover] sibling
  const item = page.locator("[data-measure-menu] [data-measure='menu-item']").first();
  const itemHover = page.locator("[data-measure-menu] .brain-menu-item[data-hover]").first();
  const la = lightness(await sampleFill(item));
  const lb = lightness(await sampleFill(itemHover));
  rows.push({ key: "menu-item", rest: la, hover: lb, delta: Math.abs(la - lb) });
  return rows;
}
for (const [name, engine] of engines) {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  if (session) {
    // The session cookie is `secure`; WebKit drops it over plain http on
    // 127.0.0.1, so reuse the cookie Chromium obtained with the flag cleared.
    await ctx.addCookies(session.map((c) => ({ ...c, secure: false })));
    await page.goto(`${origin}/dev/glass`); // localStorage needs an origin
  } else {
    await page.goto(`${origin}/login`);
    await page.getByPlaceholder("Password").fill("e2e-password");
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login")), page.getByRole("button", { name: "Sign in" }).click()]);
    session = await ctx.cookies();
  }

  const shoot = async (tag, before, after) => {
    await before?.();
    await page.goto(`${origin}/dev/glass`);
    await page.waitForSelector("[data-glass-stand]");
    await after?.();
    await page.waitForFunction(() => (window.__glassContrast?.length ?? 0) > 0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: out(`${name}-${tag}-fold.png`) });
    // scrolled composition frame (pills over content, no edge band) + the
    // sidebar tree fade (the §5 list demos open scrolled on their own)
    await page.evaluate(() => {
      document.querySelector("[data-composition-scroll]")?.scrollTo({ top: 420 });
      document.querySelector(".edge-fade")?.scrollTo({ top: 120 });
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`${name}-${tag}-scrolled.png`) });
    await page.screenshot({ path: out(`${name}-${tag}-full.png`), fullPage: true });
    // §9 components grid, five states each
    await page.addStyleTag({ content: "[data-glass-stand] > header { visibility: hidden }" });
    await page.locator("[data-stand-components]").screenshot({ path: out(`${name}-${tag}-components.png`) });
    contrast[`${name}-${tag}`] = await page.evaluate(() => window.__glassContrast);
    if (name === "chromium" && tag !== "reduced-motion") hover[`${name}-${tag}`] = await measureHover(page);
  };

  const setTheme = (t) => page.evaluate((t) => localStorage.setItem("theme", t), t);
  await setTheme("light");
  await shoot("light");
  await setTheme("dark");
  await shoot("dark");
  await setTheme("light");

  // reduced transparency: Chromium can emulate the media feature over CDP;
  // WebKit cannot, so there the same token remap is forced via the html
  // attribute the stand's Fallback toggle uses.
  if (name === "chromium") {
    const cdp = await ctx.newCDPSession(page);
    await shoot("reduced-transparency", () =>
      cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
      }),
    );
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  } else {
    await shoot("reduced-transparency", undefined, async () => {
      await page.evaluate(() => (document.documentElement.dataset.glassFallback = "matte"));
      await page.waitForTimeout(300);
    });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await shoot("reduced-motion", undefined, async () => {
    await page.evaluate(() => (document.documentElement.dataset.bg = "live"));
    await page.waitForTimeout(200);
  });
  await browser.close();
}

// review copies: fold + scrolled as webp (the lossless PNGs stay local)
for (const f of readdirSync(outDir)) {
  if (!f.endsWith(".png") || f.endsWith("-full.png")) continue;
  await sharp(out(f)).webp({ quality: 90 }).toFile(out(f.replace(/\.png$/, ".webp")));
}

// hover markdown: ΔL rest → hover from pixels
let hmd = `# Phase 1 — hover ΔL, measured

For every component on the §9 grid of /dev/glass the rest cell and the static
hover cell are screenshotted and a 3×3 patch at the left inside edge of the
fill (x 4, vertical centre — inside every capsule, outside every glyph) is
averaged and converted to oklch lightness. ΔL is the absolute difference.
The rule (DESIGN.md v2 → Hover) asks for ≥ 0.03; the values are what a
reader's eye gets, backdrop blur and sheen included. Light and dark share
the ink-tint mechanism (ink .07 / white .08 layered over the fill); the
matte fallback keeps it. The filled primary and the ink button shift their
fill by .08 instead.

Generated by scripts/glass-stand-shots.mjs.
`;
for (const [key, rows] of Object.entries(hover)) {
  hmd += `\n## ${key}\n\n| Component | L rest | L hover | ΔL | ≥ .03 |\n|---|---|---|---|---|\n`;
  for (const r of rows)
    hmd += `| ${r.key} | ${r.rest.toFixed(3)} | ${r.hover.toFixed(3)} | **${r.delta.toFixed(3)}** | ${r.delta >= 0.03 ? "pass" : "**FAIL**"} |\n`;
}
writeFileSync(fileURLToPath(new URL("../docs/design/phase1-hover.md", import.meta.url)), hmd);

// contrast markdown
let md = `# Phase 1 — contrast on materials

Computed at runtime on /dev/glass by the stand itself: each material's fill is
read from the rendered swatch, composited over the lightest (paper + sky tint)
and darkest (dark HTML-mail block) stand backdrops, the thick sheen is folded
in as +.10 white, then the WCAG 2.x ratio is taken against the rendered ink,
ink-2 and the blue token (link colour). Blur is mean-preserving and ignored;
saturate is ignored (it moves chroma, not luminance, on neutral backdrops).
Gate: ≥ 4.5 everywhere.

Reading the table: the "darkest" backdrop is foreign dark content under glass,
which DESIGN.md v2 forbids ("glass only over its own scroller"); ink-2 and
blue on glass over it cannot pass at any fill below ~.85, so those rows
measure the rule's necessity, not a token bug. ink passes everywhere. In dark,
ink-2 was raised from oklch .72 to .75 to clear the thick material over the
lightest dark backdrop (4.12 → 4.63).

blue is measured even though the adopted text-on-glass rule (DESIGN.md v2 →
Materials) keeps links on paper: toolbar pills and the breadcrumb carry ink at
weight ≥ 500 only. The blue rows show what a link on glass would cost: in
light it fails only over the darkest backdrop (2.35 thick), in dark it fails
on thick glass over the stand's own lightest backdrop (3.60) and on thin
(4.46) — so the rule holds without any cover in the picture.

The two accent rows measure the primary button: its paper glyph on the ink
fill at rest and on the hover fill (lightness ±.08). Opaque, so the fill is
the backdrop. The ratio is symmetric, so the dark run's rows are the inverted
pair (paper-ish fill, ink glyph) — both trivially AA, listed so the gate
reads the whole chrome from one table.

The Phase 1 rows (chip, chip hover, selected, selected hover, item hover)
composite the fills of the components onto the thick material over both
backdrops — white .50, white .78, and the ink-tint hover .07 layered over
each — and measure ink on top (text on a fill is 600, full ink).

WebKit rows repeat Chromium's numbers because the composite is arithmetic on
computed colours; note that Playwright's WebKit does not render
backdrop-filter in screenshots at all (pills and edges show as flat fills),
so material parity with Safari must be checked in Safari itself.

Generated by scripts/glass-stand-shots.mjs.
`;
for (const [key, rows] of Object.entries(contrast)) {
  if (!rows) continue;
  const worst = rows.reduce((a, r) => (r.ratio < a.ratio ? r : a), rows[0]);
  md += `\n## ${key}\n\nWorst: ${worst.material} / ${worst.backdrop} / ${worst.text} = **${worst.ratio}** (${worst.pass ? "pass" : "FAIL"})\n\n| Material | Backdrop | Text | Composite | Ratio | AA |\n|---|---|---|---|---|---|\n`;
  for (const r of rows) md += `| ${r.material} | ${r.backdrop} ${r.backdropColor} | ${r.text} | ${r.composite} | ${r.ratio.toFixed(2)} | ${r.pass ? "pass" : "**FAIL**"} |\n`;
}
writeFileSync(fileURLToPath(new URL("../docs/design/phase1-contrast.md", import.meta.url)), md);
console.log("wrote", Object.keys(contrast).join(", "));
