// Tasks: the gesture that links a note line, and the two-context proof that a
// completion from Tasks does not cost the other tab its edit.
//
// The named case is the merge, and it is the only test that reproduces the bug
// in the shape a person meets it: a note open and dirty in one tab, a task
// ticked from Tasks in another. It asserts BOTH legs, because the merge is a
// boundary and a boundary is two answers. A tick on a line the open tab left
// alone merges; a tick on a line that tab moved is the 409 it has always been,
// shown as the conflict banner and never softened into a toast.
//
// EVERY TEST IN THIS FILE IS `@release`. `ci.yml` runs the browser steps only
// on a push, and both it and `release.yml` run `playwright test --grep
// @release`, so an untagged test here would run in the weekly `e2e-full` job
// and nowhere else: the merge, the branch's one deliberate loosening of the 409
// contract, would ship with no browser-level guard at any release from here on.
//
// The three at the foot are the row's own gestures rather than the link to a
// note, and they are here because they are only reachable in a browser: the
// unit harness drives `expanded` as a prop, so a fold the row ASKS for never
// arrives there, and jsdom has no layout for a clip box to cut anything in.
//
// The second tab's SSE stream is blocked on purpose. That is not a convenience:
// it is the scenario. Somebody ticks a checkbox on their phone while the same
// note is open in a browser, and the browser then saves the body it loaded,
// which still carries the unticked line. Letting the stream through would have
// the tab reload before it ever wrote, and the merge would never be reached.
import { expect, test, type Browser, type Page } from "playwright/test";

import { parseTaskLines } from "../lib/tasks/task-lines";
import { freshNotes } from "./fresh-notes";

freshNotes();

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
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
      };
    },
    { path: requestPath, requestInit: init },
  );
}

function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

interface Note {
  id: string;
  markdown: string;
}

/** A note, and the markdown the store actually holds for it. The anchor is
 *  built from THAT, not from what was posted: the store canonicalises, and an
 *  anchor built from the wrong bytes names a line nothing will find. */
async function createNote(page: Page, title: string, markdown: string): Promise<Note> {
  const created = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title, markdown },
  });
  expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
  const id = (created.body as { id: string }).id;
  const read = await browserJson(page, `/api/page/${id}`);
  expect(read.ok).toBeTruthy();
  return { id, markdown: (read.body as { markdown: string }).markdown };
}

/** The one reading of a task line, used here exactly as the editor and the
 *  store use it, so the anchor this test writes is the anchor a promotion
 *  would have written. */
async function linkTask(
  page: Page,
  note: Note,
  occurrence: number,
  when: string,
): Promise<string> {
  const line = parseTaskLines(note.markdown)[occurrence];
  expect(line, `no task line ${occurrence} in ${JSON.stringify(note.markdown)}`).toBeTruthy();
  const created = await browserJson(page, "/api/tasks", {
    method: "POST",
    body: {
      title: line.normalized,
      when,
      page: note.id,
      anchor: {
        text: line.normalized,
        hash: line.hash,
        ordinal: line.ordinal,
        line: line.index,
      },
    },
  });
  expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
  return (created.body as { task: { id: string } }).task.id;
}

async function markdownOf(page: Page, id: string): Promise<string> {
  const read = await browserJson(page, `/api/page/${id}`);
  return read.ok ? (read.body as { markdown: string }).markdown : "";
}

async function openNote(page: Page, id: string) {
  await page.goto(`/p/${id}`);
  // `/p/[id]` compiles separately from the authenticated home route, and a
  // clean runner can spend more than the default 5s on that first cold page.
  await expect(page.getByRole("textbox", { name: "Page content" })).toBeVisible({
    timeout: 20_000,
  });
}

/** Complete a task from the Tasks surface, through the real row: the press,
 *  the 1300ms window a reader can change their mind inside, and the PATCH at
 *  the end of it. */
