// Owner-gate artifact capture for the two tree drop intents — run on demand:
//
//   TREE_SHOTS=1 pnpm exec playwright test e2e/tree-move-shots.spec.ts
//
// Screenshots land in docs/design/tree/. Skipped everywhere else so the full
// e2e suite never rewrites the artifacts on disk.
//
// The whole change rests on a reader being able to tell two outcomes apart
// mid-gesture, so the set is exactly those two, held at the moment before the
// release: the pointer in the middle of a row, which rings the whole row and
// means the page goes inside it; and the pointer on a boundary, which draws
// the insertion line at the indent of the parent the page would land in.
// Light and dark, because the ring and the line are the same yellow on two
// very different materials.
//
// The directory it writes into is on the publication denylist
// (scripts/publication-denylist.mjs), so this repository carries none of
// these frames. Shoot them, read them, throw them away — but do not commit
// them here: the forbidden-path step of `pnpm check` refuses a tracked path
// the list names.

import { expect, test, type Page } from "playwright/test";
import path from "node:path";

const OUT = path.join(process.cwd(), "docs", "design", "tree");

test.skip(process.env.TREE_SHOTS !== "1", "artifact capture — run with TREE_SHOTS=1");

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
  fields: { title: string; icon?: string; parentId?: string },
) {
  const created = await page.evaluate(async (body) => {
    const response = await fetch("/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as { id: string };
  }, fields);
  return created.id;
}

const row = (page: Page, id: string) =>
  page.locator(`[data-tree-page-id="${id}"]`);

/** The sidebar alone. The two frames differ by one ring and one line, both
 *  inside the list, and a full window would spend most of its pixels on a
 *  document that is not part of the change. */
async function frame(page: Page) {
  const sidebar = await page.locator(".brain-sidebar").boundingBox();
  if (!sidebar) throw new Error("Missing sidebar geometry");
  const view = page.viewportSize()!;
  return {
    x: Math.max(0, sidebar.x - 12),
    y: Math.max(0, sidebar.y - 12),
    width: Math.min(sidebar.width + 24, view.width),
    height: Math.min(sidebar.height + 24, view.height),
  };
}

/** Hold the drag at a band of the target row and shoot it there. Ends the
 *  gesture with Escape so the artifact run never rewrites the fixture tree —
 *  every frame is captured from the same three rows. */
async function shootDrag(
  page: Page,
  name: string,
  sourceId: string,
  targetId: string,
  fraction: number,
) {
  const from = await row(page, sourceId).boundingBox();
  if (!from) throw new Error("Missing dragged row geometry");
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY, { steps: 5 });
  await expect(page.locator("[data-tree-row-slot]")).toHaveCount(1);

  const to = await row(page, targetId).boundingBox();
  if (!to) throw new Error("Missing target row geometry");
  const endX = to.x + to.width / 2;
  const endY = to.y + to.height * fraction;
  await page.mouse.move(endX, endY, { steps: 24 });
  await page.mouse.move(endX + 0.5, endY, { steps: 2 });

  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: await frame(page) });

  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".tree-row-overlay")).toHaveCount(0);
}

test("tree drop intents", async ({ page }) => {
  await login(page);
  const notes = await makePage(page, { title: "Field Guide", icon: "🌿" });
  await makePage(page, { title: "Tomato Trial Rows", icon: "🍅", parentId: notes });
  await makePage(page, { title: "Bulb Beds", icon: "🌷", parentId: notes });
  const archive = await makePage(page, { title: "Archive", icon: "🗄️" });

  await page.goto("/");
  const expand = row(page, notes).getByRole("button", { name: "Expand" });
  if (await expand.isVisible()) await expand.click();

  const moving = page
    .locator('[data-tree-page-id]')
    .filter({ hasText: "Tomato Trial Rows" });
  await expect(moving).toBeVisible();
  const movingId = await moving.getAttribute("data-tree-page-id");
  if (!movingId) throw new Error("Missing dragged page id");

  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);
    await page.waitForTimeout(200);
    // Into: the pointer in the middle of Archive, which rings the whole row.
    await shootDrag(page, `drop-into-${scheme}`, movingId, archive, 0.5);
    // Between: the pointer on Archive's top edge, which draws the line there
    // at Archive's own indent — the page lands beside it, not inside it.
    await shootDrag(page, `drop-between-${scheme}`, movingId, archive, 0.08);
  }
});
