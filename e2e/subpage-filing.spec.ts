// Filing an unreferenced child into its parent's Markdown.
//
// A page created under a parent through MCP is a direct child the parent's
// body does not link, so it renders in the derived tail below the editor and
// nothing in the document represents it — which is why it cannot be moved.
// Part of the compact release gate (@release): the mechanism is a real drag
// through Milkdown's own external-drop path, and this editor's drag work has
// broken before in ways only a real gesture caught.
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
        body: text ? (JSON.parse(text) as unknown) : null,
      };
    },
    { path: requestPath, requestInit: init },
  );
}

/** The derived tail is a list of direct children the body does not link — a
 *  page added through MCP lands there and cannot be reordered, because there
 *  is no block in the document to move. Dragging a row in writes the
 *  reference, and the existing derivation then drops the row. */
async function carryUnfiledChild(
  page: Page,
  childId: string,
  target: { x: number; y: number },
  steps = 24,
) {
  const row = page.locator(
    `[data-derived-page-refs] a.brain-page-ref[data-page-ref="${childId}"]`,
  );
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Missing tail row geometry");

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Cross Chromium's drag threshold before heading up into the document, and
  // wait for the row to say the drag really started.
  await page.mouse.move(startX + 12, startY - 10, { steps: 5 });
  await expect(row).toHaveAttribute("data-dragging", "true");
  await page.mouse.move(target.x, target.y, { steps });
  await page.mouse.move(target.x, target.y + 1, { steps: 2 });
  return row;
}

async function dragUnfiledChild(
  page: Page,
  childId: string,
  target: { x: number; y: number },
) {
  await carryUnfiledChild(page, childId, target);
  // The same block indicator the editor draws for its own block drags.
  const indicator = page.locator(".brain-drop-cursor");
  await expect(indicator).toBeVisible();
  await expect(page.locator("[data-file-refused]")).toHaveCount(0);
  await page.mouse.up();
  await expect(indicator).toHaveCount(1);
  await expect(indicator).toBeHidden();
}

/** Where each needle sits in the saved Markdown — a page filed under a
 *  heading has to land inside that heading's section, not merely somewhere. */
function markdownOrder(markdown: string, needles: string[]) {
  return needles.map((needle) => markdown.indexOf(needle));
}

interface FiledFlash {
  id: string;
  animation: string;
}

/** The confirming flash is 600ms of a decoration the plugin then takes back
 *  off, so an assertion can arrive after it. Record what the document said
 *  while it was saying it — and, just as much, record that it said nothing. */
async function watchFiledFlash(page: Page) {
  await page.evaluate(() => {
    const seen: { id: string; animation: string }[] = [];
    (window as unknown as { __filedFlash: typeof seen }).__filedFlash = seen;
    const sweep = () => {
      for (const block of document.querySelectorAll<HTMLElement>(
        ".ProseMirror p.brain-page-ref-filed",
      )) {
        const id = block
          .querySelector("a[data-page-ref]")
          ?.getAttribute("data-page-ref");
        if (!id || seen.some((entry) => entry.id === id)) continue;
        seen.push({ id, animation: getComputedStyle(block).animationName });
      }
    };
    new MutationObserver(sweep).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    sweep();
  });
}

function filedFlashes(page: Page): Promise<FiledFlash[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __filedFlash: FiledFlash[] }).__filedFlash ?? [],
  );
}