async function completeFromTasks(page: Page, title: string, taskId: string) {
  await page.goto("/tasks");
  const row = page.locator(`[data-task-id="${taskId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().includes(`/api/tasks/${taskId}`) &&
        candidate.request().method() === "PATCH",
      { timeout: 20_000 },
    ),
    row.getByRole("checkbox", { name: title }).click(),
  ]);
  expect(response.status()).toBe(200);
}

/** A task with no note behind it, filed on today, for the cases about the row
 *  itself rather than about the link to a checkbox. */
async function createTask(page: Page, title: string): Promise<string> {
  const created = await browserJson(page, "/api/tasks", {
    method: "POST",
    body: { title, when: localToday() },
  });
  expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
  return (created.body as { task: { id: string } }).task.id;
}

/** Open a task's row on the Tasks surface and expand it, which is what draws
 *  the chip row every case below reads. */
async function expandRow(page: Page, id: string, title: string) {
  await page.goto("/tasks");
  const row = page.locator(`[data-task-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByText(title, { exact: true }).click();
  await expect(row.locator(".brain-task-row[data-expanded]")).toHaveCount(1);
  // The reveal is a spring from height 0, so the chips are still growing for a
  // frame or two after the attribute lands.
  await page.waitForTimeout(500);
  return row;
}

/** Type at the end of a paragraph without touching any other line. */
async function appendToParagraph(page: Page, text: string, addition: string) {
  const paragraph = page
    .getByRole("textbox", { name: "Page content" })
    .getByText(text, { exact: true });
  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(addition);
}

const conflictBanner = (page: Page) =>
  page.getByRole("alert").filter({ hasText: "Conflict" });

test("@release a completion from Tasks lands in a note that is open and dirty in another tab", async ({
  browser,
}: {
  browser: Browser;
}) => {
  // Two logins at 20s apiece, four create-and-link helpers at 20, and five
  // polls at 15 to 20, all in one test. The 30s default is a timeout this can
  // reach on a loaded runner while every assertion in it is still on its way
  // to passing, which reads as a mystery flake rather than a merge
  // regression. `critical-flows` uses 60 for a login-heavy test and
  // `mail-client` 90; this is the heavier shape.
  test.setTimeout(120_000);
  const owner = await browser.newContext();
  const phone = await browser.newContext();
  try {
    const open = await owner.newPage();
    const tasks = await phone.newPage();
    await login(open);
    await login(tasks);
    // The tab with the note open has not heard about the tick yet. Without
    // this it reloads the ticked body before it writes, and the merge below
    // is never exercised.
    await owner.route("**/api/events", (route) => route.abort());

    const today = localToday();

    /* ── Leg one: an untouched line merges ──────────────────────────────── */

    // `-`, the way a person and an MCP call write one. Milkdown serialises
    // every bullet as `*`, so this tab's first save rewrites the marker on
    // every line; `mergeCheckboxStates` levels the marker before it compares,
    // so that rewrite is not a touched line and the tick still merges.
    //
    // The checkbox sits BELOW the paragraph this tab edits, which is the half
    // of the merge only the shared tail can carry. With it above, the shared
    // head alone answers and a body the client never sends would pass.
    const groceries = await createNote(
      open,
      "Groceries",
      "notes\n\n- [ ] water the plants\n",
    );
    const plants = await linkTask(open, groceries, 0, today);
    await openNote(open, groceries.id);

    await completeFromTasks(tasks, "water the plants", plants);
    await expect
      .poll(() => markdownOf(tasks, groceries.id), { timeout: 15_000 })
      .toContain("[x] water the plants");

    const merged = open.waitForResponse(
      (candidate) =>
        candidate.url().includes(`/api/page/${groceries.id}`) &&
        candidate.request().method() === "PUT",
      { timeout: 20_000 },
    );
    await appendToParagraph(open, "notes", " more");
    expect((await merged).status()).toBe(200);

    // Both halves survive: the tick that arrived from Tasks, and the words
    // this tab typed while it was arriving.
    await expect
      .poll(() => markdownOf(open, groceries.id), { timeout: 15_000 })
      .toContain("notes more");
    expect(await markdownOf(open, groceries.id)).toContain("[x] water the plants");
    await expect(conflictBanner(open)).toHaveCount(0);

    /* ── Leg two: a line this tab moved is a 409 ────────────────────────── */

    const trip = await createNote(
      open,
      "Trip",
      "intro\n\n- [ ] book the flight\n\nnotes\n",
    );
    const flight = await linkTask(open, trip, 0, today);
    await openNote(open, trip.id);

    await completeFromTasks(tasks, "book the flight", flight);
    await expect
      .poll(() => markdownOf(tasks, trip.id), { timeout: 15_000 })
      .toContain("[x] book the flight");

    const refused = open.waitForResponse(
      (candidate) =>
        candidate.url().includes(`/api/page/${trip.id}`) &&
        candidate.request().method() === "PUT",
      { timeout: 20_000 },
    );
    // The checkbox line itself is left alone, and it still moves: a paragraph
    // splits off above it and the paragraph below it grows, so the line sits
    // at a new index inside neither the head nor the tail this tab still
    // shares with the body it loaded. Its new position is a guess, and the
    // merge refuses to guess.
    const intro = open
      .getByRole("textbox", { name: "Page content" })
      .getByText("intro", { exact: true });
    await intro.click();
    await open.keyboard.press("Home");
    await open.keyboard.type("before");
    await open.keyboard.press("Enter");
    await appendToParagraph(open, "notes", " more");
    expect((await refused).status()).toBe(409);

    await expect(conflictBanner(open)).toBeVisible({ timeout: 15_000 });
    // The refusal is terminal for this body, so the server keeps the version
    // it had: the tick, and none of this tab's text.
    const kept = await markdownOf(tasks, trip.id);
    expect(kept).toContain("[x] book the flight");
    expect(kept).not.toContain("before");
  } finally {
    await owner.close();
    await phone.close();
  }
});

test("@release promoting a line from a note puts the task in Today and writes nothing to the markdown", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const note = await createNote(page, "Errands", "- [ ] call the bank\n\nnotes\n");
  await openNote(page, note.id);
  const before = await markdownOf(page, note.id);

  await page.locator("li.brain-task-item").first().hover();
  const ghost = page.locator("button.brain-task-mark");
  await expect(ghost).toHaveText("+ Task");
  await ghost.click();
  // The popover is the When picker with the note's Inbox row above it, so
  // Today is the picker's own quick row and carries its role: a `dialog`
  // holding a grid and two spinbuttons cannot be a `menu`, and its rows are
  // not `menuitem`s.
  await page
    .getByRole("dialog", { name: "When" })
    .getByRole("checkbox", { name: "Today" })
    .click();

  // The word replaces the ghost in the same place, and it is the mark of the
  // link: a second signal beside the checkbox border, not colour alone.
  await expect(ghost).toHaveText("Today", { timeout: 15_000 });

  const today = localToday();
  await expect
    .poll(async () => {
      const read = await browserJson(
        page,
        `/api/tasks?today=${today}&list=today&offset=0`,
      );
      const tasks = (read.body as { tasks?: { title: string; page?: string }[] })?.tasks;
      return tasks?.filter((task) => task.page === note.id).length ?? 0;
    }, { timeout: 15_000 })
    .toBe(1);

  // The load-bearing half: a promotion is a task record and nothing else. The
  // body a share visitor would read is byte for byte the body it was.
  expect(await markdownOf(page, note.id)).toBe(before);
});

test("@release deleting the line detaches the task and labels it as removed from the note", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const note = await createNote(page, "Packing", "- [ ] find the charger\n");
  const task = await linkTask(page, note, 0, localToday());
  await openNote(page, note.id);

  // The line goes, and with it the only thing that could answer this task's
  // completion. The record stays: a person's task is not the note's to throw
  // away.
  await page.getByRole("textbox", { name: "Page content" }).fill("nothing here");
  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/tasks/${task}`);
      return (read.body as { task?: { detachedAt?: string } })?.task?.detachedAt ?? null;
    }, { timeout: 20_000 })
    .not.toBeNull();

  await page.goto("/tasks");
  const row = page.locator(`[data-task-id="${task}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("line removed from Packing");
});

test("@release deleting the task in Tasks leaves the line an ordinary checkbox", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const note = await createNote(page, "Reading", "- [ ] renew the library card\n");
  const task = await linkTask(page, note, 0, localToday());
  await openNote(page, note.id);
  await expect(page.locator("button.brain-task-mark")).toHaveText("Today", {
    timeout: 15_000,
  });

  const removed = await browserJson(page, `/api/tasks/${task}`, { method: "DELETE" });
  expect(removed.ok, JSON.stringify(removed.body)).toBeTruthy();

  await openNote(page, note.id);
  // No word, and the ghost back in its place: the line is a checkbox again,
  // and it still ticks.
  await page.locator("li.brain-task-item").first().hover();
  await expect(page.locator("button.brain-task-mark")).toHaveText("+ Task", {
    timeout: 15_000,
  });
  expect(await markdownOf(page, note.id)).toContain("[ ] renew the library card");
});

