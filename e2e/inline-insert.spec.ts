import { expect, test, type Locator, type Page } from "playwright/test";
import { freshNotes } from "./fresh-notes";

freshNotes();

/** A page link, an attachment and an image go into the line the caret is in
 *  (`components/editor/insert-inline.ts`). What these cases hold is what the
 *  browser decides: where the caret is after the menu or the picker closes,
 *  what the next key types into, and what the file says. The `[[` and
 *  `/image` cases also run under WebKit with an iPhone profile. */

async function login(page: Page) {
  await page.goto("/login");
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "e2e-password" }),
    });
    return response.status;
  });
  expect(status).toBe(200);
}

async function createPage(page: Page, title: string, markdown: string) {
  return page.evaluate(
    async (body) => {
      const response = await fetch("/api/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const created = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !created.id) throw new Error(created.error ?? `HTTP ${response.status}`);
      return created.id;
    },
    { title, markdown },
  );
}

/** A page to link to, with a title the Markdown has to escape, and the page
 *  the case writes on. */
async function openPage(page: Page, title: string, markdown: (targetId: string) => string) {
  await login(page);
  const targetTitle = `Target ${title} a]b *x*`;
  const targetId = await createPage(page, targetTitle, "");
  const id = await createPage(page, title, markdown(targetId));
  await page.goto(`/p/${id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  return { id, content, targetId, targetTitle };
}

async function savedMarkdown(page: Page, id: string) {
  return page.evaluate(async (pageId) => {
    const response = await fetch(`/api/page/${pageId}`);
    const body = (await response.json()) as { markdown?: string };
    return (body.markdown ?? "").trim();
  }, id);
}

/** The caret right before or after `needle` in the editor's text, placed
 *  through the DOM selection ProseMirror reads. Clicking a word's edge is a
 *  guess at pixels, and Home/End scroll the page in WebKit. */
async function caretAt(content: Locator, needle: string, where: "before" | "after") {
  // The focus first, and a beat for it: WebKit lets the editor's own focus
  // handling put the caret back at the start of the page after a selection
  // made in the same task.
  await content.focus();
  await content.page().waitForTimeout(150);
  await content.evaluate(
    (editor, { needle, where }) => {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(needle) ?? -1;
        if (at < 0) continue;
        window.getSelection()?.collapse(node, where === "before" ? at : at + needle.length);
        return;
      }
      throw new Error(`no text ${needle}`);
    },
    { needle, where },
  );
  await content.page().waitForTimeout(50);
}

async function pasteText(content: Locator, text: string) {
  await content.evaluate((editor, pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    editor.dispatchEvent(event);
  }, text);
}

/** The label the serializer writes for a page with no icon, escaped the way
 *  the Markdown writer escapes it. */
function refPattern(targetId: string) {
  return String.raw`\[📄 Target [^\n]*?a\\?\]b \\\*x\\\*\]\(/p/${targetId}\)`;
}

/** Enter runs the row the menu has active, and on a slow engine the menu can
 *  still be filtering an earlier prefix of the query, so Enter waits until
 *  the query's own row leads the list. */
async function runSlash(page: Page, query: string, label: string) {
  await page.keyboard.type(`/${query}`);
  await expect(page.getByTestId("slash-menu").getByRole("button").first()).toHaveAccessibleName(label);
  await page.keyboard.press("Enter");
}

async function pickWikiLink(page: Page, query: string, title: RegExp) {
  await page.keyboard.type(`[[${query}`);
  await expect(page.getByTestId("wikilink-menu").getByRole("button").first()).toHaveAccessibleName(title);
  await page.keyboard.press("Enter");
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("@inline [[ in the middle of a sentence puts the link there and keeps one line", async ({ page }) => {
  const { id, content, targetId } = await openPage(page, "Wiki mid", () => "alpha omega");
  await caretAt(content, "omega", "before");
  await pickWikiLink(page, "Target Wiki mid", /Target Wiki mid/);
  await page.keyboard.type("and ");

  await expect(content.locator("p")).toHaveCount(1);
  await expect(content.locator("p a.brain-page-ref")).toHaveCount(1);
  await expect
    .poll(() => savedMarkdown(page, id))
    .toMatch(new RegExp(`^alpha ${refPattern(targetId)}and omega$`));
});

test("[[ in a table cell stays in that cell", async ({ page }) => {
  const { id, content, targetId } = await openPage(
    page,
    "Wiki cell",
    () => "| h | g |\n| - | - |\n| one | two |",
  );
  await caretAt(content, "one", "after");
  await page.keyboard.type(" ");
  await pickWikiLink(page, "Target Wiki cell", /Target Wiki cell/);
  // The link ends the cell's line, and the caret after it still takes keys.
  await page.keyboard.type(" tail");

  await expect(content.locator("td a.brain-page-ref")).toHaveCount(1);
  await expect
    .poll(() => savedMarkdown(page, id))
    .toMatch(new RegExp(`\\| one ${refPattern(targetId)} tail *\\| two *\\|`));
  // One table: one delimiter row.
  expect((await savedMarkdown(page, id)).match(/^\| *-/gm)).toHaveLength(1);
});

test("@inline [[ on an empty list item keeps the next words in that item", async ({ page }) => {
  const { id, content, targetId } = await openPage(page, "Wiki item", () => "* first\n* X\n* last");
  await caretAt(content, "X", "after");
  await page.keyboard.press("Backspace");
  await pickWikiLink(page, "Target Wiki item", /Target Wiki item/);
  await page.keyboard.type("tail");

  await expect
    .poll(() => savedMarkdown(page, id))
    // The list was written tight, and it stays tight.
    .toMatch(new RegExp(`^\\* first\\n\\* ${refPattern(targetId)} tail\\n\\* last$`));
});

test("@inline text composed on the line after a picked page stays when the caret leaves", async ({
  page,
}, testInfo) => {
  const { id, content, targetId } = await openPage(page, "Wiki compose", () => "Intro\n\nX\n\nOutro");
  await caretAt(content, "X", "after");
  await page.keyboard.press("Backspace");
  await pickWikiLink(page, "Target Wiki compose", /Target Wiki compose/);
  // An input method's text: a composition the editor reads when it ends,
  // not keys. The line it lands on is the one the editor added for the caret.
  await content.evaluate((editor) =>
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" })),
  );
  await page.keyboard.insertText("日本語");
  await content.evaluate((editor) =>
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本語" })),
  );
  await page.waitForTimeout(300);
  const intro = content.locator("p", { hasText: "Intro" });
  if (testInfo.project.use.hasTouch) await intro.tap();
  else await intro.click();

  await expect
    .poll(() => savedMarkdown(page, id))
    .toMatch(new RegExp(`^Intro\\n\\n${refPattern(targetId)}\\n\\n日本語\\n\\nOutro$`));
});

test("a page URL pasted into a code block stays the address, not nothing", async ({ page }) => {
  const { id, content, targetId } = await openPage(page, "Paste code", () => "```\ncode\n```");
  await caretAt(content, "code", "after");
  const origin = new URL(page.url()).origin;
  await pasteText(content, `${origin}/p/${targetId}`);
  await expect.poll(() => savedMarkdown(page, id)).toContain(`code${origin}/p/${targetId}`);
});

test("Link to page over selected words keeps the words as the link", async ({ page }) => {
  const { id, content, targetId } = await openPage(page, "Toolbar link", () => "read the spec today");
  await content.focus();
  await content.evaluate((editor) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode()!;
    const text = node.textContent ?? "";
    const range = document.createRange();
    range.setStart(node, text.indexOf("the spec"));
    range.setEnd(node, text.indexOf("the spec") + "the spec".length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole("button", { name: "Link", exact: true }).click();
  await page.getByRole("textbox", { name: "Link" }).fill("Target Toolbar");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => savedMarkdown(page, id))
    .toBe(`read [the spec](/p/${targetId}#words) today`);
  await page.reload();
  const reloaded = page.getByRole("textbox", { name: "Page content" });
  const words = reloaded.locator("a", { hasText: "the spec" });
  await expect(words).toHaveAttribute("href", `/p/${targetId}#words`);
  await expect(reloaded).toContainText("read the spec today");
  // The words open their page in the app, as a ref does.
  await words.click();
  await expect(page).toHaveURL(`/p/${targetId}`);
});

test("a page URL pasted mid-sentence becomes a link in that sentence", async ({ page }) => {
  const { id, content, targetId } = await openPage(page, "Paste mid", () => "alpha omega");
  await caretAt(content, "omega", "before");
  const origin = new URL(page.url()).origin;
  await pasteText(content, `${origin}/p/${targetId}`);
  await page.keyboard.type("and ");

  await expect(content.locator("p")).toHaveCount(1);
  await expect
    .poll(() => savedMarkdown(page, id))
    .toMatch(new RegExp(`^alpha ${refPattern(targetId)}and omega$`));
});

test("@inline Enter with the caret before a page row writes on a line below it", async ({ page }) => {
  const { id, content, targetId } = await openPage(
    page,
    "Row enter",
    (target) => `Intro\n\n[📄 Row](/p/${target})\n\nOutro`,
  );
  const row = content.locator("p", { has: page.locator("a.brain-page-ref") });
  await expect(row).toHaveCount(1);
  // The same beat as `caretAt`: WebKit's focus handling would otherwise put
  // the caret back at the start of the page.
  await content.focus();
  await page.waitForTimeout(150);
  await row.evaluate((line) => window.getSelection()?.collapse(line, 0));
  await page.waitForTimeout(50);
  await page.keyboard.press("Enter");
  await page.keyboard.type("below");

  await expect
    .poll(() => savedMarkdown(page, id))
    .toMatch(new RegExp(`^Intro\\n\\n${refPattern(targetId)}\\n\\nbelow\\n\\nOutro$`));
});

test("@inline /image leaves the caret after the image, and typing keeps it", async ({ page }) => {
  const { id, content } = await openPage(page, "Slash image", () => "first");
  await caretAt(content, "first", "after");
  await page.keyboard.press("Enter");
  const chooser = page.waitForEvent("filechooser");
  await runSlash(page, "image", "Image");
  await (await chooser).setFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG });

  const image = content.locator("figure.brain-image");
  await expect(image.first()).toBeVisible();
  await page.keyboard.type("after");

  await expect(image.first()).toBeVisible();
  await expect
    .poll(() => savedMarkdown(page, id))
    .toMatch(/^first\n\n!\[\]\([^)]+\)\n\nafter$/);
});

