import { expect, test, type Page } from "playwright/test";

// Real pointer drags on the sidebar tree. dnd-kit reads pointer events, so a
// synthetic DragEvent would prove nothing about the gesture a reader performs —
// and a tree-DnD regression has already reached this repo once by passing a
// suite that never moved a mouse.

interface E2ETreeNode {
  id: string;
  parentId: string | null;
  title: string;
  children: E2ETreeNode[];
}

async function browserJson(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return page.evaluate(
    async ({ requestPath, requestInit }) => {
      const response = await fetch(requestPath, {
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
    { requestPath: path, requestInit: init },
  );
}

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
  expect(
    response.status(),
    `auth failed with ${response.status()}`,
  ).toBe(200);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

function findE2ETreeNode(
  nodes: E2ETreeNode[],
  id: string,
): E2ETreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findE2ETreeNode(node.children, id);
    if (found) return found;
  }
  return null;
}

async function readTree(page: Page): Promise<E2ETreeNode[]> {
  const response = await browserJson(page, "/api/tree");
  return (response.body as { tree: E2ETreeNode[] }).tree;
}

async function readMarkdown(page: Page, id: string): Promise<string> {
  const response = await browserJson(page, `/api/page/${id}`);
  return (response.body as { markdown: string }).markdown;
}

/** The body once the open editor has finished normalizing it. Milkdown rewrites
 *  a page reference's label to carry the page icon and saves that a beat after
 *  the page loads, so a snapshot taken too early would make the move look like
 *  it changed text it never touched. */
async function settledMarkdown(page: Page, id: string): Promise<string> {
  let previous = await readMarkdown(page, id);
  await expect
    .poll(async () => {
      const next = await readMarkdown(page, id);
      const unchanged = next === previous;
      previous = next;
      return unchanged;
    })
    .toBe(true);
  return previous;
}

async function seedBody(page: Page, id: string, markdown: string) {
  const current = await browserJson(page, `/api/page/${id}`);
  const seeded = await browserJson(page, `/api/page/${id}`, {
    method: "PUT",
    body: { markdown, rev: (current.body as { rev: string }).rev },
  });
  expect(seeded.ok).toBeTruthy();
}

/** Lines that are nothing but a reference to one page. This is the shape the
 *  product treats as structure — and the shape a move takes away. The label is
 *  matched loosely because the editor normalizes it to carry the page icon. */
function standaloneRefLines(markdown: string, id: string): string[] {
  const only = new RegExp(`^\\[[^\\]]*\\]\\(/p/${id}\\)$`);
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => only.test(line));
}

async function createPage(page: Page, title: string, parentId?: string) {
  const response = await browserJson(page, "/api/page", {
    method: "POST",
    body: parentId ? { parentId, title } : { title },
  });
  expect(response.ok).toBeTruthy();
  const meta = response.body as { id: string; icon?: string };
  return {
    id: meta.id,
    // The reference line the editor and the Store both write for this page.
    // Seeding a body with any other label means the editor normalizes it on
    // open and the "before" snapshot is a body nobody ever saw.
    ref: `[${meta.icon ? `${meta.icon} ` : ""}${title}](/p/${meta.id})`,
  };
}

const row = (page: Page, id: string) =>
  page.locator(`[data-tree-page-id="${id}"]`);

async function expandRow(page: Page, id: string) {
  const toggle = row(page, id).getByRole("button", { name: "Expand" });
  if (await toggle.isVisible()) await toggle.click();
}

/** Pick the row up and carry it to a band of the target row: 0.5 is the middle
 *  ("into this page"), 0.05 and 0.95 are the edges ("between rows"). Leaves the
 *  button down so the caller can read the feedback before the release.
 *
 *  The target is measured after the drag has visibly started, not before. Rows
 *  hold still for the whole gesture, so a rect taken then is the rect the drop
 *  will be resolved against — while a rect taken beforehand can still be a row
 *  mid-animation from the previous move. */
