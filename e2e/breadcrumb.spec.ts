// The breadcrumb pill at the top of a page (DESIGN.md v2 → §12 Breadcrumb).
// A root page's crumb has one segment and that segment is the page's own
// title, repeated a few centimetres above it — so it stays out of the way
// while the title is on screen and materialises once the title has passed
// under the pills. A crumb that carries an ancestor says something the title
// does not, and is on screen throughout.

import { expect, test, type Page } from "playwright/test";

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

/** A page with enough body to scroll the title away twice over. */
async function makePage(
  page: Page,
  fields: { title: string; icon?: string; parentId?: string },
) {
  const created = await page.evaluate(async (input) => {
    const body = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i}: the paper is the window, the chrome floats.`,
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

/** The crumb of the topbar that is on screen at this viewport — both
 *  variants are in the DOM and CSS picks one at 768px. */
function crumb(page: Page, variant: "desktop" | "mobile") {
  return page.locator(`.brain-topbar-${variant} nav[aria-label="Breadcrumb"]`);
}

async function openPage(page: Page, id: string, title: string) {
  await page.goto(`/p/${id}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
    title,
  );
}

async function scrollCanvas(page: Page, top: number) {
  const scroller = page.locator(".brain-page-scroll");
  // The editor chunk lands after the shell paints. Scrolling before its
  // paragraphs are in the flow is clamped straight back to the top, which
  // reads here as "the crumb never came".
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(top);
  await scroller.evaluate((element, to) => element.scrollTo({ top: to }), top);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(top);
  // past the 220ms materialize
  await page.waitForTimeout(400);
}

test("@release a root page's crumb waits for its title, a nested page's stays", async ({
  page,
}) => {
  await login(page);
  const rootId = await makePage(page, { title: "Spanish", icon: "🇪🇸" });
  const childId = await makePage(page, {
    title: "Verbs",
    icon: "📗",
    parentId: rootId,
  });

  // Root: one segment, and it is the title — hidden while the title is on
  // paper, and genuinely hidden, so it is out of the accessibility tree.
  await openPage(page, rootId, "Spanish");
  const lone = crumb(page, "desktop");
  await expect(lone).toBeAttached();
  await expect(lone).toBeHidden();
  await expect(lone).toHaveClass(/brain-crumb-lone/);
  expect(
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .count(),
  ).toBe(0);

  // Scrolled past the title, the crumb is the only thing naming the page.
  await scrollCanvas(page, 600);
  await expect(lone).toBeVisible();
  await expect(lone).toContainText("Spanish");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();

  // Back to the top and it goes again.
  await scrollCanvas(page, 0);
  await expect(lone).toBeHidden();

  // Nested: the crumb carries the parent, so it never duplicates the title.
  await openPage(page, childId, "Verbs");
  const nested = crumb(page, "desktop");
  await expect(nested).toBeVisible();
  await expect(nested).not.toHaveClass(/brain-crumb-lone/);
  await expect(nested).toContainText("Spanish");
  await scrollCanvas(page, 600);
  await expect(nested).toBeVisible();
});

test("@release the toolbar pills do not move when the crumb comes and goes", async ({
  page,
}) => {
  await login(page);
  const rootId = await makePage(page, { title: "Spanish", icon: "🇪🇸" });
  await openPage(page, rootId, "Spanish");

  const actions = page.locator(".brain-topbar-desktop .brain-topbar-actions");
  await expect(actions).toBeVisible();
  const atRest = (await actions.boundingBox())!;

  await scrollCanvas(page, 600);
  await expect(crumb(page, "desktop")).toBeVisible();
  const revealed = (await actions.boundingBox())!;

  expect(revealed.x).toBeCloseTo(atRest.x, 0);
  expect(revealed.y).toBeCloseTo(atRest.y, 0);
  expect(revealed.width).toBeCloseTo(atRest.width, 0);
});

test("@release @mobile the header crumb follows the same rule at 390", async ({
  page,
}) => {
  await login(page);
  const rootId = await makePage(page, { title: "Spanish", icon: "🇪🇸" });
  const childId = await makePage(page, {
    title: "Verbs",
    icon: "📗",
    parentId: rootId,
  });

  await openPage(page, rootId, "Spanish");
  const lone = crumb(page, "mobile");
  await expect(lone).toBeHidden();
  // The row floats over the scroller the way the desktop layer does — the
  // page pill stands inside the scroller's box, not above it — and at rest
  // the title sits clear below the pill.
  const pill = page.locator('.brain-topbar-mobile [aria-label="Page"]');
  const atRest = (await pill.boundingBox())!;
  const scroller = (await page.locator(".brain-page-scroll").boundingBox())!;
  expect(atRest.y).toBeGreaterThanOrEqual(scroller.y);
  const title = (await page
    .getByRole("textbox", { name: "Page title" })
    .boundingBox())!;
  expect(title.y).toBeGreaterThanOrEqual(atRest.y + atRest.height);

  // Scrolled, the title has passed under the row, the crumb names the page,
  // and the pill keeps its place.
  await scrollCanvas(page, 600);
  await expect(lone).toBeVisible();
  const revealed = (await pill.boundingBox())!;
  expect(revealed.x).toBeCloseTo(atRest.x, 0);
  expect(revealed.y).toBeCloseTo(atRest.y, 0);
  // The document runs under the row: between the crumb and the pill the
  // layer takes no pointer events, so what stands at that point is the
  // scroller's own content.
  const crumbBox = (await lone.boundingBox())!;
  const between = {
    x: (crumbBox.x + crumbBox.width + revealed.x) / 2,
    y: revealed.y + revealed.height / 2,
  };
  expect(revealed.x - (crumbBox.x + crumbBox.width)).toBeGreaterThan(8);
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest(".brain-page-scroll") !==
        null,
      between,
    ),
  ).toBe(true);

  await openPage(page, childId, "Verbs");
  await expect(crumb(page, "mobile")).toBeVisible();
});
