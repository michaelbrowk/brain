// Owner-gate artifact capture for the nesting gesture inside a column layout —
// run on demand:
//
//   BRAIN_E2E_PORT=3148 BRAIN_DIST_DIR=.next-nest node scripts/e2e-dev.mjs
//   COLUMN_NEST_SHOTS=1 BRAIN_E2E_PORT=3148 pnpm exec playwright test e2e/column-nest-shots.spec.ts
//
// Screenshots land in docs/design/tree/. Skipped everywhere else so the full
// e2e suite never rewrites the artifacts on disk.
//
// The bug was that a page laid out in columns offered only one outcome: every
// pointer position drew the reorder line, and nothing could be put inside
// anything. So the set is the two outcomes held at the moment before release,
// on the layout that used to have only one of them — the pointer in the middle
// of a row, which plates the row and means the page goes inside it, and the
// pointer on the row's edge, which draws the insertion line and means the page
// lands beside it. Both taken with the drag starting in the *other* lane, the
// case where column drop wants the same pixels.
//
// `column-nest-before-*.png` beside them are the same two frames captured
// against the code this branch fixes, kept as the before half of the pair: the
// middle of the row drew the insertion line too, so both frames are the same
// picture. They are historical and this spec does not regenerate them — to
// redo the pair, stash the fix, run, rename, restore, run again.
//
// The directory it writes into is on the publication denylist
// (scripts/publication-denylist.mjs), so this repository carries none of
// these frames. Shoot them, read them, throw them away — but do not commit
// them here: the forbidden-path step of `pnpm check` refuses a tracked path
// the list names.

import { expect, test, type Page } from "playwright/test";
import path from "node:path";

const OUT = path.join(process.cwd(), "docs", "design", "tree");

test.skip(
  process.env.COLUMN_NEST_SHOTS !== "1",
  "artifact capture — run with COLUMN_NEST_SHOTS=1",
);

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

async function api(
  page: Page,
  requestPath: string,
  init: { method?: string; body?: unknown } = {},
) {
  return page.evaluate(
    async ({ url, request }) => {
      const response = await fetch(url, {
        method: request.method,
        headers:
          request.body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      return (await response.json()) as Record<string, unknown>;
    },
    { url: requestPath, request: init },
  );
}

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(scheme === "dark");
}

/** The document body alone. The two frames differ by one ring and one line
 *  inside the columns, and a full window spends most of its pixels on chrome
 *  that is not part of the change. */
async function frame(page: Page) {
  const editor = await page.locator(".ProseMirror").boundingBox();
  if (!editor) throw new Error("Missing editor geometry");
  const view = page.viewportSize()!;
  return {
    x: Math.max(0, editor.x - 24),
    y: Math.max(0, editor.y - 24),
    width: Math.min(editor.width + 48, view.width),
    height: Math.min(editor.height + 48, view.height),
  };
}

/** Hold the drag at a band of the target row and shoot it there. The gesture is
 *  never released, so the artifact run reads the same fixture every time. */
async function shootDrag(
  page: Page,
  name: string,
  sourceId: string,
  targetId: string,
  fraction: number,
) {
  const source = page.locator(`a.brain-page-ref[data-page-ref="${sourceId}"]`);
  const target = page.locator(`a.brain-page-ref[data-page-ref="${targetId}"]`);
  await source.hover();
  // Milkdown's block service throttles pointer movement by 200 ms.
  await page.waitForTimeout(400);

  const handle = page.locator('.brain-block-handle[data-show="true"]');
  await expect(handle).toHaveCount(1);
  const handleBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  if (!handleBox || !targetBox) throw new Error("Missing drag geometry");

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY, { steps: 5 });
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height * fraction,
    { steps: 24 },
  );
  await page.waitForTimeout(120);

  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: await frame(page),
  });

  await page.keyboard.press("Escape");
  await page.mouse.up();
}

test("column page-row drop intents", async ({ page }) => {
  await login(page);
  const parent = (await api(page, "/api/page", {
    method: "POST",
    body: { title: "Field Guide", icon: "🌿" },
  })) as { id: string };
  const child = async (title: string, icon: string) =>
    (await api(page, "/api/page", {
      method: "POST",
      body: { parentId: parent.id, title, icon },
    })) as { id: string };
  const archive = await child("Archive", "🗄️");
  const compost = await child("Compost Rotation", "🪱");
  const trial = await child("Tomato Trial Rows", "🍅");
  const bees = await child("Bees", "🐝");

  const current = (await api(page, `/api/page/${parent.id}`)) as { rev: string };
  await api(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: {
      rev: current.rev,
      markdown: [
        "::::cols",
        ":::col",
        "## Beds & Borders",
        "",
        `[🗄️ Archive](/p/${archive.id})`,
        "",
        `[🪱 Compost Rotation](/p/${compost.id})`,
        ":::",
        "",
        ":::col",
        "## Notes & Trials",
        "",
        `[🐝 Bees](/p/${bees.id})`,
        "",
        `[🍅 Tomato Trial Rows](/p/${trial.id})`,
        ":::",
        "::::",
      ].join("\n"),
    },
  });

  await page.goto(`/p/${parent.id}`);
  await expect(page.locator(".brain-cols > .brain-col")).toHaveCount(2);

  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);
    await page.waitForTimeout(200);
    // Into: the pointer in the middle of Archive, which rings that row.
    await shootDrag(page, `column-nest-into-${scheme}`, trial.id, archive.id, 0.5);
    // Between: the pointer on Archive's top edge, which draws the line there.
    await shootDrag(
      page,
      `column-nest-between-${scheme}`,
      trial.id,
      archive.id,
      0.05,
    );
  }
});
