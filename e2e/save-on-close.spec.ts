// Text typed just before a tab closes, navigates away or is frozen in the
// background has to reach the server, whatever save is already queued and
// however long the page is. The ordinary save made at that moment dies with
// the page, so these cases hold or drop it on purpose and look for the
// newest body on the server afterwards.

import { expect, test, type Locator, type Page, type Route } from "playwright/test";
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

async function openPage(page: Page, id: string) {
  await page.goto(`/p/${id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible({ timeout: 20_000 });
  return content;
}

/** The caret at the very end of the document, as a click there would put it. */
async function caretToEnd(content: Locator) {
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

/** A PUT that carries a full body is the ordinary save; a closing tab's save
 *  carries spans instead. */
function isOrdinarySave(route: Route) {
  const request = route.request();
  return (
    request.method() === "PUT" &&
    typeof (request.postDataJSON() as { markdown?: unknown }).markdown === "string"
  );
}

async function hideTab(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function showTab(page: Page) {
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("@release @webkit leaving mid-save sends the newest text, not only the queued save", async ({
  page,
}) => {
  await login(page);
  const id = await makePage(page, "Leave mid-save", "Base body.");
  const content = await openPage(page, id);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let closingSaves = 0;
  await page.route(`**/api/page/${id}`, async (route) => {
    if (isOrdinarySave(route)) {
      // The older save is on the wire and never arrives: the page leaves
      // while it waits.
      markHeld();
      await gate;
      await route.abort().catch(() => {});
      return;
    }
    if (route.request().method() === "PUT") closingSaves += 1;
    await route.continue();
  });

  await caretToEnd(content);
  await page.keyboard.type(" One.");
  await held;
  await page.keyboard.type(" Two.");
  await page.goto("/");

  await expect.poll(() => serverBody(page, id)).toBe("Base body. One. Two.");
  expect(closingSaves).toBe(1);
  release();
  await page.unroute(`**/api/page/${id}`);
});

test("closing the tab mid-save sends the newest text", async ({ page, context }) => {
  await login(page);
  const id = await makePage(page, "Close mid-save", "Base body.");
  const content = await openPage(page, id);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  await page.route(`**/api/page/${id}`, async (route) => {
    if (isOrdinarySave(route)) {
      markHeld();
      await gate;
      await route.abort().catch(() => {});
      return;
    }
    await route.continue();
  });

  await caretToEnd(content);
  await page.keyboard.type(" One.");
  await held;
  await page.keyboard.type(" Two.");
  // The older save stays held. Interception ends here: a request a closing
  // page sends cannot be continued by a route whose page is gone, and the
  // browser, not the test, has to carry it from now on.
  await page.unroute(`**/api/page/${id}`);
  await page.close({ runBeforeUnload: true });

  const reader = await context.newPage();
  await reader.goto("/");
  await expect.poll(() => serverBody(reader, id)).toBe("Base body. One. Two.");
  release();
});

test("@webkit a page over 64 KiB still leaves with the last words typed", async ({
  page,
}) => {
  await login(page);
  const long = `${"A paragraph of an old and very long page, kept for years.\n\n".repeat(1_800)}The end`;
  expect(Buffer.byteLength(long)).toBeGreaterThan(64 * 1024);
  const id = await makePage(page, "Long page", long);
  const content = await openPage(page, id);
  await expect(content).toContainText("The end");

  const closingBytes: number[] = [];
  await page.route(`**/api/page/${id}`, async (route) => {
    if (isOrdinarySave(route)) {
      await route.abort();
      return;
    }
    if (route.request().method() === "PUT") {
      closingBytes.push(Buffer.byteLength(route.request().postData() ?? ""));
    }
    await route.continue();
  });

  await caretToEnd(content);
  await page.keyboard.type(" and the last words");
  await page.goto("/");

  await expect
    .poll(() => serverBody(page, id))
    .toBe(`${long} and the last words`);
  expect(closingBytes).toHaveLength(1);
  expect(closingBytes[0]).toBeLessThan(64 * 1024);
  await page.unroute(`**/api/page/${id}`);
});

test("@webkit a hidden tab whose ordinary requests never leave still saves", async ({
  page,
}) => {
  await login(page);
  const id = await makePage(page, "Frozen tab", "Before switching apps.");
  const content = await openPage(page, id);

  let release!: () => void;
  const frozen = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/page/${id}`, async (route) => {
    if (isOrdinarySave(route)) {
      await frozen;
      await route.abort().catch(() => {});
      return;
    }
    await route.continue();
  });

  await caretToEnd(content);
  await page.keyboard.type(" Typed, then the app switched.");
  await hideTab(page);

  await expect
    .poll(() => serverBody(page, id))
    .toBe("Before switching apps. Typed, then the app switched.");
  release();
  await page.unroute(`**/api/page/${id}`);
  await showTab(page);
});