test("@release consecutive task lines sit as close together as consecutive bullets", async ({
  page,
}) => {
  // Every task line carries a ghost `+ Task` widget at the end of it, and
  // prosemirror-view answers that widget with its own
  // `<img class="ProseMirror-separator"><br class="ProseMirror-trailingBreak">`
  // so the cursor has somewhere to land after it. Tailwind preflight's
  // `img { display: block }` (this project never loads prosemirror-view's
  // own stylesheet, which would have un-blocked it) turned that separator
  // into a line break of its own, so every task line doubled from one 24px
  // line to two, 48px apart, while an ordinary bullet stayed single. Two
  // consecutive task lines belong exactly as close as two consecutive
  // bullets: 16px text at 1.5 line-height (24) plus the `li + li` gap (4).
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const note = await createNote(page, "Gap check", "- [ ] Buy milk and eggs\n- [ ] Pick up bread\n");
  await openNote(page, note.id);

  const items = page.locator("li.brain-task-item");
  await expect(items).toHaveCount(2);
  const tops = await items.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().top),
  );
  expect(tops[1] - tops[0]).toBeLessThanOrEqual(32);
});

/* ── The row and the panels it opens ──────────────────────────────────────────
 *
 * Three answers the row got wrong on 0.10.6, all of them only reachable with a
 * real row under a real pointer: the unit harness drives `expanded` as a prop,
 * so a fold the row ASKS for never arrives there, and jsdom has no layout for
 * a clip box to cut anything in.
 */

