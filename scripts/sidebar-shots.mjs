// Gate artifacts for the sidebar's primary rows. Run once on the tree before
// the change and once after, then compare the pairs:
//
//   BRAIN_E2E_PORT=3145 BRAIN_DIST_DIR=.next/e2esb node scripts/e2e-dev.mjs
//   node scripts/sidebar-shots.mjs before      (in another terminal)
//   node scripts/sidebar-shots.mjs after
//
// Writes docs/design/sidebar/nav-<scheme>-<stage>.png. The frame is the block
// from the search capsule through the last primary row — the rows are the
// subject, so the clip stops before the tree rather than shooting the panel.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const stage = process.argv[2];
if (stage !== "before" && stage !== "after") {
  console.error("usage: node scripts/sidebar-shots.mjs <before|after>");
  process.exit(1);
}

const port = process.env.BRAIN_E2E_PORT ?? "3145";
const origin = `http://127.0.0.1:${port}`;
const outDir = fileURLToPath(new URL("../docs/design/sidebar/", import.meta.url));
mkdirSync(outDir, { recursive: true });

const ZOOM = 2;
const PAD = 8;

async function login(page) {
  await page.goto(`${origin}/login`);
  await page.getByPlaceholder("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${origin}/`, { timeout: 30_000 });
}

async function setTheme(page, dark) {
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  await page.waitForTimeout(200);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
await login(page);

for (const scheme of ["light", "dark"]) {
  await setTheme(page, scheme === "dark");
  const search = page.locator(".brain-sidebar-search");
  // the last primary row above the tree; Mail is the row both trees share
  const mail = page
    .locator(".brain-sidebar button.tree-row")
    .filter({ hasText: "Mail" })
    .first();
  await search.waitFor();
  await mail.waitFor();
  const top = await search.boundingBox();
  const bottom = await mail.boundingBox();
  if (!top || !bottom) throw new Error("no sidebar nav box");

  const png = await page.screenshot({
    clip: {
      x: Math.max(0, top.x - PAD),
      y: Math.max(0, top.y - PAD),
      width: top.width + PAD * 2,
      height: bottom.y + bottom.height - top.y + PAD * 2,
    },
  });
  const meta = await sharp(png).metadata();
  await sharp(png)
    .resize(meta.width * ZOOM, meta.height * ZOOM, { kernel: "nearest" })
    .toFile(`${outDir}nav-${scheme}-${stage}.png`);
  console.log(`  nav-${scheme}-${stage}.png`);
}

await browser.close();