test("an older save that lands after the closing save is not read as a conflict", async ({
  page,
}) => {
  await login(page);
  const id = await makePage(page, "Hidden and back", "Base body.");
  const content = await openPage(page, id);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let holding = true;
  await page.route(`**/api/page/${id}`, async (route) => {
    if (holding && isOrdinarySave(route)) {
      holding = false;
      markHeld();
      await gate;
    }
    await route.continue();
  });

  await caretToEnd(content);
  await page.keyboard.type(" One.");
  await held;
  await page.keyboard.type(" Two.");
  await hideTab(page);
  await expect.poll(() => serverBody(page, id)).toBe("Base body. One. Two.");

  // The tab comes back, and the older request reaches the server now, behind
  // the newer body the tab sent itself.
  await showTab(page);
  release();
  await page.waitForTimeout(2_000);
  await expect(page.getByRole("button", { name: "Save a copy" })).toHaveCount(0);
  expect(await serverBody(page, id)).toBe("Base body. One. Two.");

  await caretToEnd(content);
  await page.keyboard.type(" Three.");
  await expect
    .poll(() => serverBody(page, id))
    .toBe("Base body. One. Two. Three.");
  await expect(page.getByRole("button", { name: "Save a copy" })).toHaveCount(0);
  await page.unroute(`**/api/page/${id}`);
});

test("a save that keeps failing is retried with backoff and the owner is told", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  const id = await makePage(page, "Failing saves", "Base body.");
  const content = await openPage(page, id);

  // Two whole rounds of three attempts are refused; nothing is typed after.
  let refusals = 6;
  await page.route(`**/api/page/${id}`, async (route) => {
    if (isOrdinarySave(route) && refusals > 0) {
      refusals -= 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary failure" }),
      });
      return;
    }
    await route.continue();
  });

  await caretToEnd(content);
  await page.keyboard.type(" Saved in the end.");
  await expect(page.getByText("Couldn't save. Your draft is safe.")).toBeVisible({
    timeout: 15_000,
  });

  await expect
    .poll(() => serverBody(page, id), { timeout: 60_000 })
    .toBe("Base body. Saved in the end.");
  expect(refusals).toBe(0);
  await page.unroute(`**/api/page/${id}`);
});

test("Smart sort applied while a save is out and the tab hides still saves the sorted page", async ({
  page,
}) => {
  await login(page);
  const id = await makePage(page, "Sort in the window", "Body");
  const children: string[] = [];
  for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) {
    children.push(
      await page.evaluate(
        async (input) => {
          const response = await fetch("/api/page", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          });
          return ((await response.json()) as { id: string }).id;
        },
        { parentId: id, title },
      ),
    );
  }
  const sections = ["First", "Second"];
  await page.route("**/api/smart-sort", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sections,
        assignments: Object.fromEntries(
          children.map((child, index) => [child, sections[index % 2]]),
        ),
        order: children,
        count: children.length,
      }),
    });
  });
  const content = await openPage(page, id);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let holding = true;
  await page.route(`**/api/page/${id}`, async (route) => {
    if (holding && isOrdinarySave(route)) {
      holding = false;
      markHeld();
      await gate;
    }
    await route.continue();
  });

  // A typed edit is on the wire; Smart sort queues its rewrite behind it;
  // then the tab hides and the typed edit also leaves as a closing save.
  await caretToEnd(content);
  await page.keyboard.type(" typed");
  await held;
  await page.getByRole("button", { name: "Smart sort" }).click();
  const dialog = page.getByRole("dialog", { name: "Smart sort" });
  await expect(dialog.getByRole("status")).toHaveText(
    "2 sections proposed. Nothing saved yet.",
  );
  await dialog.getByRole("button", { name: "Apply" }).click();
  await hideTab(page);
  await expect.poll(() => serverBody(page, id)).toBe("Body typed");
  await showTab(page);
  release();

  // The rewrite is newer than the closing save and must not be dropped as
  // stale behind it.
  await expect(page.getByRole("dialog", { name: "Smart sort" })).toHaveCount(0);
  await expect(page.getByText("Couldn't save the sorted page. Try again.")).toHaveCount(0);
  await expect.poll(() => serverBody(page, id)).toContain("## First");
  await page.unroute(`**/api/page/${id}`);
});