test("/file leaves the caret after the attachment's label", async ({ page }) => {
  const { id, content } = await openPage(page, "Slash file", () => "first");
  await caretAt(content, "first", "after");
  await page.keyboard.press("Enter");
  const chooser = page.waitForEvent("filechooser");
  await runSlash(page, "file", "File");
  await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });

  await expect(content.locator("a", { hasText: "notes.txt" })).toBeVisible();
  await page.keyboard.type(" more");

  await expect
    .poll(() => savedMarkdown(page, id))
    .toMatch(/^first\n\n\[📎 notes\.txt\]\([^)]+\) more$/);
});

test("/columns puts the first words in the left column", async ({ page }) => {
  const { id, content } = await openPage(page, "Slash columns", () => "first");
  await caretAt(content, "first", "after");
  await page.keyboard.press("Enter");
  await runSlash(page, "columns", "Columns");
  await page.keyboard.type("left words");

  await expect(content.locator('div[data-col="true"]').first()).toContainText("left words");
  await expect
    .poll(() => savedMarkdown(page, id))
    .toMatch(/^first\n\n::::cols\n:::col\nleft words\n:::\n/);
});

test("a Cyrillic query keeps the slash menu open and filters it", async ({ page }) => {
  const { content } = await openPage(page, "Slash cyrillic", () => "first");
  await caretAt(content, "first", "after");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/фото");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button")).toHaveText(["Image"]);
});
