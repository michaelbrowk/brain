// Owner-gate artifact capture for filing an unreferenced child — run on demand:
//
//   SUBPAGE_SHOTS=1 pnpm exec playwright test e2e/subpage-filing-shots.spec.ts
//
// Screenshots land in docs/design/subpages/. Skipped everywhere else so the
// full e2e suite never rewrites the committed artifacts.
//
// The change is a row that can leave one place and arrive in another, so the
// set is the moments of the same page — the tail at rest under its own rule
// and name, the drag with the indicator showing where the reference will
// land, the block confirming itself the instant it arrives, and the document
// after that with the tail one row shorter. The row menu closes the set: it
// is the same move for a reader who cannot drag, and for a phone.
//
// The refusal has no frame. What it is, is the absence of an insertion line
// and a `no-drop` cursor, and a screenshot carries neither.
import { expect, test, type Page } from "playwright/test";
import path from "node:path";

const OUT = path.join(process.cwd(), "docs", "design", "subpages");

test.skip(process.env.SUBPAGE_SHOTS !== "1", "artifact capture — run with SUBPAGE_SHOTS=1");

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/auth") &&
        candidate.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(scheme === "dark");
}

async function makePage(
  page: Page,
  fields: { title: string; icon?: string; parentId?: string; markdown?: string },
) {
  const created = await page.evaluate(async (input) => {
    const response = await fetch("/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return (await response.json()) as { id: string };
  }, fields);
  return created.id;
}

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The whole main column — the reading measure, the tail under it, and the
 *  chrome that frames them. Clipped to the viewport so nothing is half cut. */
async function frame(page: Page): Promise<Clip> {
  const main = await page.locator(".brain-main").boundingBox();
  const article = await page.locator("article.brain-page-article").boundingBox();
  if (!main || !article) throw new Error("Missing page geometry");
  const view = page.viewportSize()!;
  const y = Math.max(0, article.y - 56);
  return {
    x: main.x,
    y,
    width: Math.min(main.width, view.width - main.x),
    height: view.height - y,
  };
}

/** `clip` is passed when the moment is short — the confirming flash lasts
 *  600ms, and measuring the column again would spend most of it. */
async function shoot(page: Page, name: string, clip?: Clip) {
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: clip ?? (await frame(page)),
  });
}

/** A drop dirties the page, and the autosave draft that leaves behind makes
 *  the next load recover it — with a toast that sits over the bottom of every
 *  later frame. The artifact wants the page at rest, so the drag's leftovers
 *  go before the next visit. */
async function clearDrafts(page: Page) {
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("brain-draft-")) localStorage.removeItem(key);
    }
  });
}

async function settle(page: Page) {
  await page.mouse.move(4, 700);
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.waitForTimeout(400);
  await expect(page.locator(".brain-toast")).toHaveCount(0);
}

const BODY =
  "# Reading\n\nStart with the short stories, then the news.\n\n# Writing\n\nOne paragraph a day, corrected the next morning.";

/** Put the body back so the second scheme starts from the same unfiled tail —
 *  a second fixture page would sit in the sidebar of every later frame. */
async function resetBody(page: Page, id: string) {
  await page.evaluate(
    async ({ pageId, markdown }) => {
      const current = await (await fetch(`/api/page/${pageId}`)).json();
      await fetch(`/api/page/${pageId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown, rev: current.rev }),
      });
    },
    { pageId: id, markdown: BODY },
  );
}

test("filing an unreferenced child — rest, drag, drop, and the row menu", async ({
  page,
}) => {
  await login(page);
  const parentId = await makePage(page, {
    title: "Spanish",
    icon: "🇪🇸",
    markdown: BODY,
  });
  const verbs = await makePage(page, { title: "Verbs", icon: "📗", parentId });
  await makePage(page, { title: "Nouns", icon: "📘", parentId });

  for (const scheme of ["light", "dark"] as const) {
    await resetBody(page, parentId);
    await clearDrafts(page);
    await setScheme(page, scheme);
    await page.goto(`/p/${parentId}`);
    const tail = page.locator("[data-derived-page-refs]");
    await expect(tail.locator("a.brain-page-ref")).toHaveCount(2);
    await settle(page);
    await shoot(page, `tail-rest-${scheme}`);

    // Mid-drag: the row dims, and the indicator names the boundary the
    // reference will be written to.
    const row = tail.locator(`a.brain-page-ref[data-page-ref="${verbs}"]`);
    const rowBox = (await row.boundingBox())!;
    const reading = page.locator(".ProseMirror p", {
      hasText: "Start with the short stories",
    });
    const readingBox = (await reading.boundingBox())!;
    await page.mouse.move(
      rowBox.x + rowBox.width / 2,
      rowBox.y + rowBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      rowBox.x + rowBox.width / 2 + 12,
      rowBox.y + rowBox.height / 2 - 10,
      { steps: 5 },
    );
    await page.mouse.move(
      readingBox.x + 8,
      readingBox.y + readingBox.height + 2,
      { steps: 24 },
    );
    await page.mouse.move(
      readingBox.x + 8,
      readingBox.y + readingBox.height + 3,
      { steps: 2 },
    );
    await expect(page.locator(".brain-drop-cursor")).toBeVisible();
    const clip = await frame(page);
    await shoot(page, `tail-drag-${scheme}`, clip);
    await page.mouse.up();

    // The block that arrived confirms itself for 600ms and then settles into
    // the document. Both are frames: what the drop said, and what it left.
    await expect(
      page.locator(`.ProseMirror a.brain-page-ref[data-page-ref="${verbs}"]`),
    ).toHaveCount(1);
    await shoot(page, `tail-flash-${scheme}`, clip);
    await expect(tail.locator("a.brain-page-ref")).toHaveCount(1);
    await settle(page);
    await shoot(page, `tail-filed-${scheme}`);

    // The row menu — the same move without a pointer gesture.
    const trigger = tail.locator("[data-file-page-trigger]");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.waitForTimeout(300);
    await shoot(page, `tail-menu-${scheme}`);
    await page.keyboard.press("Escape");
  }
});

// Its own page at 390 with real touch emulation: HTML5 drag never starts from
// a finger, so the row action is the whole path there and `hover: none` keeps
// it visible at rest instead of waiting for a pointer that never arrives.
test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the row action is the path where a drag is not", async ({ page }) => {
  await login(page);
  const parentId = await makePage(page, {
    title: "Spanish",
    icon: "🇪🇸",
    markdown: BODY,
  });
  await makePage(page, { title: "Verbs", icon: "📗", parentId });
  await makePage(page, {
    title: "Nouns, and the long compounds that wrap on a narrow screen",
    icon: "📘",
    parentId,
  });

  for (const scheme of ["light", "dark"] as const) {
    await clearDrafts(page);
    await setScheme(page, scheme);
    await page.goto(`/p/${parentId}`);
    await expect(
      page.locator("[data-derived-page-refs] a.brain-page-ref"),
    ).toHaveCount(2);
    await settle(page);
    await expect(
      page.locator("[data-derived-page-refs] [data-file-page-trigger]").first(),
    ).toBeVisible();
    await shoot(page, `tail-touch-${scheme}`);
  }
  });
});
