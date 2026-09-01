// Gate artifacts for the shell-polish sweep (the review week's shell and
// dialog findings). Run once on the tree before the change and once after,
// then compare the pairs:
//
//   BRAIN_E2E_PORT=3178 BRAIN_DIST_DIR=.next-fix-shell node scripts/e2e-dev.mjs
//   node scripts/shell-shots.mjs before      (in another terminal)
//   node scripts/shell-shots.mjs after
//
// Writes docs/design/shell/<surface>-<scheme>-<stage>.png and prints the
// numbers each frame is judged by (row radius, heading case, the toast's
// centre against the canvas centre, the foot buttons' hover ΔL, the hub's
// active element on a touch device). The frames are the record; the numbers
// are in the PR.
//
//   --only=palette,dialogs,toast,foot,hub   narrows a re-run
//
// docs/design/shell/ travels, but twelve of its frames do not: the Move
// dialog and both palette states render the whole page list, so
// scripts/publication-denylist.mjs names them. Re-shooting rewrites those
// twelve. Leave them uncommitted, or the forbidden-path step of `pnpm check`
// refuses them.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const stage = process.argv[2];
if (stage !== "before" && stage !== "after") {
  console.error("usage: node scripts/shell-shots.mjs <before|after> [--only=a,b]");
  process.exit(1);
}
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = new Set(onlyArg ? onlyArg.slice("--only=".length).split(",") : []);
const wants = (pass) => only.size === 0 || only.has(pass);

const port = process.env.BRAIN_E2E_PORT ?? "3178";
const origin = `http://127.0.0.1:${port}`;
const outDir = fileURLToPath(new URL("../docs/design/shell/", import.meta.url));
mkdirSync(outDir, { recursive: true });

const PAD = 10;
const report = {};
const note = (key, value) => {
  report[key] = value;
  console.log(`  ${key}: ${JSON.stringify(value)}`);
};

const HIDE_DEV_BADGE = () => {
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = "nextjs-portal { display: none !important }";
    document.head.appendChild(style);
  });
};

async function login(page) {
  await page.goto(`${origin}/login`);
  await page.getByPlaceholder("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${origin}/`, { timeout: 30_000 });
}

async function api(page, requestPath, init = {}) {
  return page.evaluate(
    async ({ url, request }) => {
      const response = await fetch(url, {
        method: request.method,
        headers: request.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return { status: response.status, text };
      }
    },
    { url: `${origin}${requestPath}`, request: init },
  );
}

async function makePage(page, fields) {
  const created = await api(page, "/api/page", { method: "POST", body: fields });
  return created.id;
}

async function putMarkdown(page, id, markdown) {
  const current = await api(page, `/api/page/${id}`);
  return api(page, `/api/page/${id}`, { method: "PUT", body: { rev: current.rev, markdown } });
}

/** The fixtures every pass reads: a tree with page emoji (the Move dialog's
 *  rows), a page with three saved versions (History), a few pages so the
 *  palette has something to list. Seeded once per notes root by title. */
async function seed(page) {
  const tree = await api(page, "/api/tree");
  const flat = [];
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      flat.push(node);
      walk(node.children);
    }
  };
  walk(tree.tree ?? tree);
  const byTitle = (title) => flat.find((node) => node.title === title)?.id;
  let parent = byTitle("Field Guide");
  if (!parent) {
    parent = await makePage(page, { title: "Field Guide", icon: "🌿" });
    await makePage(page, { parentId: parent, title: "Archive", icon: "🗄️" });
    await makePage(page, { parentId: parent, title: "Compost Rotation", icon: "🪱" });
    await makePage(page, { parentId: parent, title: "Tomato Trial Rows", icon: "🍅" });
  }
  if (!byTitle("Paper and chrome — notes on the edge")) {
    await makePage(page, {
      title: "Paper and chrome — notes on the edge",
      icon: "📄",
      markdown: "## What the edge decides\n\nA paragraph about the paper and the chrome over it.",
    });
  }
  let spanish = byTitle("Spanish");
  if (!spanish) {
    spanish = await makePage(page, { title: "Spanish", icon: "🇪🇸", markdown: "First version." });
    await putMarkdown(page, spanish, "First version.\n\nSecond paragraph, second save.");
    await putMarkdown(page, spanish, "First version.\n\nSecond paragraph, second save.\n\nThird save.");
  }
  for (const [title, icon] of [
    ["Verbs", "📝"],
    ["Nouns", "📚"],
    ["Weekly review", "🗓️"],
  ]) {
    if (!byTitle(title)) await makePage(page, { title, icon, markdown: `# ${title}\n\nA paragraph.` });
  }
  return { spanish, parent };
}

