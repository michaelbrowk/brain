// Owner-gate artifact capture for the breadcrumb reveal — run on demand:
//
//   CRUMB_SHOTS=1 pnpm exec playwright test e2e/crumb-shots.spec.ts
//
// Screenshots land in docs/design/crumb/. Skipped everywhere else so the full
// e2e suite never rewrites the committed artifacts.
//
// The whole change is a thing that appears, so every frame comes in pairs:
// the page at rest, where the title says the page's name and the crumb is
// gone, and the same page scrolled, where the title has left and the crumb
// is the only thing naming it. Covered and uncovered, because a cover puts
// the title lower and the pill over the picture — that is where the timing
// shows. A nested page closes the set: its crumb carries a parent, so it is
// there in both frames.
import { expect, test, type Page } from "playwright/test";
import path from "node:path";
import sharp from "sharp";

const OUT = path.join(process.cwd(), "docs", "design", "crumb");

test.skip(process.env.CRUMB_SHOTS !== "1", "artifact capture — run with CRUMB_SHOTS=1");

/** A saturated cover: the crumb has to be legible arriving over it. */
async function warmCover(width: number, height: number) {
  const data = Buffer.alloc(width * height * 3);
  const cx = width / 2;
  const cy = height * 1.6;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const angle = Math.atan2(y - cy, x - cx);
      const ray = 0.5 + 0.5 * Math.sin(angle * 90);
      const radial = Math.min(1, Math.hypot(x - cx, y - cy) / (width * 0.75));
      const t = Math.min(1, ray * 0.55 + (1 - radial) * 0.75);
      const index = (width * y + x) * 3;
      data[index] = Math.round(196 + 59 * t);
      data[index + 1] = Math.round(38 + 140 * t);
      data[index + 2] = Math.round(12 + 30 * t);
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/auth") && candidate.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(scheme === "dark");
}

async function makePage(
  page: Page,
  fields: { title: string; icon?: string; parentId?: string },
) {
  const created = await page.evaluate(async (input) => {
    const body = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i}: the paper is the window, the chrome floats over it.`,
    ).join("\n\n");
    const response = await fetch("/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, markdown: body }),
    });
    return (await response.json()) as { id: string };
  }, fields);
  return created.id;
}

async function uploadCover(page: Page) {
  await page.getByRole("button", { name: "Add cover" }).click();
  // The editor has its own attachment input, so address the picker's through
  // the file chooser its button opens rather than by selector.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Upload image" }).click(),
  ]);
  await chooser.setFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: await warmCover(1440, 260),
  });
  await expect(page.locator(".brain-cover img")).toBeVisible();
  await page.waitForTimeout(600);
}

/** Park the pointer and the caret, then re-sample the glass: a
 *  backdrop-filter layer keeps a stale snapshot of its backdrop when the
 *  content behind it changes while the scheme is being emulated. */
async function settle(page: Page) {
  await page.mouse.move(4, 700);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
}

/** The 220ms materialize plus a margin, so an arriving pill is captured
 *  landed rather than mid-fade. */
async function shoot(page: Page, name: string) {
  await page.waitForTimeout(500);
  const view = page.viewportSize()!;
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: { x: 0, y: 0, width: view.width, height: Math.min(view.height, 470) },
  });
}

async function scrollTo(page: Page, top: number) {
  const scroller = page.locator(".brain-page-scroll");
  // the editor chunk lands after the shell paints; scrolling before its
  // paragraphs are in the flow is clamped back to the top
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(top);
  await scroller.evaluate((el, to) => el.scrollTo({ top: to }), top);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(top);
}

async function frame(page: Page, name: string, scrollTop: number) {
  await scrollTo(page, scrollTop);
  await shoot(page, name);
}

/** Both halves of the feature on one page: at rest and scrolled past. */
async function pair(page: Page, name: string) {
  await settle(page);
  await frame(page, `${name}-rest`, 0);
  await frame(page, `${name}-scrolled`, 600);
}

/** The frame at the handover itself — walked in 20px steps until the shell
 *  flips, so it lands on the first scroll position that has the crumb rather
 *  than on a guessed number. On a covered page this is the one that answers
 *  whether the pill has to fight the picture. */
async function handover(page: Page, name: string) {
  await settle(page);
  for (let top = 0; top <= 800; top += 20) {
    await scrollTo(page, top);
    await page.waitForTimeout(60);
    const arrived = await page.evaluate(
      () => document.querySelector(".brain-main")?.hasAttribute("data-title-out") ?? false,
    );
    if (arrived) break;
  }
  await shoot(page, `${name}-handover`);
}

async function open(page: Page, id: string, title: string) {
  await page.goto(`/p/${id}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(title);
}

// One root page carries the whole desktop set — the notes root lives for the
// life of the server, and a second "Spanish" would sit in the sidebar of
// every frame after it.
test("desktop — plain, covered, and the nested control", async ({ page }) => {
  await login(page);
  const rootId = await makePage(page, { title: "Spanish", icon: "🇪🇸" });
  const childId = await makePage(page, { title: "Verbs", icon: "📗", parentId: rootId });

  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);
    await open(page, rootId, "Spanish");
    await pair(page, `root-plain-${scheme}`);
  }

  // The control: a crumb carrying a parent is there in both frames.
  await setScheme(page, "light");
  await open(page, childId, "Verbs");
  await pair(page, "nested-light");

  // A cover puts the title lower and the pill over the picture — the case
  // where the timing of the reveal is most visible.
  await open(page, rootId, "Spanish");
  await uploadCover(page);
  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);
    await page.reload();
    await expect(page.locator(".brain-cover img")).toBeVisible();
    await pair(page, `root-cover-${scheme}`);
    await handover(page, `root-cover-${scheme}`);
  }
});

// Its own page, and no sidebar to show it twice: below 768 the header row is
// in flow above the scroller and covers nothing, so the title leaves at the
// scroller's own top.
test("mobile — the header row keeps its place either way", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const id = await makePage(page, { title: "Spanish", icon: "🇪🇸" });

  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);
    await open(page, id, "Spanish");
    await pair(page, `mobile-${scheme}`);
  }
});
