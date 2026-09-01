// Gate artifacts for the bare-glyph sweep (DESIGN.md §10 ban 13). Run once on
// the tree before the change and once after, then compare the pairs:
//
//   BRAIN_E2E_PORT=3069 BRAIN_DIST_DIR=.next/e2ebg2 node scripts/e2e-dev.mjs
//   node scripts/glyph-shots.mjs before      (in another terminal)
//   node scripts/glyph-shots.mjs after
//
// Writes docs/design/glyphs/<surface>-<scheme>-<stage>.png. Every frame is a
// clip around the control, upscaled with nearest-neighbour: the change is 10px
// of ink and a 1x frame cannot show it.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const stage = process.argv[2];
// `--desktop` / `--phone` narrow a re-run to one pass; default runs both.
const only = ["desktop", "phone", "mail"].filter((pass) => process.argv.includes(`--${pass}`));
const passes = only.length > 0 ? only : ["desktop", "phone", "mail"];
if (stage !== "before" && stage !== "after") {
  console.error("usage: node scripts/glyph-shots.mjs <before|after>");
  process.exit(1);
}

const port = process.env.BRAIN_E2E_PORT ?? "3069";
const origin = `http://127.0.0.1:${port}`;
const outDir = fileURLToPath(new URL("../docs/design/glyphs/", import.meta.url));
mkdirSync(outDir, { recursive: true });

const ZOOM = 3;
const PAD = 10;

async function shot(page, locator, name, scheme) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${name}`);
  const png = await page.screenshot({
    clip: {
      x: Math.max(0, box.x - PAD),
      y: Math.max(0, box.y - PAD),
      width: box.width + PAD * 2,
      height: box.height + PAD * 2,
    },
  });
  const meta = await sharp(png).metadata();
  await sharp(png)
    .resize(meta.width * ZOOM, meta.height * ZOOM, { kernel: "nearest" })
    .toFile(`${outDir}${name}-${scheme}-${stage}.png`);
  console.log(`  ${name}-${scheme}-${stage}.png`);
}

async function login(page) {
  await page.goto(`${origin}/login`);
  await page.getByPlaceholder("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${origin}/`, { timeout: 30_000 });
}

const browser = await chromium.launch();

for (const scheme of passes.includes("desktop") ? ["light", "dark"] : []) {
  console.log(`— ${scheme}`);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important }";
      document.head.appendChild(style);
    });
  });
  await login(page);

  // 1 — the sidebar's accent create button, the control the rule came from
  const create = page.getByRole("button", { name: "New page", exact: true }).first();
  await create.waitFor();
  await page.waitForTimeout(600);
  await shot(page, create, "sidebar-create", scheme);

  // 2 — the template menu it opens: the blank entry wears the same mark
  await create.click();
  const blank = page.getByRole("menuitem", { name: "Blank page" });
  await blank.waitFor();
  await page.waitForTimeout(400);
  await shot(page, blank, "template-menu", scheme);
  await blank.click();
  await page.waitForURL(/\/p\//, { timeout: 30_000 });
  await page.waitForTimeout(1_200);

  // 3 — the shared dialog close (History, Move, Rename, Shortcuts, Settings)
  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const move = page.getByRole("dialog", { name: "Move page" });
  await move.waitFor();
  await page.waitForTimeout(400);
  await shot(page, move.getByRole("button", { name: "Close move dialog" }), "dialog-close", scheme);
  // 4 — and the selected-destination check inside the same dialog
  await shot(page, move.getByRole("button", { name: "Top level" }), "move-selected", scheme);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // 5 — the page-actions menu check: the marker on the chosen font
  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Heading font" }).hover();
  const checked = page.getByRole("menuitemradio", { name: "Sans" });
  await checked.waitFor();
  await page.waitForTimeout(500);
  await shot(page, checked, "menu-check", scheme);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 6 — the sticker's delete control, on the warm plate
  const addSticker = page.getByRole("button", { name: "Add sticker" });
  await addSticker.click();
  const del = page.getByRole("button", { name: "Delete sticker" }).first();
  await del.waitFor();
  await del.hover();
  await page.waitForTimeout(500);
  await shot(page, del, "sticker-close", scheme);

  // 7 — the palette's own New page action
  await page.locator('[data-search-trigger="desktop"]').click();
  const field = page.getByRole("combobox", { name: "Search and commands" });
  await field.waitFor();
  await field.fill("New page");
  const action = page.getByRole("option", { name: /New page/ }).first();
  await action.waitFor();
  await page.waitForTimeout(500);
  await shot(page, action, "palette-create", scheme);

  await context.close();
}

