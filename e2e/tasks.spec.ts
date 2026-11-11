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
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Locator, type Page } from "playwright/test";

import { shiftDay } from "../lib/tasks/calendar";
import type { TaskView } from "../lib/tasks/model";
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

/** Complete through the Tasks checkbox and wait for its persisted write. */
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
    row.getByRole("checkbox", { name: `Complete ${title}`, exact: true }).click(),
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

/** Open the approved task dialog from its full-row action. */
async function openTaskDialog(page: Page, id: string, title: string) {
  await page.goto("/tasks");
  const row = page.locator(`[data-task-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: title, exact: true }).click();
  // A modal child picker temporarily hides this parent from assistive
  // technology; it must still stay mounted and visibly hold the task draft.
  const dialog = page.getByRole("dialog", { name: title, exact: true, includeHidden: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  return dialog;
}

/** Drive the browser's wheel path, not scrollTop/scrollIntoView: those bypass
 *  the modal scroll lock that used to cancel gestures in body-ported pickers. */
async function wheelPickerTo(page: Page, scroller: Locator, edge: "top" | "bottom") {
  const extent = await scroller.evaluate((node) => node.scrollHeight - node.clientHeight);
  expect(extent, "The picker fixture must overflow").toBeGreaterThan(1);
  const bounds = await scroller.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  // A small horizontal component also exercises diagonal trackpad gestures.
  await page.mouse.wheel(8, (edge === "bottom" ? 1 : -1) * (extent + bounds!.height));
  await expect.poll(() => scroller.evaluate((node, target) =>
    target === "top" ? node.scrollTop : node.scrollHeight - node.clientHeight - node.scrollTop,
  edge), { message: `The wheel must reach the picker ${edge}` }).toBeLessThan(1);
}

async function taskScrollPositions(page: Page) {
  return page.evaluate(() => ({
    window: window.scrollY,
    panels: [...document.querySelectorAll(".tasks-workspace-scroll, .tasks-detail-body")]
      .map((node) => ({ className: node.className, top: node.scrollTop })),
  }));
}

/** A raw outside click skips locator stability checks. Wait for this menu's
 * own entrance before dismissal: Radix arms its document listener after mount.
 * Descendant animations are irrelevant and may be continuous. */
async function settleTaskPickerEntrance(picker: Locator) {
  await picker.evaluate((node) => Promise.all(
    node.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  ));
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
  await expect(row).toContainText("Source line removed");
  await row.getByRole("button", { name: "find the charger", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "find the charger", exact: true });
  await expect(dialog.getByText("The original task line was removed from this note.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Packing", exact: true }).click();
  await expect(page).toHaveURL(`/p/${note.id}`);
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

/* The task dialog keeps the old protections: child panels do not dismiss
 * their parent, calendar choices remain a draft until Save, and real pointer,
 * keyboard and touch interactions leave focus and layout in a usable state. */

test("@release the category picker scrolls by wheel inside the task dialog", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  let id = "";
  for (let index = 1; index <= 20; index++) {
    const number = String(index).padStart(2, "0");
    const created = await browserJson(page, "/api/tasks", {
      method: "POST",
      body: {
        title: `Wheel task ${number}`,
        category: `Wheel category ${number}`,
        when: localToday(),
        body: index === 1 ? Array.from({ length: 30 }, (_, line) => `Context line ${line + 1}`).join("\n") : "",
      },
    });
    expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
    if (index === 1) id = (created.body as { task: { id: string } }).task.id;
  }
  const dialog = await openTaskDialog(page, id, "Wheel task 01");
  await dialog.getByRole("button", { name: "Category: Wheel category 01", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose or create a category", exact: true });
  await expect(picker.getByRole("textbox", { name: "Category name", exact: true })).toBeFocused();
  const list = picker.getByRole("group", { name: "Categories", exact: true });
  const before = await taskScrollPositions(page);
  await expect.poll(() => page.locator(".tasks-workspace-scroll").evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100);
  await expect.poll(() => dialog.locator(".tasks-detail-body").evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100);
  await wheelPickerTo(page, list, "bottom");
  await expect(picker.getByRole("button", { name: "Remove category", exact: true })).toBeInViewport();
  await wheelPickerTo(page, list, "top");
  await expect(picker.getByRole("button", { name: "Wheel category 01", exact: true })).toBeInViewport();
  await wheelPickerTo(page, list, "bottom");
  expect(await taskScrollPositions(page)).toEqual(before);
  await expect(dialog).toBeVisible();
  const last = picker.getByRole("button", { name: "Wheel category 20", exact: true });
  await expect(last).toBeInViewport();
  await last.click();
  await expect(picker).toHaveCount(0);
  const category = dialog.getByRole("button", { name: "Category: Wheel category 20", exact: true });
  await expect(category).toBeFocused();
  await category.click();
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(category).toBeFocused();
  await category.click();
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("textbox", { name: "Category name", exact: true })).toBeFocused();
  await settleTaskPickerEntrance(picker);
  await page.mouse.click(1380, 760);
  await expect(picker).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await browserJson(page, `/api/tasks/${id}`);
  expect((saved.body as { task: { category?: string } }).task.category).toBe("Wheel category 20");
});

test("@release the linked pages picker scrolls by wheel and keeps the task draft", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const notes = new Map<string, string>();
  for (let index = 1; index <= 20; index++) {
    const title = `Wheel page ${String(index).padStart(2, "0")}`;
    const created = await browserJson(page, "/api/page", {
      method: "POST",
      body: { title, markdown: "Synthetic context for the picker scroll regression.\n" },
    });
    expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
    notes.set(title, (created.body as { id: string }).id);
  }
  const id = await createTask(page, "Wheel linked pages");
  const dialog = await openTaskDialog(page, id, "Wheel linked pages");
  await dialog.getByRole("textbox", { name: "Task notes", exact: true }).fill("Keep this unsaved context");
  const addPage = dialog.getByRole("button", { name: "Add page", exact: true });
  await addPage.click();
  const picker = page.getByRole("dialog", { name: "Link pages", exact: true });
  await picker.getByRole("textbox", { name: "Search pages", exact: true }).fill("Wheel page");
  const list = picker.getByRole("group", { name: "Pages", exact: true });
  const choices = list.getByRole("checkbox");
  await expect(choices).toHaveCount(20);
  const last = choices.last();
  const selectedPage = notes.get((await last.locator(".tasks-page-copy > .text-control").innerText()).trim());
  expect(selectedPage).toBeTruthy();
  const before = await taskScrollPositions(page);
  await wheelPickerTo(page, list, "bottom");
  await expect(last).toBeInViewport();
  await wheelPickerTo(page, list, "top");
  await expect(choices.first()).toBeInViewport();
  await wheelPickerTo(page, list, "bottom");
  expect(await taskScrollPositions(page)).toEqual(before);
  await last.click();
  await expect(last).toBeChecked();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(addPage).toBeFocused();
  await expect(dialog.getByRole("textbox", { name: "Task notes", exact: true })).toHaveValue("Keep this unsaved context");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await browserJson(page, `/api/tasks/${id}`);
  expect((saved.body as { task: { relatedPageIds?: string[] } }).task.relatedPageIds).toEqual([selectedPage]);
});

test("@release task calendars scroll by wheel in a short desktop window", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 360 });
  await login(page);
  const id = await createTask(page, "Calendar wheel boundary");
  const dialog = await openTaskDialog(page, id, "Calendar wheel boundary");
  for (const name of ["When", "Deadline"]) {
    const trigger = dialog.getByRole("button", { name: new RegExp(`^${name}:`) });
    await trigger.click();
    const picker = page.getByRole("dialog", { name, exact: true });
    await expect(picker).toBeVisible();
    const focusedDay = picker.locator('[role="gridcell"][tabindex="0"]');
    await expect(focusedDay).toBeFocused();
    const day = await focusedDay.getAttribute("data-day");
    expect(day).toBeTruthy();
    const selected = picker.getByRole("gridcell", { selected: true });
    const selectionBefore = await selected.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-day")));
    await page.keyboard.press("ArrowRight");
    await expect(focusedDay).toHaveAttribute("data-day", shiftDay(day!, 1));
    await expect(focusedDay).toBeFocused();
    expect(await selected.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-day")))).toEqual(selectionBefore);
    const list = picker.locator(".brain-when-scroll");
    const before = await taskScrollPositions(page);
    await wheelPickerTo(page, list, "bottom");
    await wheelPickerTo(page, list, "top");
    await wheelPickerTo(page, list, "bottom");
    expect(await taskScrollPositions(page)).toEqual(before);
    const done = picker.getByRole("button", { name: "Done", exact: true });
    await expect(done).toBeInViewport();
    await done.click();
    await expect(picker).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(trigger).toBeFocused();
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("@release a calendar day stays in the task draft until Save", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const id = await createTask(page, "Water the plants");
  const dialog = await openTaskDialog(page, id, "Water the plants");
  await dialog.getByRole("button", { name: /^When:/ }).click();
  const panel = page.getByRole("dialog", { name: "When", exact: true });
  const cell = panel.getByRole("gridcell", { name: /^\w+day 20 / });
  await cell.click();
  await expect(panel).toBeVisible();
  await expect(cell).toHaveAttribute("aria-selected", "true");
  await expect(dialog).toBeVisible();
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await expect(panel).toHaveCount(0);
  const beforeSave = await browserJson(page, `/api/tasks/${id}`);
  expect((beforeSave.body as { task: { when?: string } }).task.when).toBe(localToday());
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => {
    const read = await browserJson(page, `/api/tasks/${id}`);
    return (read.body as { task?: { when?: string } })?.task?.when ?? null;
  }, { timeout: 15_000 }).toMatch(/-20$/);
});

test("@release task properties and page picker fit desktop, tablet and phone", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const id = await createTask(page, "Property geometry");
  const withMetadata = await browserJson(page, `/api/tasks/${id}`, {
    method: "PATCH",
    body: { deadline: localToday() },
  });
  expect(withMetadata.ok, JSON.stringify(withMetadata.body)).toBeTruthy();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const dialog = await openTaskDialog(page, id, "Property geometry");
    await page.mouse.move(0, 0);
    // Let any hover tint finish before comparing the resting controls. The
    // dialog's materialisation scale must not become a height difference.
    for (const control of [
      dialog.getByRole("button", { name: /^Category:/ }),
      dialog.getByRole("button", { name: "Repeat", exact: true }),
    ]) await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const measured = await dialog.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const properties = [...node.querySelectorAll(".tasks-detail-properties button")].map((child) => {
        const rect = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        return {
          label: child.getAttribute("aria-label") || child.textContent,
          left: rect.left, right: rect.right,
          appearance: {
            font: style.font, letterSpacing: style.letterSpacing,
            height: style.height, background: style.backgroundColor, shadow: style.boxShadow,
          },
        };
      });
      return { left: box.left, right: box.right, properties, overflow: node.scrollWidth - node.clientWidth };
    });
    expect(measured.left).toBeGreaterThanOrEqual(-0.5);
    expect(measured.right).toBeLessThanOrEqual(width + 0.5);
    expect(measured.overflow).toBe(0);
    expect(measured.properties.length).toBeGreaterThanOrEqual(4);
    for (const property of measured.properties) {
      expect(property.left, `${property.label} at ${width}`).toBeGreaterThanOrEqual(measured.left);
      expect(property.right, `${property.label} at ${width}`).toBeLessThanOrEqual(measured.right);
    }
    const category = measured.properties.find((property) => property.label?.startsWith("Category:"));
    const repeat = measured.properties.find((property) => property.label === "Repeat");
    expect(category).toBeTruthy();
    expect(repeat).toBeTruthy();
    expect(repeat!.appearance, `Repeat matches the other properties at ${width}`).toEqual(category!.appearance);
    await dialog.getByRole("button", { name: "Add page", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Link pages", exact: true });
    await expect(picker).toBeVisible();
    const bounds = await picker.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(15);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 15);
    await picker.getByRole("button", { name: "Done", exact: true }).click();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    if (width === 1440) {
      const row = page.locator(`[data-task-id="${id}"]`);
      const compact = row.locator(".tasks-compact-row");
      const checkbox = row.getByRole("checkbox", { name: "Complete Property geometry", exact: true });
      const metadata = row.locator(".tasks-compact-meta");
      const fillOpacity = () => compact.evaluate((node) => Number(getComputedStyle(node, "::before").opacity));
      // Hovering either independent control must paint the same complete row.
      await checkbox.hover();
      await expect.poll(fillOpacity).toBe(1);
      const fill = await compact.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node, "::before");
        return {
          left: box.left + parseFloat(style.left), right: box.right - parseFloat(style.right),
          top: box.top + parseFloat(style.top), bottom: box.bottom - parseFloat(style.bottom),
          background: style.backgroundColor,
        };
      });
      expect(fill.background).not.toBe("rgba(0, 0, 0, 0)");
      for (const content of [checkbox, metadata]) {
        const box = await content.boundingBox();
        expect(box).not.toBeNull();
        expect(fill.left).toBeLessThan(box!.x);
        expect(fill.right).toBeGreaterThan(box!.x + box!.width);
        expect(fill.top).toBeLessThan(box!.y);
        expect(fill.bottom).toBeGreaterThan(box!.y + box!.height);
      }
      await metadata.hover();
      await expect.poll(fillOpacity).toBe(1);
      await page.mouse.move(0, 0);
      await expect.poll(fillOpacity).toBe(0);
      const box = await compact.boundingBox();
      expect(box).not.toBeNull();
      expect(fill.left).toBeLessThan(box!.x);
      // The new painted inset is also a target, rather than decorative padding.
      await page.mouse.click((fill.left + box!.x) / 2, (fill.top + fill.bottom) / 2);
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
  }
});

test("@release task context menus complete, undo and remove categories without losing tasks", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const today = localToday();
  const category = "Context actions category";
  const emptyCategory = "Empty context category";
  const linkedPage = await createNote(page, "Context actions reference", "Keep this linked context.\n");
  for (const name of [category, emptyCategory]) {
    const created = await browserJson(page, "/api/task-categories", { method: "POST", body: { name } });
    expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
  }
  const ids: string[] = [];
  const titles = ["Context action today", "Context action future", "Context action already done"];
  for (const [index, title] of titles.entries()) {
    const created = await browserJson(page, "/api/tasks", {
      method: "POST",
      body: {
        title, category, when: index === 1 ? shiftDay(today, 7) : today,
        deadline: index === 0 ? today : undefined,
        body: `Details for ${title}.\nKeep the full description.`,
        relatedPageIds: [linkedPage.id],
      },
    });
    expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
    ids.push((created.body as { task: TaskView }).task.id);
  }
  const alreadyDone = await browserJson(page, `/api/tasks/${ids[2]}`, { method: "PATCH", body: { done: true } });
  expect(alreadyDone.ok, JSON.stringify(alreadyDone.body)).toBeTruthy();
  const outsideId = await createTask(page, "Context untouched task");
  const read = async (id: string) => {
    const response = await browserJson(page, `/api/tasks/${id}`);
    expect(response.ok, JSON.stringify(response.body)).toBeTruthy();
    return response.body as { task: TaskView; body: string; bodyRev: string };
  };
  const menu = page.getByRole("menu");
  const openMenu = async (target: Locator) => {
    await target.click({ button: "right" });
    await expect(menu).toBeVisible();
  };
  const confirmation = (title: string) => page.getByRole("alertdialog", { name: `Delete “${title}”?`, exact: true });
  // Modal layers hide the rail from accessibility while it remains on screen.
  // An absence assertion must prove deletion, not this temporary aria-hidden.
  const rail = page.getByRole("navigation", { name: "Task categories", exact: true, includeHidden: true });
  const categoryButton = rail.getByRole("button", { name: category, exact: true, includeHidden: true });

  await page.goto("/tasks");
  await expect(categoryButton).toBeVisible({ timeout: 20_000 });
  await page.getByRole("navigation", { name: "Tasks views", exact: true }).getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Today", exact: true })).toBeVisible();
  await openMenu(categoryButton);
  await expect(page.getByRole("heading", { level: 1, name: "Today", exact: true, includeHidden: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Complete all tasks", exact: true }).click();
  const batchToast = page.locator('[aria-live="polite"] .brain-toast').filter({ hasText: "2 tasks completed" });
  await expect(batchToast.getByRole("button", { name: "Undo", exact: true })).toHaveCount(1);
  expect(await Promise.all(ids.map(async (id) => (await read(id)).task.done))).toEqual([true, true, true]);
  expect((await read(outsideId)).task.done).toBe(false);
  await batchToast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => Promise.all(ids.map(async (id) => (await read(id)).task.done))).toEqual([false, false, true]);

  const originals = await Promise.all(ids.map(read));
  await categoryButton.click();
  await expect(page.getByRole("heading", { level: 1, name: category, exact: true })).toBeVisible();
  await openMenu(categoryButton);
  await menu.getByRole("menuitem", { name: "Delete category…", exact: true }).click();
  await expect(confirmation(category)).toContainText("Tasks will be kept without a category.");
  await confirmation(category).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation(category)).toHaveCount(0);
  expect(await Promise.all(ids.map(async (id) => (await read(id)).task.category))).toEqual(ids.map(() => category));
  await openMenu(categoryButton);
  await menu.getByRole("menuitem", { name: "Delete category…", exact: true }).click();
  await confirmation(category).getByRole("button", { name: "Delete category", exact: true }).click();
  await expect(confirmation(category)).toHaveCount(0);
  await expect(categoryButton).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "All tasks", exact: true })).toBeVisible();
  const emptyButton = rail.getByRole("button", { name: emptyCategory, exact: true, includeHidden: true });
  await openMenu(emptyButton);
  await expect(menu.getByRole("menuitem", { name: "Complete all tasks", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Delete category…", exact: true }).click();
  await confirmation(emptyCategory).getByRole("button", { name: "Delete category", exact: true }).click();
  await expect(confirmation(emptyCategory)).toHaveCount(0);
  await expect(emptyButton).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("tasks-surface")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("navigation", { name: "Tasks views", exact: true }).getByRole("button", { name: "All tasks", exact: true }).click();
  await expect(categoryButton).toHaveCount(0);
  await expect(emptyButton).toHaveCount(0);
  const retained = ({ task, body, bodyRev }: Awaited<ReturnType<typeof read>>) => ({
    id: task.id, title: task.title, done: task.done, when: task.when, deadline: task.deadline,
    relatedPageIds: task.relatedPageIds, body, bodyRev,
  });
  for (const [index, id] of ids.entries()) {
    const saved = await read(id);
    expect(saved.task.category).toBeUndefined();
    expect(retained(saved)).toEqual(retained(originals[index]));
  }
  const catalog = await browserJson(page, "/api/task-categories");
  expect(catalog.ok).toBeTruthy();
  const names = (catalog.body as { categories: { name: string }[] }).categories.map((entry) => entry.name);
  expect(names).not.toContain(category);
  expect(names).not.toContain(emptyCategory);
  expect(await markdownOf(page, linkedPage.id)).toBe(linkedPage.markdown);

  const row = page.locator(`[data-task-id="${ids[0]}"][data-row-key="${ids[0]}"]`);
  await openMenu(row.locator(".tasks-compact-meta"));
  await expect(menu.getByRole("menuitem", { name: "Open source page", exact: true })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Open task", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: titles[0], exact: true });
  await expect(dialog.getByRole("textbox", { name: "Task notes", exact: true })).toHaveValue(originals[0].body);
  await dialog.getByRole("button", { name: "Close task", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  await row.getByRole("button", { name: titles[0], exact: true }).focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Complete task", exact: true }).click();
  await expect.poll(async () => (await read(ids[0])).task.done).toBe(true);
  const completed = page.getByRole("button", { name: /^Completed/ });
  if (await completed.getAttribute("aria-expanded") === "false") await completed.click();
  await openMenu(row.locator(".tasks-compact-meta"));
  await menu.getByRole("menuitem", { name: "Mark incomplete", exact: true }).click();
  await expect.poll(async () => (await read(ids[0])).task.done).toBe(false);
  await openMenu(row.locator(".tasks-compact-meta"));
  await menu.getByRole("menuitem", { name: "Delete task…", exact: true }).click();
  await confirmation(titles[0]).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation(titles[0])).toHaveCount(0);
  expect((await read(ids[0])).body).toBe(originals[0].body);
  await openMenu(row.locator(".tasks-compact-meta"));
  await menu.getByRole("menuitem", { name: "Delete task…", exact: true }).click();
  await confirmation(titles[0]).getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await browserJson(page, `/api/tasks/${ids[0]}`)).status).toBe(404);
  expect((await read(ids[1])).task.id).toBe(ids[1]);

  // Past occurrences share the live series' ID; their menu cannot mutate it.
  const recurring = await browserJson(page, "/api/tasks", {
    method: "POST", body: { title: "Context recurring history", when: today, repeat: { freq: "daily" } },
  });
  expect(recurring.ok, JSON.stringify(recurring.body)).toBeTruthy();
  const recurringId = (recurring.body as { task: TaskView }).task.id;
  for (let occurrence = 0; occurrence < 2; occurrence++) {
    const live = await read(recurringId);
    const completed = await browserJson(page, `/api/tasks/${recurringId}?today=${today}`, {
      method: "PATCH", body: { done: true, expectedWhen: live.task.when },
    });
    expect(completed.ok, JSON.stringify(completed.body)).toBeTruthy();
  }
  const history = await read(recurringId);
  expect(history.task.log).toHaveLength(2);
  await page.reload();
  await expect(page.getByTestId("tasks-surface")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("navigation", { name: "Tasks views", exact: true }).getByRole("button", { name: "All tasks", exact: true }).click();
  if (await completed.getAttribute("aria-expanded") === "false") await completed.click();
  for (const entry of history.task.log!) {
    const occurrence = page.locator(`[data-row-key="${recurringId}:${entry.completedAt}"]`);
    // The historic title button is disabled. Invoke its enabled context-menu
    // row instead of asking Playwright to wait for that button to enable.
    await openMenu(occurrence);
    await expect(menu.getByRole("menuitem")).toHaveCount(1);
    await expect(menu.getByRole("menuitem", { name: "Past occurrence", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  expect((await read(recurringId)).task).toEqual(history.task);
});

test("@release outside press dismisses a child picker before the task draft", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const id = await createTask(page, "Keeps its draft");
  const dialog = await openTaskDialog(page, id, "Keeps its draft");
  await dialog.getByRole("textbox", { name: "Task notes" }).fill("Unsaved draft");
  await dialog.getByRole("button", { name: /^When:/ }).click();
  const panel = page.getByRole("dialog", { name: "When", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.locator('[role="gridcell"][tabindex="0"]')).toBeFocused();
  await settleTaskPickerEntrance(panel);
  await page.mouse.click(1380, 760);
  await expect(panel).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.mouse.click(1380, 760);
  await expect(dialog).toHaveCount(0);
  const reopened = await openTaskDialog(page, id, "Keeps its draft");
  await expect(reopened.getByRole("textbox", { name: "Task notes" })).toHaveValue("");
});

test("@release Escape closes one layer and returns focus to the task row", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const id = await createTask(page, "Keyboard return");
  const dialog = await openTaskDialog(page, id, "Keyboard return");
  const when = dialog.getByRole("button", { name: /^When:/ });
  await when.click();
  const panel = page.getByRole("dialog", { name: "When", exact: true });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(when).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const rowAction = page.locator(`[data-task-id="${id}"]`).getByRole("button", { name: "Keyboard return", exact: true });
  await expect(rowAction).toBeFocused();
  await page.keyboard.press("Space");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rowAction).toBeFocused();
});

test("@release @mobile touch scrolling keeps the task dialog open", async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  const id = await createTask(page, "Reads while scrolling");
  const dialog = await openTaskDialog(page, id, "Reads while scrolling");
  await dialog.getByRole("textbox", { name: "Task notes" }).fill(Array.from({ length: 25 }, (_, i) => `Context line ${i + 1}`).join("\n"));
  await dialog.getByRole("textbox", { name: "Task notes" }).blur();
  const scroller = dialog.locator(".tasks-detail-body");
  const bounds = await scroller.boundingBox();
  expect(bounds).not.toBeNull();
  const before = await scroller.evaluate((node) => node.scrollTop);
  // Filling a growing textarea can already put the body at its bottom.
  // Drag toward available content, rather than overscrolling that boundary.
  const direction = before > 0 ? 1 : -1;
  const x = bounds!.x + bounds!.width / 2;
  const startY = bounds!.y + bounds!.height / 2 - direction * 80;
  // Await listener installation before sending any touch event. This test-
  // only signal is written by native scrollend, never by a delay or a tap.
  // The next tap then closes the task instead of stopping an active fling.
  await scroller.evaluate((node) => {
    const from = node.scrollTop;
    node.removeAttribute("data-e2e-scroll-delta");
    const finished = (event: Event) => {
      if (event.target !== node || Math.abs(node.scrollTop - from) < 1) return;
      node.setAttribute("data-e2e-scroll-delta", String(Math.abs(node.scrollTop - from)));
      node.removeEventListener("scrollend", finished);
    };
    node.addEventListener("scrollend", finished);
  });
  const touch = await page.context().newCDPSession(page);
  const at = (y: number) => ({ touchPoints: [{ x, y }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", ...at(startY) });
  for (const distance of [10, 40, 80, 120, 160]) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", ...at(startY + direction * distance) });
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => Number(await scroller.getAttribute("data-e2e-scroll-delta")), {
    timeout: 10_000,
    message: "The touch gesture must move and finish scrolling the task body",
  }).toBeGreaterThan(8);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close task", exact: true }).tap();
  await expect(dialog).toHaveCount(0);
});

/* TOAST_EXIT_SHOTS_DIR=<dir> shoots a lone task undo leaving, mid-exit. A
   local review artifact, never committed. */
const EXIT_SHOTS = process.env.TOAST_EXIT_SHOTS_DIR ?? "";

async function shootTaskUndoExit(page: Page, device: string) {
  test.setTimeout(60_000);
  await login(page);
  await page.emulateMedia({ colorScheme: "light" });
  const id = await createTask(page, "Water the plants");
  await completeFromTasks(page, "Water the plants", id);
  const pill = page.locator('[aria-live="polite"] .brain-toast');
  await pill.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(70);
  mkdirSync(EXIT_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(EXIT_SHOTS, `toast-exit-task-${device}-light.png`) });
}

test("a task undo's exit, mid-flight, on the desktop", async ({ page }) => {
  test.skip(EXIT_SHOTS === "", "artifact capture — run with TOAST_EXIT_SHOTS_DIR=<dir>");
  await page.setViewportSize({ width: 1440, height: 900 });
  await shootTaskUndoExit(page, "desktop");
});

test("@mobile a task undo's exit, mid-flight, on a phone", async ({ page }) => {
  test.skip(EXIT_SHOTS === "", "artifact capture — run with TOAST_EXIT_SHOTS_DIR=<dir>");
  await shootTaskUndoExit(page, "phone");
});

test.describe("task drag fixtures", () => {
  // These coordinate gestures need a short, isolated list. Earlier cases in
  // this file intentionally leave tasks behind; freshNotes checks one worker.
  freshNotes();

test("@release holding a task reorders it and moves categories without losing context", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const today = localToday();
  const source = "Drag planning";
  const destination = "Empty drag category";
  for (const name of [source, destination]) {
    const created = await browserJson(page, "/api/task-categories", { method: "POST", body: { name } });
    expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
  }
  const context = await createNote(page, "Drag reference", "Keep this context unchanged.\n");
  const tasks: TaskView[] = [];
  for (const [index, title] of ["Drag first", "Drag future", "Drag second", "Drag last"].entries()) {
    const created = await browserJson(page, "/api/tasks", { method: "POST", body: {
      title, category: source, when: index === 1 ? shiftDay(today, 7) : today,
      body: `Details for ${title}`, relatedPageIds: [context.id],
    } });
    expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
    tasks.push((created.body as { task: TaskView }).task);
  }
  const [first, future, second, last] = tasks;
  const workspace = page.getByTestId("tasks-surface");
  const row = (id: string) => workspace.locator(`.tasks-compact-item[data-row-key="${id}"]`);
  const visibleOrder = () => workspace.locator('.tasks-compact-item:not([data-done])').evaluateAll((rows) => rows.map((entry) => entry.getAttribute("data-row-key")));
  const rail = page.getByRole("navigation", { name: "Task categories", exact: true });
  const read = async () => {
    const response = await browserJson(page, `/api/tasks/${last.id}`);
    expect(response.ok, JSON.stringify(response.body)).toBeTruthy();
    return response.body as { task: TaskView; body: string; bodyRev: string };
  };
  const beginDrag = async () => {
    const bounds = await row(last.id).locator(".tasks-compact-open").boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + 60, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    // Await the real hold sensor, not a fixed delay or a test-only DOM flag.
    await expect(workspace).toHaveAttribute("data-dragging", "");
  };
  const saveDrop = async (x: number, y: number, feedback: Locator, edgeY?: number) => {
    await page.mouse.move(x, y, { steps: 12 });
    await expect(feedback).toBeVisible();
    if (edgeY !== undefined) await expect.poll(async () => Math.abs((await feedback.boundingBox())!.y - edgeY)).toBeLessThanOrEqual(2);
    const [response] = await Promise.all([
      page.waitForResponse((entry) => entry.url().endsWith(`/api/tasks/${last.id}/move`) && entry.request().method() === "POST"),
      page.mouse.up(),
    ]);
    expect(response.status()).toBe(200);
    await expect(workspace).not.toHaveAttribute("data-dragging", "");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  await page.goto("/tasks");
  await expect(row(last.id)).toBeVisible({ timeout: 20_000 });
  await expect.poll(visibleOrder).toEqual([first.id, second.id, last.id]);
  const original = await read();
  const target = await row(first.id).boundingBox();
  expect(target).not.toBeNull();
  await beginDrag();
  await saveDrop(target!.x + 90, target!.y + 5, page.locator('.tasks-drag-insertion .tree-insert[data-edge="before"]'), target!.y);
  await expect.poll(visibleOrder).toEqual([last.id, first.id, second.id]);
  await page.reload();
  await expect.poll(visibleOrder).toEqual([last.id, first.id, second.id]);
  await rail.getByRole("button", { name: source, exact: true }).click();
  await expect.poll(visibleOrder).toEqual([last.id, first.id, future.id, second.id]);

  // A drop on an empty category needs no visible tasks there, and keeps all
  // task content. The date is unchanged, so Today still contains this task.
  const destinationButton = rail.getByRole("button", { name: destination, exact: true });
  await expect(destinationButton).toBeVisible();
  const categoryBounds = await destinationButton.boundingBox();
  expect(categoryBounds).not.toBeNull();
  await beginDrag();
  await saveDrop(categoryBounds!.x + 70, categoryBounds!.y + categoryBounds!.height / 2, destinationButton.and(page.locator("[data-drop-into]")));
  await expect(row(last.id)).toHaveCount(0);
  const moved = await read();
  expect(moved.task.category).toBe(destination);
  expect(moved.task.when).toBe(original.task.when);
  expect(moved.task.relatedPageIds).toEqual(original.task.relatedPageIds);
  expect(moved.body).toBe(original.body);
  await Promise.all([
    page.waitForResponse((entry) => entry.url().endsWith(`/api/tasks/${last.id}/move`) && entry.request().method() === "POST"),
    page.locator('[aria-live="polite"] .brain-toast').getByRole("button", { name: "Undo", exact: true }).click(),
  ]);
  await expect(row(last.id)).toBeVisible();
  await expect.poll(visibleOrder).toEqual([last.id, first.id, future.id, second.id]);
  await page.reload();
  await rail.getByRole("button", { name: source, exact: true }).click();
  await expect.poll(visibleOrder).toEqual([last.id, first.id, future.id, second.id]);

  // Keyboard reorder uses the same persisted operation without hijacking the
  // title button's ordinary Enter/Space behaviour.
  await Promise.all([
    page.waitForResponse((entry) => entry.url().endsWith(`/api/tasks/${last.id}/move`) && entry.request().method() === "POST"),
    row(last.id).locator(".tasks-compact-open").press("Alt+Shift+ArrowDown"),
  ]);
  await expect.poll(visibleOrder).toEqual([first.id, last.id, future.id, second.id]);
  await page.reload();
  await rail.getByRole("button", { name: source, exact: true }).click();
  await expect.poll(visibleOrder).toEqual([first.id, last.id, future.id, second.id]);
  await beginDrag();
  await page.mouse.move(8, 8, { steps: 12 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(workspace).not.toHaveAttribute("data-dragging", "");
  await expect.poll(visibleOrder).toEqual([first.id, last.id, future.id, second.id]);
  await row(last.id).locator(".tasks-compact-open").click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await row(last.id).locator(".tasks-compact-open").click();
  await expect(page.getByRole("dialog", { name: last.title, exact: true })).toBeVisible();
  expect(await markdownOf(page, context.id)).toBe(context.markdown);
});

test("@release @mobile holding a task starts touch reorder instead of opening its menu", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const ids: string[] = [];
  for (const title of ["Touch first", "Touch second", "Touch third"]) ids.push(await createTask(page, title));
  await page.goto("/tasks");
  const workspace = page.getByTestId("tasks-surface");
  const order = () => workspace.locator('.tasks-compact-item:not([data-done])').evaluateAll((rows) => rows.map((entry) => entry.getAttribute("data-row-key")));
  const row = (id: string) => workspace.locator(`.tasks-compact-item[data-row-key="${id}"]`);
  await expect(row(ids[2])).toBeVisible({ timeout: 20_000 });
  await expect.poll(order).toEqual(ids);
  const from = await row(ids[2]).locator(".tasks-compact-open").boundingBox();
  const to = await row(ids[0]).boundingBox();
  expect(from).not.toBeNull(); expect(to).not.toBeNull();
  const touch = await page.context().newCDPSession(page);
  const x = from!.x + 60;
  const y = from!.y + from!.height / 2;
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await expect(workspace).toHaveAttribute("data-dragging", "");
  // Deliberately keep the finger down past Radix's long-press delay. This
  // is the gesture under test, not a wait for UI readiness.
  await page.waitForTimeout(750);
  await expect(page.getByRole("menu")).toHaveCount(0);
  for (let step = 1; step <= 10; step++) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (to!.y + 5 - y) * step / 10 }] });
  }
  await expect(page.locator('.tasks-drag-insertion .tree-insert[data-edge="before"]')).toBeVisible();
  await expect.poll(async () => Math.abs((await page.locator('.tasks-drag-insertion .tree-insert').boundingBox())!.y - to!.y)).toBeLessThanOrEqual(2);
  const [response] = await Promise.all([
    page.waitForResponse((entry) => entry.url().endsWith(`/api/tasks/${ids[2]}/move`) && entry.request().method() === "POST"),
    touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
  ]);
  expect(response.status()).toBe(200);
  await expect(workspace).not.toHaveAttribute("data-dragging", "");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(order).toEqual([ids[2], ids[0], ids[1]]);
  await page.reload();
  await expect.poll(order).toEqual([ids[2], ids[0], ids[1]]);
  await row(ids[2]).locator(".tasks-compact-open").tap();
  await expect(page.getByRole("dialog", { name: "Touch third", exact: true })).toBeVisible();
});

});