test("@release an unreferenced child is filed by dragging it into the page or through its row menu", async ({
  page,
}) => {
  await login(page);
  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      title: "Filing",
      markdown: "# Reading\n\nRead this first.\n\n# Writing\n\nWrite this later.",
    },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };
  const children: Record<string, string> = {};
  for (const title of ["Verbs", "Nouns"]) {
    const response = await browserJson(page, "/api/page", {
      method: "POST",
      body: { parentId: parent.id, title },
    });
    expect(response.ok).toBeTruthy();
    children[title] = (response.body as { id: string }).id;
  }

  await page.goto(`/p/${parent.id}`);
  const tail = page.locator("[data-derived-page-refs]");
  const inDocument = (id: string) =>
    page.locator(`.ProseMirror a.brain-page-ref[data-page-ref="${id}"]`);
  const inTail = (id: string) =>
    tail.locator(`a.brain-page-ref[data-page-ref="${id}"]`);
  await expect(tail.locator("a.brain-page-ref")).toHaveCount(2);
  await expect(inDocument(children.Verbs)).toHaveCount(0);
  await watchFiledFlash(page);

  // Drop into the Reading section: just under its paragraph, near the left
  // edge, which is where the indicator measures its candidate boundaries.
  const reading = page.locator(".ProseMirror p", { hasText: "Read this first." });
  const readingBox = await reading.boundingBox();
  expect(readingBox).not.toBeNull();
  if (!readingBox) throw new Error("Missing Reading section geometry");

  const dragSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${parent.id}`) &&
      response.request().method() === "PUT",
  );
  await dragUnfiledChild(page, children.Verbs, {
    x: readingBox.x + 8,
    y: readingBox.y + readingBox.height + 2,
  });

  // The reference is in the document, so the derivation drops the row: one
  // entity, one place, no new state anywhere.
  await expect(inDocument(children.Verbs)).toHaveCount(1);
  // The block that arrived says so. The hook is the filing, not the selection
  // that comes with it — the plugin decorates the block it wrote, and the
  // last test in this file picks an already-filed block up to show the
  // difference.
  await expect
    .poll(() => filedFlashes(page))
    .toEqual([{ id: children.Verbs, animation: "brain-page-ref-filed" }]);
  // And it is taken back off: the flash is what just happened, not a mark the
  // block keeps.
  await expect(page.locator(".ProseMirror p.brain-page-ref-filed")).toHaveCount(
    0,
  );
  await expect(inTail(children.Verbs)).toHaveCount(0);
  await expect(inTail(children.Nouns)).toHaveCount(1);
  expect((await dragSaved).ok()).toBe(true);

  // The row menu is the path for a reader who cannot drag, and for a phone.
  await inTail(children.Nouns).focus();
  await page.keyboard.press("Tab");
  const trigger = page.locator(`[data-file-page-trigger="${children.Nouns}"]`);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // The page's own sections first; "end of page" moves nothing here, so it is
  // never what Enter lands on.
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Reading",
    "Writing",
    "End of page",
  ]);
  const menuSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/page/${parent.id}`) &&
      response.request().method() === "PUT",
  );
  await menu.getByRole("menuitem", { name: "Writing" }).press("Enter");
  await expect(inDocument(children.Nouns)).toHaveCount(1);

  // The row that carried the menu unmounts a moment later. Radix would hand
  // focus back to it and land the reader on <body>; the caret belongs in the
  // document, on the block that was just written.
  await expect
    .poll(() =>
      page.evaluate(
        () => !!document.activeElement?.closest(".milkdown .ProseMirror"),
      ),
    )
    .toBe(true);
  // And it is said out loud, because nothing else about this is audible.
  await expect(page.locator("[data-filing-status]")).toHaveText(
    "Nouns filed under Writing",
  );
  // The menu path confirms itself the same way the drag does — one mechanism,
  // reached two ways.
  await expect
    .poll(() => filedFlashes(page))
    .toEqual([
      { id: children.Verbs, animation: "brain-page-ref-filed" },
      { id: children.Nouns, animation: "brain-page-ref-filed" },
    ]);
  expect((await menuSaved).ok()).toBe(true);

  // Nothing is left to file, so the tail is gone entirely.
  await expect(tail).toHaveCount(0);

  // A page the body already links must not be written a second time. The tail
  // row outlives the drop by one serialization window, so a repeated gesture
  // in that window is real; the editor answers it by doing nothing.
  await page.evaluate(
    ({ id }) => {
      window.dispatchEvent(
        new CustomEvent("brain:file-page-ref", {
          detail: { id, label: "📄 Verbs", headingIndex: null },
        }),
      );
    },
    { id: children.Verbs },
  );
  await page.waitForTimeout(300);
  await expect(inDocument(children.Verbs)).toHaveCount(1);

  const saved = (
    await browserJson(page, `/api/page/${parent.id}`)
  ).body as { markdown: string };
  const positions = markdownOrder(saved.markdown, [
    "# Reading",
    "Read this first.",
    `(/p/${children.Verbs})`,
    "# Writing",
    "Write this later.",
    `(/p/${children.Nouns})`,
  ]);
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);

  // A reload proves the placement is the document, not a view: both rows come
  // back inside the editor and the tail stays empty.
  await page.reload();
  await expect(inDocument(children.Verbs)).toHaveCount(1);
  await expect(inDocument(children.Nouns)).toHaveCount(1);
  await expect(tail).toHaveCount(0);
});