// The clear-search cross and the tab bar's create only exist on a phone.
for (const scheme of passes.includes("phone") ? ["light", "dark"] : []) {
  console.log(`— ${scheme} (phone)`);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await login(page);
  await page.waitForTimeout(800);

  // 8 — the tab bar's ink-filled create, the phone's twin of the sidebar one
  const tabNew = page.getByRole("button", { name: "New", exact: true }).first();
  await tabNew.waitFor();
  await shot(page, tabNew, "tabbar-create", scheme);

  // 9 — the palette's clear-search cross
  // cmdk labels its input through the Command, so the accessible name is
  // "Search and commands" on both palettes — reach the phone one by attribute.
  const field = page.locator('input[aria-label="Search pages and text"]');
  // The tab bar can still be settling right after the shell mounts; one retry
  // beats a flake that loses the whole run.
  for (let attempt = 0; attempt < 3 && !(await field.isVisible()); attempt++) {
    await page.locator(".brain-mobile-tab").nth(1).click();
    await page.waitForTimeout(1_200);
  }
  await field.waitFor();
  await field.fill("note");
  const clear = page.getByRole("button", { name: "Clear search" });
  await clear.waitFor();
  await page.waitForTimeout(500);
  await shot(page, clear, "palette-clear", scheme);

  await context.close();
}

// The unified inbox's section Done — the one check that is a control, not a
// state marker. Mocked routes: this frame must not need a live mailbox.
const MAIL_ACCOUNT = {
  accountId: `account-a${"0".repeat(31)}1`,
  emailAddress: "misha@example.test",
  displayName: "Personal",
  status: "connected",
  connectedAt: 1_755_000_000_000,
  createdAt: 1_755_000_000_000,
  updatedAt: 1_755_000_000_000,
  providerKind: "gmail",
  capabilities: {
    mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: true,
    send: true,
    reply: true,
  },
};

const MAIL_SEED = [
  ["Hanna Vogt", "hanna@example.test", "The bench arrives Tuesday", "people"],
  ["Petros Anagnos", "petros@example.test", "The shed roof needs felt", "people"],
  ["Backup", "no-reply@backup.example", "Last night's archive is complete", "notification"],
  ["Kettle & Bell", "letters@kettle.example", "Issue 8 — everything in the drawer", "newsletter"],
  ["The Slow Ferry", "post@slowferry.example", "Crossing 21", "newsletter"],
  ["Margins", "notes@margins.example", "Footnotes, plainly", "newsletter"],
  ["Shelf Life", "hello@shelflife.example", "What went off this week", "newsletter"],
];

const MAIL_THREADS = MAIL_SEED.map(([name, address, subject, category], index) => ({
  accountId: MAIL_ACCOUNT.accountId,
  threadId: `thread-g${index}`,
  subject,
  participants: [{ name, address }],
  snippet: "Both are in. One is cheaper, the other can start sooner.",
  lastMessageAt: Date.now() - index * 1_800_000,
  messageCount: 1,
  unread: true,
  starred: false,
  hasAttachments: false,
  listMessage: category !== "people",
  sizeBytes: 24_000 + index * 3_100,
  category,
}));

const json = (route, body) =>
  route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });

for (const scheme of passes.includes("mail") ? ["light", "dark"] : []) {
  console.log(`— ${scheme} (mail)`);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    json(route, { apiVersion: 3, accounts: [MAIL_ACCOUNT] }),
  );
  await page.route(/\/api\/mail\/threads\?.*$/, (route) =>
    json(route, {
      apiVersion: 1,
      items: MAIL_THREADS,
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: Date.now() },
    }),
  );
  await page.route("**/api/mail/sync", (route) =>
    json(route, { apiVersion: 1, status: "idle", changedCount: 0, hasMore: false }),
  );
  await page.route("**/api/mail/sender-icon/**", (route) => route.abort());
  await login(page);

  await page.goto(`${origin}/mail`);
  const done = page.getByRole("button", { name: /^Done — archive all \d+ in / }).first();
  await done.waitFor({ timeout: 30_000 });
  await page.mouse.move(1_100, 780);
  await page.waitForTimeout(700);
  await shot(page, done, "section-done", scheme);

  await context.close();
}

await browser.close();
console.log(`\ndocs/design/glyphs — ${stage} frames written`);
