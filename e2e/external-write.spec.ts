// A write to the open page from somewhere else: a second browser context
// plays the other device (or an agent) and writes the page through the API
// while the first one has it open. With nothing unsaved in the first, the
// write lands in its live editor in place: the editor element is the same
// one, the caret is still on its words and ⌘Z still takes back the writer's
// own steps. With unsaved text, the page is in conflict, and each of its
// three ways out ends the conflict on the page and leaves it saving again.

import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type TestInfo,
} from "playwright/test";
import { freshNotes } from "./fresh-notes";

freshNotes();

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

/** The other device: its own context and session. */
async function otherDevice(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page);
  return { page, close: () => context.close() };
}

/** A write through the API, the way another device or an agent saves: the
 *  page's current rev, a whole body, and no client id of this tab's. */
async function writeFrom(device: Page, id: string, markdown: string) {
  const status = await device.evaluate(
    async ({ pageId, next }) => {
      const current = (await (await fetch(`/api/page/${pageId}`)).json()) as { rev: string };
      const response = await fetch(`/api/page/${pageId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: next, rev: current.rev }),
      });
      return response.status;
    },
    { pageId: id, next: markdown },
  );
  expect(status).toBe(200);
}

async function openPage(page: Page, id: string) {
  await page.goto(`/p/${id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible({ timeout: 20_000 });
  // A mark on the editor element: a remount builds a new one without it.
  await content.evaluate((element) => {
    element.setAttribute("data-e2e-mount", "first");
  });
  return content;
}

/** The caret right after `needle` inside the editor's text. */
async function caretAfter(content: Locator, needle: string) {
  await content.focus();
  await content.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + text.length);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`no text ${text}`);
  }, needle);
}

async function sameEditor(content: Locator) {
  await expect(content).toHaveAttribute("data-e2e-mount", "first");
}

test("@release a clean external write lands in place: same editor, caret and undo kept", async ({
  page,
  browser,
}) => {
  await login(page);
  const id = await makePage(page, "External in place", "Alpha line.\n\nBeta line.\n\nGamma line.");
  const content = await openPage(page, id);
  const device = await otherDevice(browser);
  try {
    // The writer's own step, saved, then a pause so the next one is its own
    // undo step.
    await caretAfter(content, "Gamma line.");
    await page.keyboard.type(" Mine.");
    await expect.poll(() => serverBody(page, id)).toBe("Alpha line.\n\nBeta line.\n\nGamma line. Mine.");
    await caretAfter(content, "Gam");

    await writeFrom(
      device.page,
      id,
      "Alpha line, edited on the phone.\n\nBeta line.\n\nGamma line. Mine.",
    );

    await expect(content).toContainText("Alpha line, edited on the phone.");
    await sameEditor(content);
    // The caret stayed after "Gam", though the text before it grew.
    await page.keyboard.type("X");
    await expect(content).toContainText("GamXma line. Mine.");

    // ⌘Z takes back the writer's steps, newest first, and never the write.
    await page.keyboard.press("ControlOrMeta+z");
    await expect(content).toContainText("Gamma line. Mine.");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(content).not.toContainText("Mine.");
    await expect(content).toContainText("Alpha line, edited on the phone.");
    await expect
      .poll(() => serverBody(page, id))
      .toBe("Alpha line, edited on the phone.\n\nBeta line.\n\nGamma line.");
  } finally {
    await device.close();
  }
});

/** Unsaved text here meets a write from the other device: this tab's save is
 *  held on the wire until the other write has landed, so it arrives over a
 *  body it has not seen. */