async function carryRow(
  page: Page,
  sourceId: string,
  targetId: string,
  fraction: number,
) {
  // No drag may still be in flight: the lifted row plays a drop animation after
  // the release, and a press that lands under it never reaches the list.
  await expect(page.locator(".tree-row-overlay")).toHaveCount(0);
  const source = row(page, sourceId);
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  expect(from).not.toBeNull();
  if (!from) throw new Error("Missing dragged row geometry");

  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Clear dnd-kit's 5px activation distance, then wait for the row to say the
  // drag really started: it leaves an empty slot behind and rides the overlay.
  await page.mouse.move(startX + 12, startY, { steps: 5 });
  await expect(page.locator("[data-tree-row-slot]")).toHaveCount(1);

  const aim = async () => {
    const to = await row(page, targetId).boundingBox();
    expect(to).not.toBeNull();
    if (!to) throw new Error("Missing target row geometry");
    return { x: to.x + to.width / 2, y: to.y + to.height * fraction };
  };

  const first = await aim();
  await page.mouse.move(first.x, first.y, { steps: 24 });
  // Re-aim: a long sidebar scrolls under a travelling drag, and a band read off
  // a rect measured before the travel would name the wrong third of the row.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = await aim();
    if (Math.abs(target.y - first.y) < 1 && attempt > 0) break;
    // The last step is sideways so a final move event lands with the pointer
    // still in the same band — a vertical nudge could cross into the next one.
    await page.mouse.move(target.x, target.y, { steps: 2 });
    await page.mouse.move(target.x + 0.5, target.y, { steps: 2 });
    first.y = target.y;
  }
}

test("@release dropping a page onto a page moves it, and the old page stops listing it", async ({
  page,
}) => {
  await login(page);
  const parent = await createPage(page, "Field Guide");
  const archive = await createPage(page, "Archive");
  const moving = await createPage(page, "Tomato Trial Rows", parent.id);
  const staying = await createPage(page, "Bulb Beds", parent.id);

  const sentence = `The brief for ${moving.ref} was written in March.`;
  await seedBody(
    page,
    parent.id,
    [
      "Intro prose stays in place.",
      "## Beds & Borders",
      moving.ref,
      staying.ref,
      "## Notes",
      sentence,
      "Tail prose stays in place.",
    ].join("\n\n"),
  );

  await page.goto(`/p/${parent.id}`);
  await expandRow(page, parent.id);
  await expect(row(page, moving.id)).toBeVisible();

  await carryRow(page, moving.id, archive.id, 0.5);
  // The row says what is about to happen: the whole target is ringed, and no
  // insertion line is claiming this is a reorder.
  await expect(row(page, archive.id)).toHaveAttribute("data-drop-into", "");
  await expect(page.locator("[data-drop-edge]")).toHaveCount(0);
  await page.mouse.up();

  await expect
    .poll(async () => findE2ETreeNode(await readTree(page), moving.id)?.parentId)
    .toBe(archive.id);

  // The line that was nothing but the reference is gone — read as a line, not
  // as a substring, because the same reference also lives inside a sentence.
  await expect
    .poll(async () =>
      standaloneRefLines(await readMarkdown(page, parent.id), moving.id),
    )
    .toEqual([]);

  const parentBody = await readMarkdown(page, parent.id);
  // The sentence in the Notes section names the same page. It is prose, not
  // structure, and the move left it word for word as it stood.
  expect(parentBody).toContain(sentence);
  expect(parentBody).toContain("Intro prose stays in place.");
  expect(parentBody).toContain("## Beds & Borders");
  expect(parentBody).toContain("Tail prose stays in place.");
  // The other child's line is untouched.
  expect(standaloneRefLines(parentBody, staying.id)).toEqual([staying.ref]);

  // The page it moved into now says so in its own body, the way any child
  // page block does.
  await expect
    .poll(async () =>
      standaloneRefLines(await readMarkdown(page, archive.id), moving.id),
    )
    .toHaveLength(1);

  // And the document the reader is looking at updated in front of them rather
  // than going stale: the standalone reference row is gone, the sentence's is
  // not.
  await expect(
    page.locator(`p.brain-page-ref-only a[data-page-ref="${moving.id}"]`),
  ).toHaveCount(0);
  // The sentence's reference is still a live page reference, still clickable,
  // still pointing at the page that moved.
  await expect(
    page.locator(`.ProseMirror a[data-page-ref="${moving.id}"]`),
  ).toHaveCount(1);
});

