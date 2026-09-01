// Owner-gate artifacts for the Liquid Glass shell train (T1–T4).
// Usage: BRAIN_E2E_PORT=3031 BRAIN_DIST_DIR=.next/train node scripts/e2e-dev.mjs   (terminal 1)
//        node scripts/train-shots.mjs [--only=page,home,mail,focus] [--perf]   (terminal 2)
// Writes docs/design/train/<state>-<viewport>-<theme>[-matte].png (lossless,
// git-ignored) and the same frames as .webp (the review copies).
// --perf scrolls a 10k-word page with tracing on and prints the backdrop
// layer count in the viewport and the p95 rAF interval (report-only).
//
// The directory it writes into is on the publication denylist
// (scripts/publication-denylist.mjs), so this repository carries none of
// these frames. Shoot them, read them, throw them away — but do not commit
// them here: the forbidden-path step of `pnpm check` refuses a tracked path
// the list names.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const port = process.env.BRAIN_E2E_PORT ?? "3031";
const origin = `http://127.0.0.1:${port}`;
const outDir = fileURLToPath(new URL("../docs/design/train/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const perf = args.includes("--perf");

const COVER_MD = `2026 Season Calendar — sowing weeks for the five beds, kept on one page.

## When each crop goes in

Weeks count from the first Monday in January, and anything raised under glass runs two or three weeks ahead of the same crop outdoors. Съешь же ещё этих мягких французских булок, да выпей чаю.

| Crop | North bed | South bed | River plot | Terrace | Greenhouse |
| --- | --- | --- | --- | --- | --- |
| Broad beans | wk 09 | wk 11 | wk 10 | wk 12 | wk 07 |
| Radish | wk 12 | wk 12 | wk 14 | wk 13 | wk 09 |
| Carrots | wk 13 | wk 15 | wk 14 | wk 16 | wk 10 |
| Chard | wk 15 | wk 14 | wk 16 | wk 15 | wk 11 |
| Beetroot | wk 14 | wk 13 | wk 15 | wk 14 | wk 12 |

### Watering

- The can lives by the gate, not at the back of the shed
- Pots on the terrace steps want a second pass on warm evenings
- The river plot drains first, so it gets watered first

> A quote without a left stripe: the page is paper, the chrome floats.

Closing paragraph with a [link](https://example.com) and some \`inline code\`.
`;

async function login(page) {
  // the Next dev indicator sits over the bottom-left corner
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

async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const r = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
    },
    { path, body },
  );
}

