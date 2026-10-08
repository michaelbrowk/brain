// A hand-written note opens without being rewritten, and an edit changes
// only the line it touched. The serializer gates prove this on the plugin
// stack; this is the same promise through the browser, the save path and
// the server, where opening a page once minted a new rev on its own.

import { expect, test, type Page } from "playwright/test";
import { freshNotes } from "./fresh-notes";

freshNotes();

const HAND_WRITTEN = [
  "Title",
  "=====",
  "",
  "A note with snake_case_word, a bare https://example.com link and :smile: in it.",
  "",
  "- one",
  "- two",
  "  - nested",
  "",
  "1) first",
  "2) second",
  "",
  "| a | b |",
  "| --- | --- |",
  "| x | y |",
  "",
  "---",
  "",
  "Last line.",
].join("\n");

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
  return page.evaluate(
    async (input) => {
      const response = await fetch("/api/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return ((await response.json()) as { id: string }).id;
    },
    { title, markdown },
  );
}

async function serverBody(page: Page, id: string) {
  return page.evaluate(async (pageId) => {
    const response = await fetch(`/api/page/${pageId}`);
    return ((await response.json()) as { markdown: string }).markdown;
  }, id);
}

async function openPage(page: Page, id: string) {
  await page.goto(`/p/${id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible({ timeout: 20_000 });
  return content;
}

/** The caret at the very end of the document, as a click there would put it. */
async function caretToEnd(page: Page) {
  const content = page.getByRole("textbox", { name: "Page content" });
  await content.focus();
  await content.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      last = node as Text;
    }
    if (!last) throw new Error("the page has no text");
    const range = document.createRange();
    range.setStart(last, last.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

test("opening a hand-written note writes nothing, and an edit changes one line", async ({ page }) => {
  await login(page);
  const id = await makePage(page, "Hand-written", HAND_WRITTEN);
  const before = await serverBody(page, id);
  expect(before.trim()).toBe(HAND_WRITTEN);

  const saves: string[] = [];
  await page.route(`**/api/page/${id}`, async (route) => {
    const request = route.request();
    if (request.method() === "PUT") saves.push(request.postData() ?? "");
    await route.continue();
  });

  await openPage(page, id);
  // Longer than the autosave pause: a rewrite on open would have saved by now.
  await page.waitForTimeout(1500);
  expect(saves).toHaveLength(0);
  expect((await serverBody(page, id)).trim()).toBe(HAND_WRITTEN);

  await caretToEnd(page);
  await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith(`/api/page/${id}`) &&
        candidate.request().method() === "PUT" &&
        candidate.ok(),
    ),
    page.keyboard.type(" Edited."),
  ]);

  const after = (await serverBody(page, id)).trim();
  expect(after).toBe(HAND_WRITTEN.replace("Last line.", "Last line. Edited."));
});

test("an empty page mounts, takes typing and saves it", async ({ page }) => {
  await login(page);
  const id = await makePage(page, "Empty", "");
  const content = await openPage(page, id);
  await expect(content.locator("p").first()).toBeAttached();
  await content.click();
  await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith(`/api/page/${id}`) &&
        candidate.request().method() === "PUT" &&
        candidate.ok(),
    ),
    page.keyboard.type("First words"),
  ]);
  expect((await serverBody(page, id)).trim()).toBe("First words");
});

test("Enter after a typed address starts a new paragraph, with no newline inside the old one", async ({ page }) => {
  await login(page);
  const id = await makePage(page, "Enter after link", "Visit");
  const content = await openPage(page, id);
  await caretToEnd(page);
  await page.keyboard.type(" https://example.com/docs");
  await page.keyboard.press("Enter");
  await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith(`/api/page/${id}`) &&
        candidate.request().method() === "PUT" &&
        candidate.ok(),
    ),
    page.keyboard.type("next"),
  ]);
  await expect(content.locator("p").first()).toHaveText("Visit https://example.com/docs");
  expect((await serverBody(page, id)).trim()).toBe("Visit https://example.com/docs\n\nnext");
});

test("a typed address becomes a link and is written bare", async ({ page }) => {
  await login(page);
  const id = await makePage(page, "Typed link", "Visit");
  await openPage(page, id);
  await caretToEnd(page);
  await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith(`/api/page/${id}`) &&
        candidate.request().method() === "PUT" &&
        candidate.ok(),
    ),
    page.keyboard.type(" https://example.com/docs today"),
  ]);

  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content.locator('a[href="https://example.com/docs"]')).toHaveText("https://example.com/docs");
  expect((await serverBody(page, id)).trim()).toBe("Visit https://example.com/docs today");
});