test("@release dropping a page between two rows reorders without touching a document", async ({
  page,
}) => {
  await login(page);
  const parent = await createPage(page, "Reorder parent");
  const first = await createPage(page, "Reorder one", parent.id);
  const second = await createPage(page, "Reorder two", parent.id);
  const third = await createPage(page, "Reorder three", parent.id);

  await seedBody(page, parent.id, "Body that mentions none of its children.");

  await page.goto(`/p/${parent.id}`);
  await expandRow(page, parent.id);
  await expect(row(page, third.id)).toBeVisible();
  const bodyBefore = await settledMarkdown(page, parent.id);

  await carryRow(page, third.id, first.id, 0.05);
  // The other feedback: a line on the boundary the pointer is on, and nothing
  // claiming the page is going inside a row.
  await expect(row(page, first.id)).toHaveAttribute("data-drop-edge", "before");
  await expect(page.locator("[data-drop-into]")).toHaveCount(0);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const node = findE2ETreeNode(await readTree(page), parent.id);
      return node?.children.map((child) => child.id);
    })
    .toEqual([third.id, first.id, second.id]);

  // Where a page sits among its siblings is the tree's business. A reorder
  // inside one parent rewrites no body at all.
  expect(await readMarkdown(page, parent.id)).toBe(bodyBefore);

  // Back down the other way: the bottom edge of the last row appends.
  await carryRow(page, third.id, second.id, 0.9);
  await expect(row(page, second.id)).toHaveAttribute("data-drop-edge", "after");
  await page.mouse.up();

  await expect
    .poll(async () => {
      const node = findE2ETreeNode(await readTree(page), parent.id);
      return node?.children.map((child) => child.id);
    })
    .toEqual([first.id, second.id, third.id]);
  expect(await readMarkdown(page, parent.id)).toBe(bodyBefore);
});

test("@release a move the server refuses leaves both the tree and the document untouched", async ({
  page,
}) => {
  await login(page);
  const parent = await createPage(page, "Refusing parent");
  const elsewhere = await createPage(page, "Refusing elsewhere");
  const moving = await createPage(page, "Refusing child", parent.id);

  await seedBody(
    page,
    parent.id,
    ["Intro line.", moving.ref, "Outro line."].join("\n\n"),
  );
  await page.goto(`/p/${parent.id}`);
  await expandRow(page, parent.id);
  await expect(row(page, moving.id)).toBeVisible();
  const bodyBefore = await settledMarkdown(page, parent.id);

  await page.route("**/api/move", async (route) => {
    await route.fulfill({ status: 500, body: "move failed" });
  });
  await carryRow(page, moving.id, elsewhere.id, 0.5);
  await expect(row(page, elsewhere.id)).toHaveAttribute("data-drop-into", "");
  await page.mouse.up();

  await expect(page.locator(".brain-toast")).toContainText(
    "Couldn't move — reverted",
  );
  await page.unroute("**/api/move");

  expect(findE2ETreeNode(await readTree(page), moving.id)?.parentId).toBe(
    parent.id,
  );
  expect(await settledMarkdown(page, parent.id)).toBe(bodyBefore);
  expect(await readMarkdown(page, elsewhere.id)).not.toContain(
    `/p/${moving.id}`,
  );
  // The optimistic tree was put back: the row is still drawn one level in from
  // its parent, where the server says it is.
  const indent = (id: string) =>
    page
      .locator(`[data-tree-page-id="${id}"]`)
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingLeft),
      );
  await expect
    .poll(async () => (await indent(moving.id)) - (await indent(parent.id)))
    .toBeGreaterThan(0);
});