test("@release a day in the calendar keeps the panel open and the row expanded", async ({
  page,
}) => {
  // The panel is portalled to the end of the document and React carries its
  // clicks up the ROW's tree all the same, so a day cell reached the row's own
  // press handler, which folded the row. The chips went, the picker went with
  // them, and a teardown that is not a close throws the day away: the panel
  // shut and nothing was saved.
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const id = await createTask(page, "Water the plants");
  const row = await expandRow(page, id, "Water the plants");

  await row.getByRole("button", { name: /^When:/ }).click();
  const panel = page.getByRole("dialog", { name: /^When:/ });
  await expect(panel).toBeVisible();

  const cell = panel.getByRole("gridcell", { name: /^\w+day 20 / });
  await cell.click();

  // The panel stands, the cell takes the ink capsule, and nothing has gone to
  // the route: the grid edits the panel's own value and Done is what sends it.
  await expect(panel).toBeVisible();
  await expect(cell).toHaveAttribute("aria-selected", "true");
  await expect(row.locator(".brain-task-row[data-expanded]")).toHaveCount(1);

  await panel.getByRole("button", { name: "Done" }).click();
  await expect(panel).toHaveCount(0);
  await expect
    .poll(async () => {
      const read = await browserJson(page, `/api/tasks/${id}`);
      return (read.body as { task?: { when?: string } })?.task?.when ?? null;
    }, { timeout: 15_000 })
    .toMatch(/-20$/);
});

