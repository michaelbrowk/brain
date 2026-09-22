// Module switches: the two switches that take a whole module away, proved in
// a browser because that is the only place the sidebar, the phone bar and the
// deep link are real.
//
// EVERY TEST IN THIS FILE IS `@release`, for the reason e2e/tasks.spec.ts
// states at its head: ci.yml and release.yml both run `--grep @release`, and
// an untagged test here would run in the weekly job and nowhere else.
//
// Each test puts the switch back in a `finally`. The settings file outlives a
// test, and a suite that leaves Mail off makes every later mail spec a lie.
//
// EVERY ABSENCE IS ASSERTED AFTER A PRESENCE. Home's Today block draws nothing
// on an empty notebook and Home's mail block draws nothing with no account, so
// a bare `toHaveCount(0)` here would pass with the feature removed.
import { expect, test, type Page } from "playwright/test";

import { parseTaskLines } from "../lib/tasks/task-lines";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/auth") && candidate.request().method() === "POST",
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
    async ({ target, requestInit }) => {
      const response = await fetch(target, {
        method: requestInit.method,
        headers:
          requestInit.body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body:
          requestInit.body === undefined ? undefined : JSON.stringify(requestInit.body),
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
      };
    },
    { target: requestPath, requestInit: init },
  );
}

async function setModule(page: Page, moduleName: "mail" | "tasks", on: boolean) {
  const answer = await browserJson(page, "/api/settings/modules", {
    method: "PUT",
    body: { [moduleName]: on },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A note with one task line, and a record linked to that line, built through
 *  the API exactly the way `e2e/tasks.spec.ts` builds one. The promotion
 *  happens BEFORE the switch goes off, because a line that was never a task
 *  proves nothing about the reconcile being skipped. */
async function promotedNote(page: Page) {
  const created = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Module switch note", markdown: "- [ ] Water the plants\n" },
  });
  expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
  const id = (created.body as { id: string }).id;
  const read = await browserJson(page, `/api/page/${id}`);
  const markdown = (read.body as { markdown: string }).markdown;
  const line = parseTaskLines(markdown)[0];
  expect(line, `no task line in ${JSON.stringify(markdown)}`).toBeTruthy();
  const task = await browserJson(page, "/api/tasks", {
    method: "POST",
    body: {
      title: line!.normalized,
      when: localToday(),
      page: id,
      anchor: {
        text: line!.normalized,
        hash: line!.hash,
        ordinal: line!.ordinal,
        line: line!.index,
      },
    },
  });
  expect(task.ok, JSON.stringify(task.body)).toBeTruthy();
  return { id, taskId: (task.body as { task: { id: string } }).task.id };
}

test("@release turning Mail off takes its surfaces and its routes away", async ({ page }) => {
  await login(page);
  const row = page.getByRole("button", { name: "Mail", exact: true });
  await expect(row).toBeVisible();
  // Not a 200: this runner has no mail service, so the route answers an
  // outage. What matters is that it reaches the handler at all, which is
  // exactly what the gate takes away below.
  expect((await browserJson(page, "/api/mail/accounts")).status).not.toBe(409);

  await setModule(page, "mail", false);
  try {
    // The live event re-renders every open tab, with no reload.
    await expect(row).toHaveCount(0);
    const refused = await browserJson(page, "/api/mail/accounts");
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "module_off", module: "mail" });
    // A second route, so the gate reads as a prefix rather than one lucky
    // path. Every file under it, the three picture proxies included, is
    // pinned by the directory sweep in `lib/module-gate.test.ts`.
    expect((await browserJson(page, "/api/mail/threads")).status).toBe(409);

    // A deep link lands on Home rather than on an empty Mail, server-side and
    // on the first paint rather than after a client-side bounce.
    await page.goto("/mail");
    await expect(page).toHaveURL("/");

    // And the settings deep link opens the first section instead of 404ing:
    // the slug is still legal, it just has nothing to draw. The URL is left
    // alone on purpose, so the bookmark still works when Mail comes back.
    await page.goto("/settings/mail");
    await expect(page.getByText("Reading typeface")).toBeVisible();

    // The palette does not offer a destination that is gone.
    await page.goto("/");
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("option", { name: "Open Mail" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    await setModule(page, "mail", true);
  }
  await page.goto("/");
  await expect(row).toBeVisible();
  expect((await browserJson(page, "/api/mail/accounts")).status).not.toBe(409);
});

test("@release turning Tasks off leaves the note, the checkbox and the record alone", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  const { id, taskId } = await promotedNote(page);
  await page.goto("/");

  // PRESENCE FIRST: the block exists to be taken away.
  const row = page.getByRole("button", { name: "Tasks", exact: true });
  await expect(row).toBeVisible();
  await expect(page.locator("[data-hub-today]")).toBeVisible();
  await expect(page.locator("[data-hub-capture-task]")).toBeVisible();

  const before = await browserJson(page, `/api/tasks/${taskId}`);
  expect(before.status).toBe(200);
  expect((before.body as { task: { done: boolean } }).task.done).toBe(false);

  await setModule(page, "tasks", false);
  try {
    await expect(row).toHaveCount(0);
    await expect(page.locator("[data-hub-today]")).toHaveCount(0);
    await expect(page.locator("[data-hub-capture-task]")).toHaveCount(0);
    const refused = await browserJson(page, `/api/tasks?today=${localToday()}`);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "module_off", module: "tasks" });

    await page.goto("/tasks");
    await expect(page).toHaveURL("/");

    // THE CHECKBOX IS ORDINARY MARKDOWN AND KEEPS WORKING, and the promote
    // word that would make a record out of it is gone.
    await page.goto(`/p/${id}`);
    await expect(page.getByRole("textbox", { name: "Page content" })).toBeVisible({
      timeout: 20_000,
    });
    const box = page.locator("li.brain-task-item button.brain-task-box").first();
    await expect(box).toBeVisible();
    await page.locator("li.brain-task-item").first().hover();
    await expect(page.locator("button.brain-task-mark")).toHaveCount(0);
    await box.click();
    await expect
      .poll(
        async () => {
          const read = await browserJson(page, `/api/page/${id}`);
          return (read.body as { markdown: string }).markdown;
        },
        { timeout: 20_000 },
      )
      .toContain("[x] Water the plants");
  } finally {
    await setModule(page, "tasks", true);
  }

  // The record is exactly where the switch found it: the tick changed the
  // note and nothing else, and the next save is what will reconcile it.
  const after = await browserJson(page, `/api/tasks/${taskId}`);
  expect(after.status).toBe(200);
  expect((after.body as { task: { done: boolean } }).task.done).toBe(false);
  await page.goto("/");
  await expect(row).toBeVisible();
});

test("@release @mobile the bar draws five, four and three slots", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const tabs = page.locator("[data-mobile-tab]");
  await expect(tabs).toHaveCount(5);

  const trackCount = () =>
    page
      .locator(".brain-mobile-tabbar-items")
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
      );
  expect(await trackCount()).toBe(5);

  await setModule(page, "mail", false);
  try {
    await expect(tabs).toHaveCount(4);
    expect(await trackCount()).toBe(4);

    await setModule(page, "tasks", false);
    await expect(tabs).toHaveCount(3);
    // The grid follows the slots rather than staying at five and leaving two
    // empty columns, which is what a literal `repeat(5, …)` would have done.
    expect(await trackCount()).toBe(3);
    await expect(page.locator('[data-mobile-tab="home"]')).toBeVisible();
    await expect(page.locator(".brain-mobile-new")).toBeVisible();
  } finally {
    await setModule(page, "mail", true);
    await setModule(page, "tasks", true);
  }
  await expect(tabs).toHaveCount(5);
});