test("@release a drag the editor will not take says so before the release", async ({
  page,
}) => {
  await login(page);
  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      title: "Filing twice",
      markdown: "# Reading\n\nRead this first.\n\n# Writing\n\nWrite this later.",
    },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };
  const childResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: "Verbs" },
  });
  expect(childResponse.ok).toBeTruthy();
  const verbs = (childResponse.body as { id: string }).id;

  await page.goto(`/p/${parent.id}`);
  const inDocument = page.locator(
    `.ProseMirror a.brain-page-ref[data-page-ref="${verbs}"]`,
  );
  await expect(
    page.locator(`[data-derived-page-refs] a[data-page-ref="${verbs}"]`),
  ).toHaveCount(1);

  const reading = page.locator(".ProseMirror p", { hasText: "Read this first." });
  const readingBox = await reading.boundingBox();
  expect(readingBox).not.toBeNull();
  if (!readingBox) throw new Error("Missing Reading section geometry");

  // Start the drag while the page is still missing from the body, so the
  // indicator draws where it would for any block drag.
  await carryUnfiledChild(page, verbs, {
    x: readingBox.x + 8,
    y: readingBox.y + readingBox.height + 2,
  });
  await expect(page.locator(".brain-drop-cursor")).toBeVisible();

  // Now file it under the drag — the same event the row menu sends. The tail
  // row outlives that write by one serialization window, so what is in flight
  // is a real second gesture on a page the body already links.
  await page.evaluate(
    ({ id }) => {
      window.dispatchEvent(
        new CustomEvent("brain:file-page-ref", {
          detail: { id, label: "📄 Verbs", headingIndex: null },
        }),
      );
    },
    { id: verbs },
  );
  await expect(inDocument).toHaveCount(1);

  // The answer arrives while the reader can still act on it: no insertion
  // line anywhere, and `no-drop` under the cursor, instead of a valid-looking
  // line and a silent refusal on release.
  await page.mouse.move(readingBox.x + 9, readingBox.y + readingBox.height + 3);
  await expect(page.locator("[data-file-refused='true']")).toHaveCount(1);
  await expect(page.locator(".brain-drop-cursor")).toBeHidden();

  await page.mouse.up();
  // Nothing was written a second time.
  await expect(inDocument).toHaveCount(1);
});

test("@release picking a filed block up is not the picture of one arriving", async ({
  page,
}) => {
  await login(page);
  const parentResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: {
      title: "Already filed",
      markdown: "# Reading\n\nRead this first.\n\n# Writing\n\nWrite this later.",
    },
  });
  expect(parentResponse.ok).toBeTruthy();
  const parent = parentResponse.body as { id: string };
  const childResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { parentId: parent.id, title: "Verbs" },
  });
  expect(childResponse.ok).toBeTruthy();
  const verbs = (childResponse.body as { id: string }).id;

  // Write the reference straight into the body, so the block on screen is one
  // that has been in the page all along and nothing about this visit files
  // anything.
  const current = (await browserJson(page, `/api/page/${parent.id}`)).body as {
    rev: string;
  };
  const written = await browserJson(page, `/api/page/${parent.id}`, {
    method: "PUT",
    body: {
      markdown: `# Reading\n\nRead this first.\n\n[📗 Verbs](/p/${verbs})\n\n# Writing\n\nWrite this later.`,
      rev: current.rev,
    },
  });
  expect(written.ok).toBeTruthy();

  await page.goto(`/p/${parent.id}`);
  const anchor = page.locator(
    `.ProseMirror a.brain-page-ref[data-page-ref="${verbs}"]`,
  );
  await expect(anchor).toHaveCount(1);
  // Nothing is unfiled, so there is no tail at all.
  await expect(page.locator("[data-derived-page-refs]")).toHaveCount(0);
  await watchFiledFlash(page);

  const block = page.locator(
    `.ProseMirror p:has(> a.brain-page-ref[data-page-ref="${verbs}"])`,
  );
  const box = await anchor.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Missing page-block geometry");

  // The user's own gesture: press the visible title and carry it off. The
  // editor answers with a NodeSelection, which is what the keyboard needs and
  // what the flash used to be hung on.
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY, { steps: 5 });
  await page.mouse.move(startX + 24, startY + 40, { steps: 12 });
  await expect(
    page.locator('.milkdown .ProseMirror[data-dragging="true"]'),
  ).toHaveCount(1);
  await expect(block).toHaveClass(/ProseMirror-selectednode/);

  // About to leave is not just arrived.
  await expect(block).not.toHaveClass(/brain-page-ref-filed/);
  expect(await filedFlashes(page)).toEqual([]);

  await page.mouse.up();
  // Nor is the move itself an arrival: the page was in the body before the
  // gesture and is in it after.
  await page.waitForTimeout(400);
  expect(await filedFlashes(page)).toEqual([]);
  await expect(anchor).toHaveCount(1);
});