async function clipShot(page, box, name, scheme, zoom = 1) {
  const png = await page.screenshot({
    clip: {
      x: Math.max(0, box.x - PAD),
      y: Math.max(0, box.y - PAD),
      width: box.width + PAD * 2,
      height: box.height + PAD * 2,
    },
  });
  const file = `${outDir}${name}-${scheme}-${stage}.png`;
  if (zoom > 1) {
    const meta = await sharp(png).metadata();
    await sharp(png)
      .resize(meta.width * zoom, meta.height * zoom, { kernel: "nearest" })
      .toFile(file);
  } else {
    await sharp(png).toFile(file);
  }
  console.log(`  ${name}-${scheme}-${stage}.png`);
}

async function fullShot(page, name, scheme) {
  await page.screenshot({ path: `${outDir}${name}-${scheme}-${stage}.png` });
  console.log(`  ${name}-${scheme}-${stage}.png`);
}

/** Mean L* over a clip, from pixels — the hover-visibility number of §8. */
async function meanL(page, clip) {
  const buf = await page.screenshot({ clip });
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let sum = 0;
  const n = info.width * info.height;
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  for (let i = 0; i < n; i += 1) {
    const r = data[i * channels] / 255;
    const g = data[i * channels + 1] / 255;
    const b = data[i * channels + 2] / 255;
    const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    sum += Y <= 0.008856 ? 903.3 * Y : 116 * Math.cbrt(Y) - 16;
  }
  return sum / n / 100;
}

async function hoverDelta(page, locator, inset = 4) {
  const box = await locator.boundingBox();
  const clip = {
    x: box.x + inset,
    y: box.y + inset,
    width: Math.max(4, box.width - inset * 2),
    height: Math.max(4, box.height - inset * 2),
  };
  const styles = () =>
    locator.evaluate((el) => {
      const svg = el.querySelector("svg");
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        color: cs.color,
        svg: svg ? getComputedStyle(svg).color : null,
        radius: cs.borderRadius,
      };
    });
  await page.mouse.move(4, 880);
  await page.waitForTimeout(350);
  const rest = await meanL(page, clip);
  const restStyles = await styles();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(350);
  const hover = await meanL(page, clip);
  const hoverStyles = await styles();
  return {
    dL: +(hover - rest).toFixed(3),
    rest: { L: +rest.toFixed(3), ...restStyles },
    hover: { L: +hover.toFixed(3), ...hoverStyles },
    box,
  };
}

const probe = (page, selector, limit = 4) =>
  page.evaluate(
    ({ selector, limit }) =>
      [...document.querySelectorAll(selector)].slice(0, limit).map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          x: +r.x.toFixed(1),
          y: +r.y.toFixed(1),
          w: +r.width.toFixed(1),
          h: +r.height.toFixed(1),
          font: `${cs.fontSize}/${cs.fontWeight}`,
          transform: cs.textTransform,
          color: cs.color,
          bg: cs.backgroundColor,
          radius: cs.borderRadius,
          text: (el.textContent || "").trim().slice(0, 32),
        };
      }),
    { selector, limit },
  );

/** Distance from a row's emoji glyph to the title beside it. */
const emojiGap = (page, rowSelector) =>
  page.evaluate((selector) => {
    const rows = [...document.querySelectorAll(selector)];
    for (const row of rows) {
      const spans = [...row.querySelectorAll("span")];
      const glyph = spans.find((s) => /\p{Extended_Pictographic}/u.test(s.textContent ?? "") && (s.textContent ?? "").trim().length <= 3);
      if (!glyph) continue;
      const title = spans.find((s) => s !== glyph && !glyph.contains(s) && (s.textContent ?? "").trim().length > 3);
      if (!title) continue;
      const g = glyph.getBoundingClientRect();
      const t = title.getBoundingClientRect();
      // the visible emoji sits inside its box; measure from the glyph box and
      // from the drawn character (a range around the text node)
      const range = document.createRange();
      range.selectNodeContents(glyph);
      const drawn = range.getBoundingClientRect();
      return {
        row: (row.textContent ?? "").trim().slice(0, 24),
        boxGap: +(t.left - g.right).toFixed(1),
        drawnGap: +(t.left - drawn.right).toFixed(1),
      };
    }
    return null;
  }, rowSelector);

const browser = await chromium.launch();

async function context(opts) {
  const ctx = await browser.newContext({
    deviceScaleFactor: 2,
    ...opts,
  });
  await ctx.addInitScript(HIDE_DEV_BADGE);
  const page = await ctx.newPage();
  await login(page);
  return { ctx, page };
}

