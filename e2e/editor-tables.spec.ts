import { expect, test, type Page } from "playwright/test";
import { freshNotes } from "./fresh-notes";

freshNotes();

/** Images in inline content, and the keys and pastes a table cell takes.
 *  Each case is something only a browser decides: where the focus goes after
 *  Tab, where the caret is after Enter, what a real paste event carries
 *  through the editor's own capture handler. */

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

async function openPage(page: Page, title: string, markdown: string) {
  const id = await page.evaluate(
    async (body) => {
      const response = await fetch("/api/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !json.id) throw new Error(json.error ?? "create failed");
      return json.id;
    },
    { title, markdown },
  );
  await page.goto(`/p/${id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  return { id, content };
}

async function stored(page: Page, id: string) {
  return page.evaluate(async (pageId) => {
    const response = await fetch(`/api/page/${pageId}`);
    return ((await response.json()) as { markdown?: string }).markdown ?? "";
  }, id);
}

/** The caret at the end of the text of `selector`'s first match. */
async function caretAtEnd(page: Page, selector: string) {
  await page.locator(selector).first().evaluate((element) => {
    const editor = element.closest<HTMLElement>('[contenteditable="true"]');
    editor?.focus();
    // In the last text node itself: a position after a cell's paragraph
    // resolves to the start of the next cell.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    while (walker.nextNode()) last = walker.currentNode as Text;
    if (!last) throw new Error("no text to put the caret in");
    const range = document.createRange();
    range.setStart(last, last.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  // ProseMirror reads a DOM selection on selectionchange, a tick later.
  await page.waitForTimeout(50);
}

const editorHasFocus = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Page content",
  );

const TABLE = ["| h1 | h2 |", "| -- | -- |", "| a1 | a2 |", "| b1 | b2 |"].join("\n");

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("an image in a heading or a table cell loads, shows and saves unchanged", async ({ page }) => {
  const src = "/_attachments/inline.png";
  const markdown = [
    `## Shot ![s](${src}) here`,
    "",
    "| a | b |",
    "| - | - |",
    `| x ![i](${src}) | y |`,
    "",
    "tail",
  ].join("\n");
  const { id, content } = await openPage(page, "Images inline", markdown);
  await expect(content.locator("h2")).toContainText("Shot");
  await expect(content.locator("h2 img[src]")).toHaveCount(1);
  await expect(content.locator("td img[src]")).toHaveCount(1);
  await expect(content.locator("td").first()).toContainText("x");
  await expect(content).toBeVisible();
  expect(await content.getAttribute("contenteditable")).toBe("true");

  await caretAtEnd(page, '.ProseMirror p:has-text("tail")');
  await page.keyboard.type(" more");
  await expect.poll(() => stored(page, id)).toContain("tail more");
  const saved = await stored(page, id);
  expect(saved).toContain(`## Shot ![s](${src}) here`);
  expect(saved).toContain(`x ![i](${src})`);
});

test("Tab indents in a code block, adds a row on the last cell and never leaves the page", async ({ page }) => {
  const markdown = ["```", "if (x) {", "run();", "}", "```", "", TABLE, "", "prose"].join("\n");
  const { id, content } = await openPage(page, "Tab keys", markdown);

  await caretAtEnd(page, ".ProseMirror pre code");
  await page.keyboard.press("Tab");
  await page.keyboard.type("x");
  expect(await editorHasFocus(page)).toBe(true);
  await expect(content.locator("pre")).toContainText("}  x");

  await caretAtEnd(page, '.ProseMirror td:has-text("b2")');
  await page.keyboard.press("Tab");
  expect(await editorHasFocus(page)).toBe(true);
  await page.keyboard.type("new row");
  await expect(content.locator("tr")).toHaveCount(4);
  await expect(content.locator("tr").last()).toContainText("new row");

  await caretAtEnd(page, '.ProseMirror p:has-text("prose")');
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await editorHasFocus(page)).toBe(true);
  await page.keyboard.type("!");
  await expect.poll(() => stored(page, id)).toContain("prose!");
  const saved = await stored(page, id);
  expect(saved).toContain("}  x");
  expect(saved).toMatch(/\| new row\s*\|/);
});

test("Enter in a cell is a new line in that cell", async ({ page }) => {
  const { id, content } = await openPage(page, "Enter in cell", TABLE);
  await caretAtEnd(page, '.ProseMirror td:has-text("a1")');
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect(content.locator(".milkdown-table-block")).toHaveCount(1);
  await expect(content.locator('td:has-text("a1")')).toContainText("second");
  await expect.poll(() => stored(page, id)).toContain("a1<br>second");
});

test("a paste into a cell fills cells from the caret or stays in the cell", async ({ page }) => {
  const { id, content } = await openPage(page, "Paste in cell", TABLE);
  const paste = (text: string) =>
    page.evaluate((plain) => {
      const data = new DataTransfer();
      data.setData("text/plain", plain);
      document.activeElement?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);

  await caretAtEnd(page, '.ProseMirror td:has-text("a2")');
  await paste("x1\tx2\ny1\ty2\nz1\tz2");
  await expect(content.locator(".milkdown-table-block")).toHaveCount(1);
  await expect(content.locator("tr")).toHaveCount(4);
  await expect(content.locator("tr").nth(1)).toContainText("x2");

  await caretAtEnd(page, '.ProseMirror td:has-text("a1")');
  await paste("one\ntwo");
  await expect(content.locator(".milkdown-table-block")).toHaveCount(1);
  await expect(content.locator('td:has-text("a1")')).toContainText("two");
  await expect(content.locator('td:has-text("b1")')).toHaveCount(1);
  await expect.poll(() => stored(page, id)).toContain("a1one<br>two");
  expect(await stored(page, id)).toMatch(/\| b1\s*\| y1\s*\| y2\s*\|/);
});