test("@release every chip stays inside the expanded row, with room for its ring", async ({
  page,
}) => {
  // The chip row grows from height 0, so it clips while that plays; its box
  // hugged the chips exactly, so it went on clipping at rest and cut every
  // chip's focus ring down to two slivers on its left and right edges. Both
  // halves are read here: nothing reaches past the capsule, and the clip box
  // keeps the ring's own five pixels on all four sides.
  test.setTimeout(90_000);
  await login(page);
  const id = await createTask(page, "Chip geometry");

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const row = await expandRow(page, id, "Chip geometry");
    const measured = await row.evaluate((node) => {
      const capsule = node.querySelector(".brain-task-row") as HTMLElement;
      const chips = node.querySelector(".brain-task-chips") as HTMLElement;
      const style = getComputedStyle(capsule);
      const box = capsule.getBoundingClientRect();
      const clip = chips.getBoundingClientRect();
      const kids = [...chips.children].map((child) => {
        const rect = child.getBoundingClientRect();
        return {
          word: (child.textContent ?? "").trim(),
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          lines: 1,
        };
      });
      return {
        inner: {
          left: box.left + parseFloat(style.paddingLeft),
          right: box.right - parseFloat(style.paddingRight),
        },
        capsuleBottom: box.bottom,
        clip,
        kids,
        // A chip never breaks its own word across two lines: the ROW wraps.
        wrapped: new Set(kids.map((kid) => Math.round(kid.top))).size,
        scrollPast: chips.scrollWidth - chips.clientWidth,
      };
    });

    expect(measured.kids.length, `chips at ${width}`).toBeGreaterThanOrEqual(4);
    expect(measured.scrollPast, `no chip runs past the row at ${width}`).toBe(0);
    for (const chip of measured.kids) {
      expect(chip.right, `${chip.word} at ${width}`).toBeLessThanOrEqual(
        measured.inner.right + 0.5,
      );
      expect(chip.left, `${chip.word} at ${width}`).toBeGreaterThanOrEqual(
        measured.inner.left - 0.5,
      );
      expect(chip.bottom, `${chip.word} at ${width}`).toBeLessThanOrEqual(
        measured.capsuleBottom + 0.5,
      );
      // THE CLIP BOX KEEPS ITS DISTANCE. Five pixels is the ring's reach: a
      // 3px outline at 2px of offset.
      expect(chip.top - measured.clip.top, `ring room over ${chip.word}`)
        .toBeGreaterThanOrEqual(5);
      expect(measured.clip.bottom - chip.bottom, `ring room under ${chip.word}`)
        .toBeGreaterThanOrEqual(5);
      expect(chip.left - measured.clip.left, `ring room left of ${chip.word}`)
        .toBeGreaterThanOrEqual(5);
    }
    // 390 is the width the four of them do not fit on one line at, and the row
    // is what wraps there.
    expect(measured.wrapped, `lines at ${width}`).toBe(width === 390 ? 2 : 1);
  }
});

test("@release an expanded row folds on a press outside it", async ({ page }) => {
  // It kept its chips and its tint through a press anywhere else on the page,
  // and the only ways back were Escape and a second press on the row itself.
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const id = await createTask(page, "Stays expanded");
  const row = await expandRow(page, id, "Stays expanded");
  const capsule = row.locator(".brain-task-row[data-expanded]");

  // A panel the row opened is part of the row: the press that dismisses it
  // belongs to the panel, and the row stands.
  await row.getByRole("button", { name: /^When:/ }).click();
  await expect(page.getByRole("dialog", { name: /^When:/ })).toBeVisible();
  await page.mouse.click(1380, 760);
  await expect(page.getByRole("dialog", { name: /^When:/ })).toHaveCount(0);
  await expect(capsule).toHaveCount(1);

  // With nothing open over it, the same press folds it.
  await page.mouse.click(1380, 760);
  await expect(capsule).toHaveCount(0);
  await expect(row.locator(".brain-task-chips")).toHaveCount(0);
});

