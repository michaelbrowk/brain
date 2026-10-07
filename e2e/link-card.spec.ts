import { expect, test, type Locator, type Page } from "playwright/test";
import { freshNotes } from "./fresh-notes";

freshNotes();

/** A URL alone on its line is a card (`components/editor/link-preview.ts`).
 *  What the browser decides about the caret around it is what these cases
 *  hold: where Enter goes, where typing lands, how the keyboard gets in and
 *  out, and what a click below a page that ends in one does. The same file runs
 *  under WebKit with an iPhone profile, where the owner first met the bug. */

const URL = "https://example.com/post";

/** Signs in through the route the form posts to. The form is not what these
 *  cases test, and WebKit could take its click before it had hydrated, which
 *  left a case on /login with nothing sent. */
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
  await page.goto("/");
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

/** The caret at the start or end of a line, by clicking just inside its
 *  edge: Home and End scroll the page in WebKit instead of moving the caret. */
async function caretAtEdge(line: Locator, edge: "start" | "end") {
  const box = await line.boundingBox();
  if (!box) throw new Error("line has no box");
  const width = await line.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().width;
  });
  await line.click({ position: { x: edge === "start" ? 1 : Math.max(1, width - 1), y: box.height / 2 } });
}

async function openPage(page: Page, title: string, markdown: string) {
  // The card's preview, answered locally: the run must not depend on a
  // network the machine may not have.
  await page.route("**/api/unfurl**", (route) =>
    route.fulfill({
      json: { title: "Example post", description: "A post on example.com", siteName: "example.com" },
    }),
  );
  await login(page);
  const id = await page.evaluate(
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

/** A paste the way the clipboard delivers a copied address: plain text only. */
async function pasteText(content: Locator, text: string) {
  await content.evaluate((editor, pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    editor.dispatchEvent(event);
  }, text);
}

/** Whether `first` is drawn before `second` in the document. */
async function before(first: Locator, second: Locator) {
  const other = await second.elementHandle();
  return first.evaluate(
    (a, b) => !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    other,
  );
}

async function clickBelow(page: Page, content: Locator, hasTouch: boolean) {
  const box = await content.boundingBox();
  if (!box) throw new Error("editor has no box");
  const x = box.x + 8;
  const y = box.y + box.height + 48;
  if (hasTouch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

test("a URL pasted alone becomes a card and the next words go below it", async ({ page }) => {
  const { id, content } = await openPage(page, "Link card paste", "");
  await content.click();
  await pasteText(content, URL);
  const card = content.locator("a.brain-embed");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Example post");

  await page.keyboard.type("after the card");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line");

  const typed = content.locator("p", { hasText: "after the card" });
  await expect(typed).toBeVisible();
  expect(await before(card, typed)).toBe(true);
  await expect
    .poll(() => savedMarkdown(page, id))
    .toBe(`<${URL}>\n\nafter the card\n\nsecond line`);
});

test("Enter straight after the paste opens a line below the card, not a link above it", async ({
  page,
}) => {
  const { id, content } = await openPage(page, "Link card enter", "");
  await content.click();
  await pasteText(content, URL);
  const card = content.locator("a.brain-embed");
  await expect(card).toHaveCount(1);

  await page.keyboard.press("Enter");
  await page.keyboard.type("next");

  const next = content.locator("p", { hasText: "next" });
  await expect(next).toBeVisible();
  expect(await before(card, next)).toBe(true);
  // The words are words: not a link to the card's URL.
  await expect(next.locator("a")).toHaveCount(0);
  await expect.poll(() => savedMarkdown(page, id)).toMatch(new RegExp(`^<${URL}>\\n\\n[\\s\\S]*\\nnext$`));
});

test("arrow keys select the card on the way past it, and Backspace deletes a selected card", async ({
  page,
}) => {
  const { id, content } = await openPage(page, "Link card arrows", `above\n\n<${URL}>\n\nbelow`);
  const card = content.locator("a.brain-embed");
  await expect(card).toHaveCount(1);

  await caretAtEdge(content.locator("p", { hasText: "above" }), "end");
  await page.keyboard.press("ArrowDown");
  await expect(card).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(card).not.toHaveAttribute("data-selected", "true");
  await page.keyboard.type("Z");
  await expect(content.locator("p", { hasText: "Zbelow" })).toBeVisible();

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await expect(card).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Backspace");
  await expect(card).toHaveCount(0);
  await expect.poll(() => savedMarkdown(page, id)).toBe("above\n\nZbelow");
});

test("Backspace from the line after opens the URL to edit, and leaving it draws the card", async ({
  page,
}) => {
  const { id, content } = await openPage(page, "Link card edit", `<${URL}>\n\nafter`);
  const card = content.locator("a.brain-embed");
  await expect(card).toHaveCount(1);

  await caretAtEdge(content.locator("p", { hasText: "after" }), "start");
  await page.keyboard.press("Backspace");
  await expect(card).toHaveCount(0);
  await expect(content.locator("p", { hasText: URL })).toBeVisible();

  for (let i = 0; i < "post".length; i += 1) await page.keyboard.press("Backspace");
  await page.keyboard.type("page");
  await content.locator("p", { hasText: "after" }).click();

  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("href", "https://example.com/page");
  await expect.poll(() => savedMarkdown(page, id)).toBe("<https://example.com/page>\n\nafter");
});

test("a click below a page that ends in a card writes on the line after it", async ({
  page,
}, testInfo) => {
  const { id, content } = await openPage(page, "Link card tail", `intro\n\n<${URL}>`);
  await expect(content.locator("a.brain-embed")).toHaveCount(1);

  await clickBelow(page, content, !!testInfo.project.use.hasTouch);
  await expect(content).toBeFocused();
  await page.keyboard.type("the end");
  await expect.poll(() => savedMarkdown(page, id)).toBe(`intro\n\n<${URL}>\n\nthe end`);
});

test("a click below the last line of prose puts the caret at its end", async ({
  page,
}, testInfo) => {
  const { id, content } = await openPage(page, "Click below prose", "Only line");
  await expect(content.locator("p", { hasText: "Only line" })).toBeVisible();

  await clickBelow(page, content, !!testInfo.project.use.hasTouch);
  await expect(content).toBeFocused();
  await page.keyboard.type(" and more");
  await expect.poll(() => savedMarkdown(page, id)).toBe("Only line and more");
});

test("words typed after an opened URL stay visible words, not a card", async ({ page }) => {
  const { id, content } = await openPage(page, "Link card words", `<${URL}>\n\nafter`);
  const card = content.locator("a.brain-embed");
  await expect(card).toHaveCount(1);

  await caretAtEdge(content.locator("p", { hasText: "after" }), "start");
  await page.keyboard.press("Backspace");
  await expect(card).toHaveCount(0);
  await page.keyboard.type(" see this");
  await content.locator("p", { hasText: "after" }).click();

  await expect(card).toHaveCount(0);
  await expect(content.locator("p", { hasText: "see this" })).toBeVisible();
  await expect.poll(() => savedMarkdown(page, id)).toContain("see this");
  expect(await savedMarkdown(page, id)).not.toContain("see%20this");
});