async function intoConflict(page: Page, browser: Browser, title: string) {
  await login(page);
  const id = await makePage(page, title, "Shared base.");
  const content = await openPage(page, id);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  await page.route(`**/api/page/${id}`, async (route) => {
    const request = route.request();
    if (request.method() === "PUT" && held === 0) {
      held += 1;
      await gate;
    }
    await route.continue();
  });
  await caretAfter(content, "Shared base.");
  await page.keyboard.type(" Mine here.");
  await expect.poll(() => held).toBe(1);
  const device = await otherDevice(browser);
  await writeFrom(device.page, id, "Shared base. Theirs from the phone.");
  release();
  await expect(page.getByText("Page changed elsewhere")).toBeVisible({ timeout: 12_000 });
  await expect(content).toContainText("Shared base. Mine here.");
  await page.unroute(`**/api/page/${id}`);
  return { id, content, device };
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  // The pill slides in: the frame is taken once it has arrived.
  await expect(page.locator(".brain-toast-choices")).toHaveCSS("opacity", "1");
  await expect(page.locator(".brain-toast-choices")).toHaveCSS("transform", "none");
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

/** After the way out the page saves an ordinary edit again. */
async function savesAgain(page: Page, content: Locator, id: string, after: string) {
  await caretAfter(content, after);
  await page.keyboard.type(" Again.");
  await expect.poll(() => serverBody(page, id)).toContain(`${after} Again.`);
  await expect(page.getByText("Page changed elsewhere")).toHaveCount(0);
}

test("Keep mine writes the local text over the other version, then the page saves", async ({
  page,
  browser,
}, testInfo) => {
  const { id, content, device } = await intoConflict(page, browser, "Conflict keep mine");
  try {
    await expect(page.getByRole("button", { name: "Keep mine", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Take theirs", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save a copy", exact: true })).toBeVisible();
    await shot(page, testInfo, "conflict-desktop");
    await page.getByRole("button", { name: "Keep mine", exact: true }).click();
    await expect.poll(() => serverBody(page, id)).toBe("Shared base. Mine here.");
    await expect(page.getByText("Page changed elsewhere")).toHaveCount(0);
    await sameEditor(content);
    await savesAgain(page, content, id, "Mine here.");
  } finally {
    await device.close();
  }
});

test("Take theirs puts the other version into the editor in place, then the page saves", async ({
  page,
  browser,
}) => {
  const { id, content, device } = await intoConflict(page, browser, "Conflict take theirs");
  try {
    await page.getByRole("button", { name: "Take theirs", exact: true }).click();
    await expect(content).toContainText("Shared base. Theirs from the phone.");
    await expect(content).not.toContainText("Mine here.");
    await expect(page.getByText("Page changed elsewhere")).toHaveCount(0);
    await sameEditor(content);
    expect(await serverBody(page, id)).toBe("Shared base. Theirs from the phone.");
    await savesAgain(page, content, id, "Theirs from the phone.");
  } finally {
    await device.close();
  }
});

test("Save a copy keeps the local text as a sibling, takes theirs, then the page saves", async ({
  page,
  browser,
}) => {
  const { id, content, device } = await intoConflict(page, browser, "Conflict save a copy");
  try {
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/page") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save a copy", exact: true }).click();
    const copyId = ((await (await created).json()) as { id: string }).id;
    await expect(content).toContainText("Shared base. Theirs from the phone.");
    await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
    await sameEditor(content);
    expect(await serverBody(page, copyId)).toBe("Shared base. Mine here.");
    await expect(page.getByText("Page changed elsewhere")).toHaveCount(0);
    await savesAgain(page, content, id, "Theirs from the phone.");
  } finally {
    await device.close();
  }
});

test("@mobile the conflict's three answers fit a phone and Take theirs works there", async ({
  page,
  browser,
}, testInfo) => {
  const { id, content, device } = await intoConflict(page, browser, "Conflict on a phone");
  try {
    const answers = ["Keep mine", "Take theirs", "Save a copy"].map((name) =>
      page.getByRole("button", { name, exact: true }),
    );
    const viewport = page.viewportSize()!;
    for (const answer of answers) {
      await expect(answer).toBeVisible();
      const box = (await answer.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
    await shot(page, testInfo, "conflict-phone");
    await answers[1].click();
    await expect(content).toContainText("Shared base. Theirs from the phone.");
    await expect(page.getByText("Page changed elsewhere")).toHaveCount(0);
    expect(await serverBody(page, id)).toBe("Shared base. Theirs from the phone.");
  } finally {
    await device.close();
  }
});