async function seed(page) {
  // idempotent: a re-run reuses the pages a previous run created
  const treeResponse = await api(page, "/api/tree");
  const flat = [];
  const walk = (nodes) => (nodes ?? []).forEach((n) => { flat.push(n); walk(n.children); });
  walk(treeResponse.body?.tree ?? treeResponse.body ?? []);
  const existing = (title) => flat.find((n) => n.title === title)?.id;
  if (existing("Summer 2026")) {
    return { pageId: existing("Summer 2026"), parentId: existing("Field Guide"), longId: existing("Ten thousand words") };
  }
  const parent = await api(page, "/api/page", { title: "Field Guide", markdown: "Parent page.", icon: "🌿" });
  const parentId = parent.body?.id;
  const cover = await api(page, "/api/page", {
    title: "2026 Season Calendar",
    markdown: COVER_MD,
    icon: "📅",
    parentId,
  });
  const pageId = cover.body?.id;
  // cover + pin through the meta endpoint (same as the UI)
  await page.evaluate(async ({ pageId, parentId }) => {
    await fetch(`/api/page/${pageId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cover: "grad:2" }) }).catch(() => {});
    await fetch(`/api/page/${parentId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: true }) }).catch(() => {});
    await fetch(`/api/page/${pageId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: true }) }).catch(() => {});
  }, { pageId, parentId });
  for (const t of ["Family", "Daily", "Reading", "Greenhouse", "Seedlings", "Spanish", "English", "Archive", "Compost Rotation", "Watering Rota", "Harvest Log — Урожай по грядкам"]) {
    await api(page, "/api/page", { title: t, markdown: `${t} page.`, parentId: ["Seedlings", "Archive", "Compost Rotation", "Watering Rota"].includes(t) ? parentId : undefined });
  }
  // a 10k-word page for the perf note
  const words = Array.from({ length: 10_000 }, (_, i) => (i % 17 === 0 ? "\n\n" : "") + ["paper", "glass", "floats", "over", "the", "window", "chrome", "inset", "twelve"][i % 9]).join(" ");
  const long = await api(page, "/api/page", { title: "Ten thousand words", markdown: words, icon: "📜" });
  return { pageId, parentId, longId: long.body?.id };
}

async function save(page, name, viewport) {
  const png = await page.screenshot({ type: "png", fullPage: false });
  writeFileSync(`${outDir}${name}-${viewport}.png`, png);
  await sharp(png).webp({ quality: 84 }).toFile(`${outDir}${name}-${viewport}.webp`);
  console.log(`  ${name}-${viewport}`);
}

async function setTheme(page, dark) {
  await page.evaluate((dark) => {
    localStorage.setItem("theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, dark);
  await page.waitForTimeout(250);
}

async function setMatte(page, on) {
  await page.evaluate((on) => {
    if (on) document.documentElement.dataset.glassFallback = "matte";
    else delete document.documentElement.dataset.glassFallback;
  }, on);
  await page.waitForTimeout(120);
}

/** Stub the mail API so /mail shows a list under its own head (no real
 *  account on the throwaway dev server). Shapes match e2e/mail-client.spec. */
async function stubMail(page) {
  const account = {
    accountId: "account-a0123456789abcdef0123456789abcdef",
    emailAddress: "misha@example.test",
    displayName: "Personal",
    status: "connected",
    connectedAt: 1700000000000,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    providerKind: "gmail",
    capabilities: {
      mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
      listThreads: true, sync: true, headerPreview: true, messageBodies: true,
      threadMutations: true, compose: true, send: true, reply: true,
    },
  };
  const senders = ["Hanna Vogt", "Bramble Post", "Petros Anagnos", "Backup", "Ксения Барт", "Margins", "Bike Workshop", "Allotment Society"];
  const subjects = [
    "The bench arrives Tuesday", "One week of listings left", "The shed roof needs felt",
    "Last night's archive is complete", "Записка для соседей сверху", "Ragged right, on purpose",
    "Your service is booked", "Your plot inspection is due",
  ];
  const items = senders.map((name, i) => ({
    accountId: account.accountId,
    threadId: `thread-${i + 1}`,
    subject: subjects[i],
    participants: [{ name, address: `${i}@example.test` }],
    snippet: "12PM sounds great to me — see you at the usual place.",
    lastMessageAt: 1700000000000 - i * 8640000,
    messageCount: 1 + (i % 3),
    unread: i < 3,
    starred: i === 1,
    hasAttachments: i % 4 === 0,
  }));
  const fulfill = (route, body) =>
    route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
  await page.route("**/api/mail/accounts/capabilities", (r) => fulfill(r, { apiVersion: 3, accounts: [account] }));
  await page.route(/\/api\/mail\/threads\?.*$/, (r) =>
    fulfill(r, { apiVersion: 1, items, nextCursor: null, sync: { status: "idle", lastSuccessfulAt: 1700000000000 } }));
  await page.route("**/api/mail/sync", (r) => fulfill(r, { apiVersion: 1, status: "idle", changedCount: 0, hasMore: false }));
  await page.route("**/api/mail/drafts**", (r) => fulfill(r, { apiVersion: 1, items: [] }));
}

async function shots(browser, ids, viewport) {
  const [width, height] = viewport === "mobile" ? [390, 844] : [1440, 900];
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: viewport === "mobile", hasTouch: viewport === "mobile" });
  const page = await context.newPage();
  await stubMail(page);
  await login(page);
  const states = [
    ["page", `/p/${ids.pageId}`],
    ["home", "/"],
    ["mail", "/mail"],
  ];
  for (const [name, path] of states) {
    if (only && !only.includes(name)) continue;
    await page.goto(`${origin}${path}`);
    await page.waitForTimeout(900);
    for (const dark of [false, true]) {
      await setTheme(page, dark);
      await save(page, `${name}-${dark ? "dark" : "light"}`, viewport);
      if (name === "page") {
        await setMatte(page, true);
        await save(page, `${name}-${dark ? "dark" : "light"}-matte`, viewport);
        await setMatte(page, false);
      }
    }
    await setTheme(page, false);
    if (name === "page") {
      // scrolled: the cover and the title pass under the pills
      await page.locator(".brain-page-scroll").evaluate((el) => el.scrollTo({ top: 260 }));
      await page.waitForTimeout(300);
      await save(page, "page-scrolled-light", viewport);
      await page.locator(".brain-page-scroll").evaluate((el) => el.scrollTo({ top: 0 }));
    }
  }
  if ((!only || only.includes("focus")) && viewport === "desktop") {
    await page.goto(`${origin}/p/${ids.pageId}`);
    await page.waitForTimeout(600);
    await page.keyboard.press("Meta+\\");
    await page.waitForTimeout(700);
    await save(page, "focus-light", viewport);
    await setTheme(page, true);
    await save(page, "focus-dark", viewport);
    await setTheme(page, false);
    await page.keyboard.press("Meta+\\");
  }
  if ((!only || only.includes("pages")) && viewport === "mobile") {
    await page.goto(`${origin}/p/${ids.pageId}`);
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Pages", exact: true }).click();
    await page.waitForTimeout(600);
    await save(page, "pages-sheet-light", viewport);
    await setTheme(page, true);
    await save(page, "pages-sheet-dark", viewport);
  }
  await context.close();
}

async function perfNote(browser, ids) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);
  await page.goto(`${origin}/p/${ids.longId}`);
  await page.waitForSelector(".milkdown .ProseMirror");
  await page.waitForTimeout(1200);
  const backdrops = await page.evaluate(() => {
    const vh = window.innerHeight, vw = window.innerWidth;
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      if (getComputedStyle(el).backdropFilter === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width === 0) continue;
      out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
    }
    return out;
  });
  await context.tracing.start({ screenshots: false, snapshots: false });
  const intervals = await page.evaluate(async () => {
    const scroller = document.querySelector(".brain-page-scroll");
    const gaps = [];
    let last = performance.now();
    let raf = 0;
    const tick = (t) => { gaps.push(t - last); last = t; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const start = performance.now();
    while (performance.now() - start < 3000) {
      scroller.scrollBy(0, 14);
      await new Promise((r) => setTimeout(r, 8));
    }
    cancelAnimationFrame(raf);
    return gaps;
  });
  await context.tracing.stop({ path: `${outDir}perf-trace.zip` });
  const sorted = [...intervals].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const note = `# Train perf note (report-only)\n\nChromium ${await browser.version()}, 1440×900, page "Ten thousand words" (10k words), wheel-scroll 3 s.\n\n- backdrop layers in the viewport at rest: **${backdrops.length}** — ${backdrops.join(", ")}\n- rAF interval p50 **${p50.toFixed(1)} ms**, p95 **${p95.toFixed(1)} ms** (${intervals.length} frames)\n- trace: docs/design/train/perf-trace.zip (git-ignored)\n\nCI chromium has no GPU (SwiftShader), so this catches order-of-magnitude regressions (per-row glass), not 60 vs 55 fps; the real gate is Safari Timelines on real hardware.\n`;
  writeFileSync(`${outDir}../train-perf.md`, note);
  console.log(note);
  await context.close();
}

const browser = await chromium.launch();
const setup = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const setupPage = await setup.newPage();
await login(setupPage);
const ids = await seed(setupPage);
await setup.close();
console.log("seeded", ids);
if (!perf) {
  console.log("desktop");
  await shots(browser, ids, "desktop");
  console.log("mobile");
  await shots(browser, ids, "mobile");
}
if (perf) await perfNote(browser, ids);
await browser.close();
