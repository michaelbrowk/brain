import { expect, test, type Locator, type Page } from "playwright/test";
import { freshNotes } from "./fresh-notes";

freshNotes();

/** Writing on a phone (report-hands #18, bar #6): the writing bar docked above
 *  the keyboard while the caret is in the page, the slash menu's rows and its
 *  place above the keyboard, the caret kept above the keyboard, and the lone
 *  crumb waiting for the head's chip row. Every case is `@mobile`, so it runs
 *  in the Pixel project here and under WebKit with an iPhone profile from the
 *  scratchpad config.
 *
 *  No automation drives a software keyboard, so the keyboard is emulated the
 *  way the app reads it: `visualViewport.height` shrinks by the keyboard's
 *  height and `resize` fires on it. The shell's own tab-bar hide (covered >
 *  120), the bars' dock and the slash menu's room all read that one value. */

const KEYBOARD = 336;

declare global {
  interface Window {
    __brainKeyboard?: (px: number) => void;
  }
}

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

async function emulateKeyboard(page: Page) {
  await page.addInitScript(() => {
    let covered = 0;
    Object.defineProperty(VisualViewport.prototype, "height", {
      configurable: true,
      get: () => window.innerHeight - covered,
    });
    Object.defineProperty(VisualViewport.prototype, "offsetTop", {
      configurable: true,
      get: () => 0,
    });
    window.__brainKeyboard = (px: number) => {
      covered = px;
      window.visualViewport?.dispatchEvent(new Event("resize"));
    };
  });
}

async function keyboard(page: Page, px: number) {
  await page.evaluate((height) => window.__brainKeyboard?.(height), px);
}

