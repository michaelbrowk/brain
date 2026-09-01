// Owner-gate artifacts for the glass share popover (plan row P3-c).
// Usage: BRAIN_E2E_PORT=3035 BRAIN_DIST_DIR=.next/e2esh node scripts/e2e-dev.mjs   (terminal 1)
//        BRAIN_E2E_PORT=3035 node scripts/share-shots.mjs                           (terminal 2)
// Writes docs/design/share/*.png (committed review copies): the desktop
// popover in the not-shared review and the shared-with-password management
// states, light and dark, plus the mobile sheet.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const port = process.env.BRAIN_E2E_PORT ?? "3035";
const origin = `http://127.0.0.1:${port}`;
const outDir = fileURLToPath(new URL("../docs/design/share/", import.meta.url));
mkdirSync(outDir, { recursive: true });

async function login(page) {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.head.appendChild(style);
    });
  });
  await page.goto(`${origin}/login`);
  await page.getByPlaceholder("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${origin}/`);
}

async function api(page, path, body, method) {
  return page.evaluate(
    async ({ path, body, method }) => {
      const r = await fetch(path, {
        method: method ?? (body ? "POST" : "GET"),
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
    },
    { path, body, method },
  );
}

async function setTheme(page, dark) {
  await page.evaluate((dark) => {
    localStorage.setItem("theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, dark);
  await page.waitForTimeout(250);
}

async function save(page, name) {
  const png = await page.screenshot({ type: "png", fullPage: false });
  writeFileSync(`${outDir}${name}.png`, png);
  console.log(`  ${name}`);
}

async function seed(page) {
  // idempotent: a re-run reuses the pages a previous run created
  const treeResponse = await api(page, "/api/tree");
  const flat = [];
  const walk = (nodes) => (nodes ?? []).forEach((n) => {
    flat.push(n);
    walk(n.children);
  });
  walk(treeResponse.body?.tree ?? treeResponse.body ?? []);
  const existing = flat.find((n) => n.title === "Share popover shots")?.id;
  if (existing) return existing;
  const parent = await api(page, "/api/page", {
    title: "Share popover shots",
    markdown:
      "The paper is the window, the chrome floats over it. This page exists so the share popover has honest content to refract.\n\n## A section\n\nGlass answers one question — what is above what — and nothing else.",
    icon: "🔗",
  });
  const parentId = parent.body?.id;
  for (const title of ["Nested one", "Nested two"]) {
    await api(page, "/api/page", { title, markdown: `${title}.`, parentId });
  }
  return parentId;
}

async function openDesktopPopover(page) {
  await page.locator('button[aria-label="Share"]:visible').click();
  const surface = page.locator("[data-share-surface]");
  await surface.waitFor({ state: "visible" });
  await surface.evaluate((node) =>
    Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))),
  );
  await page.waitForTimeout(300);
  return surface;
}

const browser = await chromium.launch();

// desktop: not-shared review, then shared + password management
const desktop = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const desktopPage = await desktop.newPage();
await login(desktopPage);
const pageId = await seed(desktopPage);

await desktopPage.goto(`${origin}/p/${pageId}`);
await desktopPage.waitForTimeout(900);
for (const dark of [false, true]) {
  await setTheme(desktopPage, dark);
  await openDesktopPopover(desktopPage);
  await save(desktopPage, `desktop-review-${dark ? "dark" : "light"}`);
  await desktopPage.keyboard.press("Escape");
  await desktopPage.waitForTimeout(300);
}

// enable the share with a password through the same API the UI calls
const disclosure = await api(desktopPage, `/api/page/${pageId}/share`);
const enabled = await api(desktopPage, `/api/page/${pageId}/share`, {
  enabled: true,
  expectedScopeToken: disclosure.body?.scopeToken,
  password: "orchid-paper-14",
  expiresAt: null,
});
if (!enabled.ok) throw new Error(`share enable failed: ${enabled.status}`);
await desktopPage.goto(`${origin}/p/${pageId}`);
await desktopPage.waitForTimeout(900);
for (const dark of [false, true]) {
  await setTheme(desktopPage, dark);
  await openDesktopPopover(desktopPage);
  await save(desktopPage, `desktop-shared-password-${dark ? "dark" : "light"}`);
  await desktopPage.keyboard.press("Escape");
  await desktopPage.waitForTimeout(300);
}
await desktop.close();

// mobile: the thick-material bottom sheet over the same shared page
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const mobilePage = await mobile.newPage();
await login(mobilePage);
await mobilePage.goto(`${origin}/p/${pageId}`);
await mobilePage.waitForTimeout(900);
for (const dark of [false, true]) {
  await setTheme(mobilePage, dark);
  await mobilePage.locator('[data-share-mobile-trigger][aria-label="Share"]').first().click();
  const sheet = mobilePage.locator("[data-share-mobile-surface]");
  await sheet.waitFor({ state: "visible" });
  await sheet.evaluate((node) =>
    Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))),
  );
  await mobilePage.waitForTimeout(300);
  await save(mobilePage, `mobile-sheet-${dark ? "dark" : "light"}`);
  await mobilePage.keyboard.press("Escape");
  await mobilePage.waitForTimeout(300);
}
await mobile.close();

await browser.close();
console.log(`done → ${outDir}`);