let fixtures = null;
{
  const { ctx, page } = await context({ viewport: { width: 1440, height: 900 } });
  fixtures = await seed(page);
  await ctx.close();
}

for (const scheme of ["light", "dark"]) {
  console.log(`— ${scheme}`);

  // 1. The mobile palette: empty, and with a query.
  if (wants("palette")) {
    const { ctx, page } = await context({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme: scheme,
    });
    await page.goto(`${origin}/p/${fixtures.spanish}`);
    await page.waitForSelector(".ProseMirror");
    await page.waitForTimeout(800);
    const tab = page.locator("nav.brain-mobile-tabbar").getByRole("button", { name: "Search", exact: true });
    await tab.click();
    const view = page.getByTestId("mobile-search-view");
    await view.waitFor();
    await page.waitForTimeout(600);
    await fullShot(page, "palette-mobile-empty", scheme);
    note(`palette.${scheme}.heading`, await probe(page, "[cmdk-group-heading]", 2));
    note(`palette.${scheme}.item`, await probe(page, "[cmdk-item]", 2));
    note(`palette.${scheme}.selected`, await probe(page, "[cmdk-item][data-selected=true]", 1));
    note(`palette.${scheme}.back`, await probe(page, '[data-testid="mobile-search-view"] header button', 1));
    note(
      `palette.${scheme}.materials`,
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="mobile-search-view"] *, [data-testid="mobile-search-view"]')]
          .filter((el) => {
            const b = getComputedStyle(el).backdropFilter;
            return b && b !== "none";
          })
          .map((el) => el.className.toString().slice(0, 40)),
      ),
    );
    const input = page.locator('input[aria-label="Search pages and text"]');
    await input.fill("Field");
    await page.waitForTimeout(500);
    await fullShot(page, "palette-mobile-query", scheme);
    note(`palette.${scheme}.querySelected`, await probe(page, "[cmdk-item][data-selected=true]", 1));
    await ctx.close();
  }

  // 2. Move and History on the desktop.
  if (wants("dialogs")) {
    const { ctx, page } = await context({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await page.goto(`${origin}/p/${fixtures.spanish}`);
    await page.waitForSelector(".ProseMirror");
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    const move = page.getByRole("dialog", { name: "Move page" });
    await move.waitFor();
    const expand = move.getByRole("button", { name: "Expand Field Guide" });
    if (await expand.count()) await expand.click();
    await page.mouse.move(1400, 880);
    await page.waitForTimeout(500);
    await clipShot(page, await move.boundingBox(), "dialog-move", scheme);
    note(`move.${scheme}.topLevel`, await probe(page, '[role="dialog"] button[aria-pressed]', 1));
    note(`move.${scheme}.rows`, await probe(page, '[role="dialog"] [role="treeitem"]', 2));
    note(`move.${scheme}.emojiGap`, await emojiGap(page, '[role="dialog"] [role="treeitem"]'));
    note(`move.${scheme}.field`, await probe(page, '[role="dialog"] label, [role="dialog"] .field', 1));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: /history/i }).click();
    const history = page.getByRole("dialog");
    await history.waitFor();
    await history.getByRole("button", { name: /Current/ }).waitFor({ timeout: 10_000 });
    await page.mouse.move(1400, 880);
    await page.waitForTimeout(600);
    await clipShot(page, await history.boundingBox(), "dialog-history", scheme);
    note(`history.${scheme}.label`, await probe(page, '[role="dialog"] nav p', 1));
    note(`history.${scheme}.rows`, await probe(page, '[role="dialog"] nav button', 2));
    await page.keyboard.press("Escape");
    await ctx.close();
  }

  // 3. The toast against the canvas at 768 and 1440.
  if (wants("toast")) {
    for (const [w, h] of [
      [768, 1024],
      [1440, 900],
    ]) {
      const { ctx, page } = await context({ viewport: { width: w, height: h }, colorScheme: scheme });
      const victim = await makePage(page, { title: `Victim ${w} ${scheme}`, icon: "🎯", markdown: "bye" });
      await page.goto(`${origin}/p/${victim}`);
      await page.waitForSelector(".ProseMirror");
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: "Page actions" }).click();
      await page.getByRole("menuitem", { name: /trash/i }).click();
      const toast = page.locator(".brain-toast").first();
      await toast.waitFor({ timeout: 5000 });
      await page.mouse.move(w - 10, 10);
      await page.waitForTimeout(500);
      const geo = await page.evaluate(() => {
        const rect = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: +r.x.toFixed(1), w: +r.width.toFixed(1), right: +(r.x + r.width).toFixed(1) };
        };
        const main = document.querySelector(".brain-main");
        const padLeft = main ? parseFloat(getComputedStyle(main).paddingLeft) : 0;
        const m = rect(".brain-main");
        const t = rect(".brain-toast");
        const s = rect(".brain-sidebar");
        const canvas = m ? { x: m.x + padLeft, w: m.w - padLeft } : null;
        const centre = (r) => (r ? +(r.x + r.w / 2).toFixed(1) : null);
        const overlap = s && t ? Math.max(0, Math.min(s.right, t.right) - Math.max(s.x, t.x)) : 0;
        return {
          toast: t,
          sidebar: s,
          canvas,
          toastCentre: centre(t),
          canvasCentre: centre(canvas),
          windowCentre: window.innerWidth / 2,
          offsetFromCanvasCentre: t && canvas ? +(centre(t) - centre(canvas)).toFixed(1) : null,
          sidebarOverlap: +overlap.toFixed(1),
          stackLeft: getComputedStyle(document.querySelector(".brain-toast-stack")).left,
        };
      });
      note(`toast.${w}.${scheme}`, geo);
      const band = { x: 0, y: h - 120, width: w, height: 120 };
      const png = await page.screenshot({ clip: band });
      await sharp(png).toFile(`${outDir}toast-${w}-${scheme}-${stage}.png`);
      console.log(`  toast-${w}-${scheme}-${stage}.png`);
      const undo = toast.getByRole("button", { name: /Undo/ });
      if (await undo.count()) await undo.click();
      await page.waitForTimeout(400);
      await ctx.close();
    }
  }

  // 4. The sidebar foot: Trash and the theme toggle under the pointer.
  if (wants("foot")) {
    const { ctx, page } = await context({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await page.goto(`${origin}/p/${fixtures.spanish}`);
    await page.waitForSelector(".ProseMirror");
    await page.waitForTimeout(800);
    const trash = page.getByRole("button", { name: "Trash" }).first();
    const theme = page.getByRole("button", { name: "Toggle theme" }).first();
    const settings = page.locator(".brain-sidebar-foot").getByText("Settings").first().locator("xpath=ancestor::*[self::a or self::button][1]");
    const trashDelta = await hoverDelta(page, trash);
    note(`foot.${scheme}.trash`, { dL: trashDelta.dL, rest: trashDelta.rest, hover: trashDelta.hover });
    await clipShot(page, trashDelta.box, "foot-trash-hover", scheme, 3);
    const themeDelta = await hoverDelta(page, theme);
    note(`foot.${scheme}.theme`, { dL: themeDelta.dL, rest: themeDelta.rest, hover: themeDelta.hover });
    await clipShot(page, themeDelta.box, "foot-theme-hover", scheme, 3);
    const settingsDelta = await hoverDelta(page, settings, 6);
    note(`foot.${scheme}.settingsReference`, { dL: settingsDelta.dL });
    await ctx.close();
  }

  // 5. The hub on a touch device at a desktop width: nothing may hold focus.
  if (wants("hub")) {
    for (const [w, h] of [
      [1024, 768],
      [844, 390],
    ]) {
      const { ctx, page } = await context({
        viewport: { width: w, height: h },
        isMobile: true,
        hasTouch: true,
        colorScheme: scheme,
      });
      await page.goto(`${origin}/`);
      await page.waitForTimeout(1200);
      const active = await page.evaluate(() => {
        const a = document.activeElement;
        return {
          active: a ? `${a.tagName}${a.getAttribute("placeholder") ? ` ph=${a.getAttribute("placeholder")}` : ""}` : null,
          hoverNone: matchMedia("(hover: none)").matches,
          coarse: matchMedia("(pointer: coarse)").matches,
        };
      });
      note(`hub.${w}x${h}.${scheme}.touch`, active);
      if (w === 1024) {
        const field = page.locator('input[aria-label="New thought"]');
        const box = await field.locator("xpath=ancestor::*[contains(@class,'field') or self::form][1]").boundingBox().catch(() => null);
        await clipShot(page, box ?? (await field.boundingBox()), "hub-touch-1024", scheme);
      }
      await ctx.close();
    }
    const { ctx, page } = await context({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await page.goto(`${origin}/`);
    await page.waitForTimeout(1200);
    note(
      `hub.1440.${scheme}.pointer`,
      await page.evaluate(() => {
        const a = document.activeElement;
        return a ? `${a.tagName}${a.getAttribute("placeholder") ? ` ph=${a.getAttribute("placeholder")}` : ""}` : null;
      }),
    );
    await ctx.close();
  }
}

await browser.close();
console.log(`\ndocs/design/shell — ${stage} frames written`);
console.log(JSON.stringify(report));