async function openPage(page: Page, title: string, markdown: string) {
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
  // The shell re-reads the open page after it opens (the SSE "ready"
  // reconcile, and a replayed change from the file before) and remounts the
  // editor when the body it holds differs from the server's. An edit made
  // inside that window lands on a remount that puts the caret at the top
  // (report-code C9, B5's line). These cases are about the bar, so they
  // start once the page has gone a while without being read again.
  let lastRead = Date.now();
  page.on("response", (response) => {
    if (response.request().method() === "GET" && response.url().endsWith(`/api/page/${id}`))
      lastRead = Date.now();
  });
  await page.goto(`/p/${id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await expect
    .poll(() => Date.now() - lastRead, { timeout: 15_000 })
    .toBeGreaterThan(1_500);
  return { id, content };
}

/** The caret at the end of a line: a click just inside its right edge. The
 *  line is first brought to the upper part of the scroller, clear of the
 *  emulated keyboard and the bar on it, which the layout viewport (and so
 *  `scrollIntoViewIfNeeded`) knows nothing about. */
async function caretAtEnd(line: Locator) {
  await line.evaluate((element) => {
    const scroller = element.closest(".brain-page-scroll");
    if (!scroller) return;
    const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += top - 120;
  });
  const box = await line.boundingBox();
  if (!box) throw new Error("line has no box");
  const width = await line.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().width;
  });
  await line.click({ position: { x: Math.max(1, width - 1), y: box.height / 2 } });
}

function writingBar(page: Page) {
  return page.getByRole("toolbar", { name: "Writing" });
}

function selectionToolbar(page: Page) {
  return page.getByRole("toolbar", { name: "Text formatting" });
}

const shots = (name: string) =>
  `/private/tmp/claude-501/-Users-michaelbrowk-Documents-Me-Projects-Michaelbrowk/d992c703-3f29-46c0-9837-462886bf1cb6/scratchpad/b4-shots/${name}`;

async function viewportHeight(page: Page) {
  return page.evaluate(() => window.innerHeight);
}

/** The element's box once its entrance has settled: framer leaves
 *  `transform: none` on an element that has arrived. */
async function settledBox(element: Locator) {
  await expect
    .poll(() => element.evaluate((node) => getComputedStyle(node).transform))
    .toBe("none");
  return (await element.boundingBox())!;
}

test("@mobile the writing bar docks above the keyboard while the caret is in the page and leaves with the focus", async ({
  page,
}, testInfo) => {
  await emulateKeyboard(page);
  const { content } = await openPage(page, "Phone bar", "- one\n- two\n\nA paragraph");
  await expect(writingBar(page)).toBeHidden();

  await caretAtEnd(content.locator("li", { hasText: "two" }).locator("p"));
  await keyboard(page, KEYBOARD);
  const bar = writingBar(page);
  await expect(bar).toBeVisible();
  await expect(selectionToolbar(page)).toBeHidden();

  // Docked: its bottom edge is the keyboard's top edge, full width.
  const box = await settledBox(bar);
  const innerHeight = await viewportHeight(page);
  expect(Math.round(box.y + box.height)).toBe(innerHeight - KEYBOARD);
  expect(box.width).toBe(390);
  // The shell took the tab bar away for the keyboard; the bar stands alone.
  await expect(page.locator(".brain-mobile-tabbar")).toHaveAttribute("data-hidden", "");

  const labels = await bar.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label")),
  );
  expect(labels).toEqual(["Outdent", "Indent", "Task", "Undo", "Redo", "Slash", "Dismiss keyboard"]);
  for (const button of await bar.getByRole("button").all()) {
    const rect = (await button.boundingBox())!;
    expect(rect.height).toBeGreaterThanOrEqual(36);
    expect(rect.width).toBeGreaterThanOrEqual(36);
  }

  await page.keyboard.type(" words");
  await page.screenshot({ path: shots(`bar-typing-${testInfo.project.name}.png`) });

  await bar.getByRole("button", { name: "Dismiss keyboard" }).click();
  await keyboard(page, 0);
  await expect(bar).toBeHidden();
  expect(await content.evaluate((editor) => editor === document.activeElement)).toBe(false);
});

test("@mobile Indent, Outdent and Undo on the bar act on the caret's line", async ({ page }) => {
  await emulateKeyboard(page);
  const { content } = await openPage(page, "Phone indent", "- one\n- two\n\nA paragraph");
  const bar = writingBar(page);

  await caretAtEnd(content.locator("p", { hasText: "A paragraph" }));
  await keyboard(page, KEYBOARD);
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "Indent" })).toHaveAttribute("aria-disabled", "true");
  await expect(bar.getByRole("button", { name: "Outdent" })).toHaveAttribute("aria-disabled", "true");

  await caretAtEnd(content.locator("li", { hasText: "two" }).locator("p"));
  await expect(bar.getByRole("button", { name: "Indent" })).toHaveAttribute("aria-disabled", "false");
  await bar.getByRole("button", { name: "Indent" }).click();
  await expect(content.locator("ul ul li", { hasText: "two" })).toHaveCount(1);
  // The caret stayed in the line: the next words go after "two".
  await page.keyboard.type(" nested");
  await expect(content.locator("ul ul li")).toHaveText("two nested");

  await bar.getByRole("button", { name: "Undo" }).click();
  await expect(content.locator("ul ul li")).toHaveText("two");
  await bar.getByRole("button", { name: "Outdent" }).click();
  await expect(content.locator("ul ul li")).toHaveCount(0);
  await expect(content.locator("ul > li")).toHaveCount(2);
});

test("@mobile Slash opens the menu above the keyboard, on 44px rows", async ({ page }, testInfo) => {
  await emulateKeyboard(page);
  const filler = Array.from({ length: 14 }, (_, i) => `Filler paragraph ${i}`).join("\n\n");
  const { content } = await openPage(page, "Phone slash", filler);
  const bar = writingBar(page);

  await caretAtEnd(content.locator("p", { hasText: "Filler paragraph 13" }));
  // The bar arrives with the tap; the first key comes after it is there.
  await expect(bar).toBeVisible();
  await page.keyboard.press("Enter");
  await keyboard(page, KEYBOARD);

  await bar.getByRole("button", { name: "Slash" }).click();
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toBeVisible();

  const rows = menu.getByRole("button");
  expect(await rows.count()).toBeGreaterThan(5);
  for (const row of await rows.all()) {
    const rect = (await row.boundingBox())!;
    expect(Math.round(rect.height)).toBeGreaterThanOrEqual(44);
  }

  // Above the keyboard and above the bar: the menu's bottom edge is over the
  // bar's top edge, and its top is on screen.
  const menuBox = await settledBox(menu);
  const barBox = await settledBox(bar);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(barBox.y + 1);
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: shots(`slash-keyboard-${testInfo.project.name}.png`) });

  // The slash the bar typed is a real one: a row picked turns the line.
  await menu.getByRole("button", { name: "Heading 2" }).click();
  await page.keyboard.type("Second");
  await expect(content.locator("h2")).toHaveText("Second");
});

test("@mobile the caret stays above the keyboard while typing", async ({ page }) => {
  await emulateKeyboard(page);
  const filler = Array.from({ length: 30 }, (_, i) => `Para ${i}`).join("\n\n");
  const { content } = await openPage(page, "Phone caret", filler);
  const bar = writingBar(page);

  await caretAtEnd(content.locator("p", { hasText: /^Para 29$/ }));
  await keyboard(page, KEYBOARD);
  await expect(bar).toBeVisible();
  const barBox = await settledBox(bar);

  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Enter");
    await page.keyboard.type(`typed ${i}`);
  }
  const caret = await content.evaluate(() => {
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const line = (node?.nodeType === 1 ? (node as Element) : node?.parentElement)?.closest("p");
    return {
      text: line?.textContent ?? "",
      bottom: line?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
    };
  });
  // The words went where the caret was, at the end of the page, and that
  // line stands above the bar: the band scrolled the page up under it.
  expect(caret.text).toBe("typed 7");
  expect(caret.bottom).toBeLessThanOrEqual(barBox.y);
});

test("@mobile the selection toolbar stacks above the writing bar", async ({ page }, testInfo) => {
  await emulateKeyboard(page);
  const { content } = await openPage(page, "Phone selection", "Select these words here");
  const bar = writingBar(page);

  const line = content.locator("p", { hasText: "Select these words" });
  await caretAtEnd(line);
  await keyboard(page, KEYBOARD);
  await expect(bar).toBeVisible();

  await line.evaluate((element) => {
    const text = element.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 12);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const toolbar = selectionToolbar(page);
  await expect(toolbar).toBeVisible();
  await expect(bar).toBeVisible();

  const toolbarBox = await settledBox(toolbar);
  const barBox = await settledBox(bar);
  expect(Math.round(toolbarBox.y + toolbarBox.height)).toBe(Math.round(barBox.y));
  expect(Math.round(barBox.y + barBox.height)).toBe((await viewportHeight(page)) - KEYBOARD);
  await page.screenshot({ path: shots(`selection-and-bar-${testInfo.project.name}.png`) });
});

test("@mobile the lone crumb waits for the head's chip row", async ({ page }) => {
  const filler = Array.from({ length: 40 }, (_, i) => `Para ${i}`).join("\n\n");
  await openPage(page, "Phone crumb", filler);
  const scroller = page.locator(".brain-page-scroll");
  const crumb = page.locator('.brain-topbar-mobile nav[aria-label="Breadcrumb"]');
  const title = page.getByRole("textbox", { name: "Page title" });
  const chipRow = page.getByRole("button", { name: "+ Category" });
  await expect(crumb).toBeHidden();

  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(800);
  const scrollerTop = (await scroller.boundingBox())!.y;
  const titleBox = (await title.boundingBox())!;
  const rowBox = (await chipRow.boundingBox())!;

  // The title has gone under the band and the chip row has not: no crumb yet.
  const titleOut = titleBox.y + titleBox.height - scrollerTop + 2;
  await scroller.evaluate((el, top) => el.scrollTo({ top }), titleOut);
  await expect
    .poll(async () => (await chipRow.boundingBox())!.y)
    .toBeGreaterThanOrEqual(scrollerTop);
  await page.waitForTimeout(300);
  await expect(crumb).toBeHidden();

  // The row has gone too (its box and the 2px of padding under it): the
  // crumb takes the name.
  const rowOut = rowBox.y + rowBox.height - scrollerTop + 12;
  await scroller.evaluate((el, top) => el.scrollTo({ top }), rowOut);
  await expect(crumb).toBeVisible();
  await expect(crumb).toContainText("Phone crumb");
});
