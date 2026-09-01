// A page that is only read is never written. Milkdown's commonmark preset
// dispatches a heading-id sync transaction when the view mounts, and the
// first flush used to compare the serializer's body (trailing newline) with
// the server's trimmed body. Together they turned a visit into a draft: one
// PUT of the same body on leave, a "Recovered unsaved draft" on return.

import { expect, test, type Page } from "playwright/test";

const RECOVERED = "Recovered unsaved draft";

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

async function makePage(page: Page, title: string, markdown: string) {
  const created = await page.evaluate(
    async (input) => {
      const response = await fetch("/api/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return (await response.json()) as { id: string };
    },
    { title, icon: "🧪", markdown },
  );
  return created.id;
}

async function pageRev(page: Page, id: string) {
  return page.evaluate(async (pageId) => {
    const response = await fetch(`/api/page/${pageId}`);
    return ((await response.json()) as { rev: string }).rev;
  }, id);
}

async function draftKeys(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.includes("brain-draft")),
  );
}

function trackPuts(page: Page) {
  const puts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && /\/api\/page\//.test(request.url())) {
      puts.push(request.url());
    }
  });
  return puts;
}

async function openAndOnlyRead(page: Page, id: string, visibleText: string) {
  await page.goto(`/p/${id}`);
  await expect(page.locator(".ProseMirror")).toContainText(visibleText);
  // The markdown listener debounces 200ms and autosave waits 700ms after a
  // change. Three seconds is long enough for either to have fired.
  await page.waitForTimeout(3000);
}

async function expectNeitherSavedNorRecovered(
  page: Page,
  id: string,
  visibleText: string,
) {
  const puts = trackPuts(page);
  const revBefore = await pageRev(page, id);

  await openAndOnlyRead(page, id, visibleText);
  expect(puts, "a page that was only opened must not be saved").toEqual([]);
  expect(await draftKeys(page)).toEqual([]);

  // Leaving inside the app flushes the editor. Nothing was typed, so there
  // is nothing to flush.
  await page.locator('[aria-label="Home"]').first().click();
  await expect(page).toHaveURL("/");
  await page.waitForTimeout(1000);
  expect(puts, "leaving a page that was only read must not save it").toEqual(
    [],
  );

  // A full navigation fires pagehide, which used to persist a phantom draft
  // that the next visit "recovered".
  await page.goto(`/p/${id}`);
  await expect(page.locator(".ProseMirror")).toContainText(visibleText);
  await page.goto("/");
  await page.waitForTimeout(500);
  await page.goto(`/p/${id}`);
  await expect(page.locator(".ProseMirror")).toContainText(visibleText);
  await page.waitForTimeout(2500);
  await expect(page.getByText(RECOVERED)).toHaveCount(0);
  expect(await draftKeys(page)).toEqual([]);
  expect(puts, "returning to a page that was only read must not save it").toEqual(
    [],
  );
  expect(await pageRev(page, id)).toBe(revBefore);
}

test("@release a page with headings is neither saved nor recovered when only read", async ({
  page,
}) => {
  await login(page);
  const id = await makePage(
    page,
    "Read-only visit with headings",
    "# Reading\n\nStart with the short stories.\n\n# Writing\n\nOne paragraph a day.",
  );
  await expectNeitherSavedNorRecovered(page, id, "Start with the short stories.");
  // Heading ids stay on the DOM: toDOM derives them from the text without
  // the sync transaction.
  await expect(page.locator(".ProseMirror h1").first()).toHaveAttribute(
    "id",
    /.+/,
  );
});

test("@release a page with columns is neither saved nor recovered when only read", async ({
  page,
}) => {
  await login(page);
  const id = await makePage(
    page,
    "Read-only visit with columns",
    "::::cols\n:::col\n## A\n\nleft\n:::\n\n:::col\n## B\n\nright\n:::\n::::",
  );
  await expectNeitherSavedNorRecovered(page, id, "left");
});
