import { expect, test, type Page } from "playwright/test";

/** The whole visitor journey, from a link to a saved edit to a revoke, in the
 *  browser. Everything under it is already unit-tested; what this proves is
 *  that the pieces meet. */

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

/** The sign-in every other spec uses. */
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
  const body = await response.text();
  expect(
    response.status(),
    `auth failed with ${response.status()}: ${body}`,
  ).toBe(200);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

/** The markdown the owner's own API reports for a page. */
async function ownerMarkdown(page: Page, id: string) {
  const read = await browserJson(page, `/api/page/${id}`);
  return (read.body as { markdown?: string }).markdown ?? "";
}

/** How many times a phrase is on the visitor's rendered page. The server
 *  always emits the read-only render and the editor is drawn over it, so the
 *  failure mode of the one CSS rule that hides it is a body printed twice. */
async function timesOnPage(page: Page, phrase: string) {
  return page.evaluate((needle) => {
    const article = document.querySelector("article");
    if (!article) return -1;
    return (article as HTMLElement).innerText.split(needle).length - 1;
  }, phrase);
}

test("a stranger with the link edits a page, and a revoke ends it mid-session", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);

  // owner: a page to share
  await login(page);
  const createdResponse = await browserJson(page, "/api/page", {
    method: "POST",
    body: { title: "Guest chapter", markdown: "The owner's first line" },
  });
  expect(
    createdResponse.ok,
    `create failed with ${createdResponse.status}: ${JSON.stringify(createdResponse.body)}`,
  ).toBeTruthy();
  const created = createdResponse.body as { id: string };

  // owner: share it with editing on, through the card and not the API
  await page.goto(`/p/${created.id}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(
    "Guest chapter",
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const card = page.getByRole("dialog", { name: "Share settings" });
  await expect(card).toBeVisible();
  const editSwitch = page.getByRole("switch", {
    name: "Anyone with the link can edit",
  });
  await expect(editSwitch).toHaveAttribute("aria-checked", "false");
  await editSwitch.click();
  await expect(card.locator(".brain-share-head")).toHaveText(
    "Anyone with the link will be able to read and edit this page.",
  );
  await expect(card.locator('[data-share-row="edit"]')).toContainText(
    "They can change the text, upload images and make subpages. They cannot delete, move or rename anything.",
  );
  await page.getByRole("button", { name: "Share this page" }).click();

  // owner: the ledger turns into the management view and states the link
  await expect(card.locator(".brain-share-head")).toHaveText(
    "Anyone with the link can read and edit this page.",
    { timeout: 20_000 },
  );
  await expect(editSwitch).toHaveAttribute("aria-checked", "true");
  const link = await card.locator('[data-share-row="link"] a').getAttribute("href");
  expect(link).toBeTruthy();
  expect(link).toContain(`/share/${created.id}`);
  await page.keyboard.press("Escape");

  // visitor: a clean context, no session cookie
  const visitor = await browser.newContext();
  const shared = await visitor.newPage();
  try {
    await shared.goto(link!);
    await expect(shared.locator("[data-share-name-dialog]")).toBeVisible();
    // nothing is editable before a name, and the body is on the page once
    await expect(shared.locator("[data-share-editor]")).toHaveCount(0);
    expect(await timesOnPage(shared, "The owner's first line")).toBe(1);

    await shared.getByLabel("Your name").fill("Ada");
    await shared.getByRole("button", { name: "Start editing" }).click();

    const body = shared.locator("[data-share-editor] .ProseMirror");
    await expect(body).toBeVisible({ timeout: 20_000 });
    await expect(shared.locator("[data-share-name-dialog]")).toHaveCount(0);
    // the fallback is behind the sibling rule, so the render is not doubled
    await expect(shared.locator("[data-share-fallback]")).toBeHidden();
    expect(await timesOnPage(shared, "The owner's first line")).toBe(1);

    await body.click();
    await shared.keyboard.press("End");
    await shared.keyboard.type(" and a correction from a stranger");
    await expect
      .poll(() => ownerMarkdown(page, created.id), { timeout: 30_000 })
      .toContain("a correction from a stranger");

    // owner: the edit arrived, attributed to the name the visitor gave
    await page.goto("/");
    await expect(page.locator("body")).toContainText("edited by Ada", {
      timeout: 20_000,
    });

    // the visitor's draft carries an unsent edit across a reload: cut the
    // network, type, and the banner says the text is still theirs
    await shared.route("**/api/share-edit/page/**", (route) => route.abort());
    await body.click();
    await shared.keyboard.press("End");
    await shared.keyboard.type(" kept through a reload");
    await expect(shared.locator('[data-share-save-state="unsaved"]')).toContainText(
      "Your last change was not saved.",
      { timeout: 30_000 },
    );
    await shared.unroute("**/api/share-edit/page/**");
    await shared.reload();
    const restored = shared.locator("[data-share-editor] .ProseMirror");
    await expect(restored).toContainText("kept through a reload", {
      timeout: 20_000,
    });
    await expect
      .poll(() => ownerMarkdown(page, created.id), { timeout: 30_000 })
      .toContain("kept through a reload");

    // owner: stop the editing without stopping the link
    await page.goto(`/p/${created.id}`);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const liveSwitch = page.getByRole("switch", {
      name: "Anyone with the link can edit",
    });
    await expect(liveSwitch).toHaveAttribute("aria-checked", "true", {
      timeout: 20_000,
    });
    await expect(
      page.getByRole("dialog", { name: "Share settings" }).locator(
        '[data-share-row="edit"]',
      ),
    ).toContainText("Everyone using the link will be signed out.");
    await liveSwitch.click();
    await expect(page.locator("body")).toContainText("Editing turned off", {
      timeout: 20_000,
    });

    // visitor: the next save is refused, and the page says so without losing
    // the text
    await restored.click();
    await shared.keyboard.press("End");
    await shared.keyboard.type(" one more");
    await expect(shared.locator('[data-share-save-state="gone"]')).toContainText(
      "This page can no longer be edited through this link.",
      { timeout: 30_000 },
    );
    await expect(restored).toContainText("one more");

    // visitor: the reload lands on the read-only page, with no way back in
    await shared.reload();
    await expect(shared.locator("[data-share-fallback]")).toHaveCount(0);
    await expect(shared.locator("[data-share-name-dialog]")).toHaveCount(0);
    await expect(shared.locator("[data-share-editor]")).toHaveCount(0);
    await expect(shared.locator(".ProseMirror")).toContainText(
      "kept through a reload",
    );
    expect(await timesOnPage(shared, "kept through a reload")).toBe(1);
    expect(await ownerMarkdown(page, created.id)).not.toContain("one more");
  } finally {
    await visitor.close();
  }
});