test("@release the cursor's capsule is drawn only while the column holds the focus", async ({
  page,
}) => {
  // Michael's "с задачи должен сниматься фокус" is this half of it: the chips
  // went with the fold and the grey capsule stayed, which reads as the task
  // still holding the focus it was asked to give up. The cursor itself does
  // not move, so a Tab back into the column finds it where it was.
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const id = await createTask(page, "Cursor capsule");
  await page.goto("/tasks");
  const row = page.locator(`[data-task-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  // A press puts the cursor on the row and opens it; Escape folds it and
  // leaves the cursor standing. An OPEN row wears the one fill of I1 and its
  // capsule draws nothing, so the cursor's own tint is only readable folded.
  await row.getByText("Cursor capsule", { exact: true }).click();
  await expect(row.locator(".brain-task-row[data-expanded]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(row.locator(".brain-task-row[data-expanded]")).toHaveCount(0);

  /** Whether this row is wearing the cursor's fill. */
  const tinted = () =>
    row.evaluate((node) => {
      const capsule = node.querySelector(
        ".brain-task-row[data-selected] > .tree-row-capsule",
      );
      if (capsule === null) return false;
      const paint = getComputedStyle(capsule).backgroundColor;
      return paint !== "transparent" && !/,\s*0\)$/.test(paint);
    });
  const cursorHeld = () => row.locator(".brain-task-row[data-selected]").count();

  expect(await tinted()).toBe(true);
  expect(await cursorHeld()).toBe(1);

  // A press outside takes the focus with it, so the tint goes. The cursor
  // stays exactly where the reader left it.
  await page.mouse.click(1380, 780);
  await page.waitForTimeout(400);
  expect(await tinted()).toBe(false);
  expect(await cursorHeld()).toBe(1);

  // And a Tab back into the column puts it on the same row.
  await page.keyboard.press("Tab");
  await page.waitForTimeout(400);
  expect(await tinted()).toBe(true);
  expect(await cursorHeld()).toBe(1);

  // A FOLD THAT STARTS FROM A CHIP KEEPS THE PAINT. Escape out of the picker
  // puts the focus back on the chip that opened it, and the Escape after it
  // folds the row: the chips go, and the focus they were holding would fall to
  // the body with nothing pressed, leaving the row with neither fill nor ring.
  // It comes back to the row, which is a focus holder.
  await row.getByText("Cursor capsule", { exact: true }).click();
  await expect(row.locator(".brain-task-row[data-expanded]")).toHaveCount(1);
  await row.getByRole("button", { name: /^When:/ }).click();
  await expect(page.getByRole("dialog", { name: /^When:/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /^When:/ })).toHaveCount(0);
  // ONE DISMISSAL PER KEY, said in a real browser. Without this line the case
  // reads the same on the old behaviour, where the first key took the panel
  // and the row together and the second had nothing left to fold.
  await expect(row.locator(".brain-task-row[data-expanded]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(row.locator(".brain-task-row[data-expanded]")).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await tinted()).toBe(true);
  expect(
    await row.evaluate(
      (node) => node.querySelector(".brain-task-row") === document.activeElement,
    ),
  ).toBe(true);
});

test("@release @mobile a touch scroll over the list leaves the expanded row standing", async ({
  page,
}) => {
  // `pointerdown` is the first event of a touch scroll, so a fold spent on the
  // way down folded the row every time a finger dragged past it: on the one
  // device where scrolling is how a reader gets anywhere. A press is a pointer
  // that goes down and comes back up in the same place, and a drag is not one.
  test.setTimeout(60_000);
  await login(page);
  const id = await createTask(page, "Reads while scrolling");
  await page.goto("/tasks");
  const row = page.locator(`[data-task-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByText("Reads while scrolling", { exact: true }).tap();
  const capsule = row.locator(".brain-task-row[data-expanded]");
  await expect(capsule).toHaveCount(1);
  await page.waitForTimeout(500);

  // A real finger, through the browser's own input pipeline: a dispatched
  // event would prove nothing about the pointer events Chrome makes from it.
  const touch = await page.context().newCDPSession(page);
  const at = (y: number) => ({ touchPoints: [{ x: 195, y }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", ...at(700) });
  for (const y of [690, 660, 620, 580, 540]) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", ...at(y) });
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);

  await expect(capsule).toHaveCount(1);

  // And a tap that stays where it landed still folds it.
  await page.touchscreen.tap(195, 700);
  await expect(capsule).toHaveCount(0);
});
