// Stickers: the first one pinned on a note, in a browser, by one person.
//
// The bug this guards is the shape a person meets it in. A note with an image
// and a paragraph, one tab, nobody else writing, and the toast says "Stickers
// changed elsewhere." The precondition the sticker save sends is `[]`, because
// a page with no stickers holds no `stickers` key to read, and the store
// compared that with the absent field's `null` and refused. The sticker never
// reached disk: it lived in localStorage, and every reopen flushed it and
// raised the toast again.
//
// `@release`, and the only browser-level guard on the sticker write path: the
// existing sticker coverage in `critical-flows` seeds them through an API
// PATCH that carries no precondition at all, so it cannot see this.
import { expect, test, type Page } from "playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/auth") &&
        candidate.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

async function browserJson(
  page: Page,
  requestPath: string,
  init: { method?: string; body?: unknown } = {},
) {
  return page.evaluate(
    async ({ path, requestInit }) => {
      const response = await fetch(path, {
        method: requestInit.method,
        headers:
          requestInit.body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body:
          requestInit.body === undefined
            ? undefined
            : JSON.stringify(requestInit.body),
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
      };
    },
    { path: requestPath, requestInit: init },
  );
}

test("@release the first sticker on a note saves without a conflict toast", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);

  const created = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      title: "Garden",
      markdown: "A paragraph about the garden.\n\n![plant](/api/media/plant.png)",
    },
  });
  expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
  const id = (created.body as { id: string }).id;

  const stickerWrites: number[] = [];
  page.on("response", (response) => {
    if (
      response.url().includes(`/api/page/${id}`) &&
      response.request().method() === "PATCH"
    ) {
      stickerWrites.push(response.status());
    }
  });

  await page.goto(`/p/${id}`);
  await expect(page.getByRole("textbox", { name: "Page content" })).toBeVisible({
    timeout: 20_000,
  });
  const toast = page.getByText("Stickers changed elsewhere", { exact: false });

  // The body first, so the sticker save follows this tab's own autosave.
  const body = page.getByRole("textbox", { name: "Page content" });
  await body.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" One more line.");

  await page.getByRole("button", { name: "Add sticker" }).click();
  await expect(page.getByRole("textbox", { name: "Sticker text" })).toHaveCount(1);
  await expect
    .poll(() => stickerWrites.length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  expect(stickerWrites).toEqual([200]);
  await expect(toast).toHaveCount(0);

  // The sticker is on disk, not only in this browser's draft.
  const read = await browserJson(page, `/api/page/${id}`);
  expect(read.ok).toBeTruthy();
  expect(
    (read.body as { meta: { stickers?: unknown[] } }).meta.stickers,
  ).toHaveLength(1);

  // And the other order: the sticker's text, then more typing, still silent.
  await page.getByRole("textbox", { name: "Sticker text" }).fill("Water on Sunday");
  await body.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" And another.");
  await expect
    .poll(() => stickerWrites.length, { timeout: 20_000 })
    .toBeGreaterThan(1);
  expect(stickerWrites.every((status) => status === 200)).toBe(true);
  await expect(toast).toHaveCount(0);
});
