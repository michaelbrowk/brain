import { expect, test, type Locator, type Page } from "playwright/test";
import { freshNotes } from "./fresh-notes";

freshNotes();

/** A web link on words (`components/editor/web-link.ts`, the field in
 *  `floating-toolbar.tsx`). What the browser decides is what these cases
 *  hold: the field over the selection and, on a phone, docked above the
 *  keyboard; the keys that reach it; a click on a link that is already
 *  there; what the file says afterwards. The same file runs under WebKit
 *  with an iPhone profile. */

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

async function openPage(page: Page, title: string, markdown: string) {
  await login(page);
  const id = await createPage(page, title, markdown);
  await page.goto(`/p/${id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  return { id, content };
}

async function savedMarkdown(page: Page, id: string) {
  return page.evaluate(async (pageId) => {
    const response = await fetch(`/api/page/${pageId}`);
    const body = (await response.json()) as { markdown?: string };
    return (body.markdown ?? "").trim();
  }, id);
}

/** `words` selected through the DOM selection ProseMirror reads. Dragging
 *  over a word is a guess at pixels, and a double tap selects one word. */
async function selectWords(content: Locator, words: string) {
  await content.focus();
  await content.page().waitForTimeout(150);
  await content.evaluate((editor, needle) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(needle) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`no text ${needle}`);
  }, words);
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

function toolbarOf(page: Page) {
  return page.getByRole("toolbar", { name: "Text formatting" });
}

test("an address typed into the Link field links the selected words, docked above the keyboard on a phone", async ({
  page,
}, testInfo) => {
  const { id, content } = await openPage(page, "Web link field", "read the spec today");
  await selectWords(content, "the spec");
  const toolbar = toolbarOf(page);
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "Link", exact: true }).click();
  const field = toolbar.getByRole("textbox", { name: "Link" });
  await expect(field).toBeFocused();

  if (testInfo.project.use.hasTouch) {
    // The bar is the keyboard's dock: the full width of the screen, fixed,
    // standing on the bottom of the visual viewport (the keyboard's top once
    // one is up), never floating over the words.
    const box = await toolbar.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error("toolbar has no box");
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(viewport.width);
    expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(viewport.height);
    expect(await toolbar.evaluate((bar) => getComputedStyle(bar).position)).toBe("fixed");
  }

  await field.fill("https://example.com/spec");
  await expect(
    toolbar.getByRole("button", { name: "Link to https://example.com/spec" }),
  ).toBeVisible();
  await page.keyboard.press("Enter");

  await expect
    .poll(() => savedMarkdown(page, id))
    .toBe("read [the spec](https://example.com/spec) today");
  await expect(content.locator("a", { hasText: "the spec" })).toHaveAttribute(
    "href",
    "https://example.com/spec",
  );
  await expect(content).toContainText("read the spec today");
});

test("a URL pasted over selected words links them and keeps them", async ({ page }) => {
  const { id, content } = await openPage(page, "Paste over words", "read the spec today");
  await selectWords(content, "the spec");
  await pasteText(content, "https://example.com/pasted");
  await expect
    .poll(() => savedMarkdown(page, id))
    .toBe("read [the spec](https://example.com/pasted) today");
  await expect(content).toContainText("read the spec today");
});

test("a bare URL typed into the line is a link once the space after it is typed", async ({
  page,
}) => {
  const { id, content } = await openPage(page, "Typed URL", "");
  await content.click();
  await page.keyboard.type("see https://example.com/typed now");
  await expect(content.locator('a[href="https://example.com/typed"]')).toHaveText(
    "https://example.com/typed",
  );
  await expect(content).toContainText("see https://example.com/typed now");
  await expect.poll(() => savedMarkdown(page, id)).toContain("https://example.com/typed");
  expect(await savedMarkdown(page, id)).not.toContain("\\");
});

test("a click on a link opens the field with its address, to change it or take it off the words", async ({
  page,
}, testInfo) => {
  const { id, content } = await openPage(
    page,
    "Edit link",
    "read [the spec](https://example.com/old) today",
  );
  const link = content.locator("a", { hasText: "the spec" });
  const toolbar = toolbarOf(page);
  const field = toolbar.getByRole("textbox", { name: "Link" });

  if (testInfo.project.use.hasTouch) await link.tap();
  else await link.click();
  await expect(field).toHaveValue("https://example.com/old");
  await expect(toolbar.getByRole("button", { name: "Open link" })).toBeVisible();
  await field.fill("https://example.com/new");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => savedMarkdown(page, id))
    .toBe("read [the spec](https://example.com/new) today");

  if (testInfo.project.use.hasTouch) await link.tap();
  else await link.click();
  await expect(field).toHaveValue("https://example.com/new");
  await toolbar.getByRole("button", { name: "Remove link" }).click();
  await expect.poll(() => savedMarkdown(page, id)).toBe("read the spec today");
  await expect(content.locator("a")).toHaveCount(0);
  await expect(content).toContainText("read the spec today");
});

test("Mod-Shift-k opens the field over the selection and not the palette, and Escape gives the words back", async ({
  page,
}) => {
  const { content } = await openPage(page, "Link chord", "read the spec today");
  await selectWords(content, "the spec");
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const field = toolbarOf(page).getByRole("textbox", { name: "Link" });
  await expect(field).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await field.press("Escape");
  await expect(field).toBeHidden();
  await expect(content).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("the spec");
});

test("a page URL pasted or typed into the field over selected words links the words to the page, and a reload keeps them", async ({
  page,
}) => {
  await login(page);
  const targetId = await createPage(page, "Paste target", "");
  const id = await createPage(page, "Page URL over words", "read the spec and the notes today");
  await page.goto(`/p/${id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  const origin = new URL(page.url()).origin;

  await selectWords(content, "the spec");
  await pasteText(content, `${origin}/p/${targetId}`);
  await expect
    .poll(() => savedMarkdown(page, id))
    .toBe(`read [the spec](/p/${targetId}#words) and the notes today`);

  await selectWords(content, "the notes");
  const toolbar = toolbarOf(page);
  await toolbar.getByRole("button", { name: "Link", exact: true }).click();
  const field = toolbar.getByRole("textbox", { name: "Link" });
  await field.fill(`${origin}/p/${targetId}`);
  await page.keyboard.press("Enter");
  await expect
    .poll(() => savedMarkdown(page, id))
    .toBe(`read [the spec](/p/${targetId}#words) and [the notes](/p/${targetId}#words) today`);

  await page.reload();
  const reloaded = page.getByRole("textbox", { name: "Page content" });
  await expect(reloaded).toContainText("read the spec and the notes today");
  await expect(reloaded.locator("a.brain-page-ref")).toHaveCount(0);
});

test("a typed address alone on its line becomes the card a paste makes, on Enter", async ({
  page,
}) => {
  await page.route("**/api/unfurl**", (route) =>
    route.fulfill({
      json: { title: "Example", description: "An example", siteName: "example.com" },
    }),
  );
  const { id, content } = await openPage(page, "Typed card", "");
  await content.click();
  await page.keyboard.type("https://example.com/typed-card");
  await page.keyboard.press("Enter");
  await expect(content.locator("a[data-brain-link-card]")).toHaveCount(1);
  await page.keyboard.type("after");
  await expect
    .poll(() => savedMarkdown(page, id))
    .toMatch(
      /^(<https:\/\/example\.com\/typed-card>|\[https:\/\/example\.com\/typed-card\]\(https:\/\/example\.com\/typed-card\))\n\nafter$/,
    );
});

test("on a read-only page a click on a link opens it, and no field appears", async ({
  page,
  context,
}, testInfo) => {
  test.skip(!!testInfo.project.use.hasTouch, "the popup is the desktop shape of the check");
  await context.route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Example</title>" }),
  );
  // Words straight inside a columns row, outside any column, open the page
  // read-only (editor-tables.spec.ts holds that shape).
  const markdown = [
    "read [the spec](https://example.com/readonly) today",
    "",
    "::::cols",
    "LOOSE WORDS",
    "",
    ":::col",
    "b",
    ":::",
    "::::",
  ].join("\n");
  const { content } = await openPage(page, "Read-only link", markdown);
  await expect(content).toHaveAttribute("aria-readonly", "true");
  const [opened] = await Promise.all([
    context.waitForEvent("page"),
    content.locator("a", { hasText: "the spec" }).click(),
  ]);
  expect(opened.url()).toBe("https://example.com/readonly");
  await opened.close();
  await expect(page).toHaveURL(/\/p\//);
  await expect(toolbarOf(page).getByRole("textbox", { name: "Link" })).toHaveCount(0);
});

test("a modifier click on a link stays the browser's: no field, nothing prevented", async ({
  page,
}, testInfo) => {
  test.skip(!!testInfo.project.use.hasTouch, "a finger holds no modifier");
  const { content } = await openPage(
    page,
    "Open link",
    "read [the spec](https://example.com/open) today",
  );
  const link = content.locator("a", { hasText: "the spec" });
  // Dispatched rather than clicked: the browser would act on the chord, and
  // what this holds is only that Brain stays out of its way. The same
  // contract every link keeps (critical-flows, "without hijacking native
  // links"), read here for a web link on words.
  const prevented = await link.evaluate((anchor) => {
    let wasPrevented: boolean | null = null;
    anchor.addEventListener(
      "click",
      (event) => {
        wasPrevented = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true }),
    );
    return wasPrevented;
  });
  expect(prevented).toBe(false);
  await page.waitForTimeout(300);
  await expect(toolbarOf(page).getByRole("textbox", { name: "Link" })).toHaveCount(0);
});
