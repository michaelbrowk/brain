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
// The second tab's SSE stream is blocked on purpose. That is not a convenience:
// it is the scenario. Somebody ticks a checkbox on their phone while the same
// note is open in a browser, and the browser then saves the body it loaded,
// which still carries the unticked line. Letting the stream through would have
// the tab reload before it ever wrote, and the merge would never be reached.
import { expect, test, type Browser, type Page } from "playwright/test";

import { parseTaskLines } from "../lib/tasks/task-lines";

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

test("a completion from Tasks lands in a note that is open and dirty in another tab", async ({
  browser,
}: {
  browser: Browser;
}) => {
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

    // `*` and not `-`: Milkdown writes every bullet marker as `*`, so a note
    // authored with `-` has EVERY line differ from the body the tab loaded on
    // its first editor save, and the merge correctly refuses a body it cannot
    // line up. That is a real seam and it belongs to the serializer, not to
    // this test, which is about a tick against a line nobody touched.
    const groceries = await createNote(
      open,
      "Groceries",
      "* [ ] water the plants\n\nnotes\n",
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
      "intro\n\n* [ ] book the flight\n\nnotes\n",
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

test("promoting a line from a note puts the task in Today and writes nothing to the markdown", async ({
  page,
}) => {
  await login(page);
  const note = await createNote(page, "Errands", "- [ ] call the bank\n\nnotes\n");
  await openNote(page, note.id);
  const before = await markdownOf(page, note.id);

  await page.locator("li.brain-task-item").first().hover();
  const ghost = page.locator("button.brain-task-mark");
  await expect(ghost).toHaveText("+ Task");
  await ghost.click();
  await page.getByRole("menuitem", { name: "Today" }).click();

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

test("deleting the line detaches the task and labels it as removed from the note", async ({
  page,
}) => {
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

test("deleting the task in Tasks leaves the line an ordinary checkbox", async ({
  page,
}) => {
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
