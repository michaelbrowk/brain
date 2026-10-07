import { expect, test, type Page } from "playwright/test";
import { freshNotes } from "./fresh-notes";

freshNotes();

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

async function createPage(page: Page, title: string, markdown: string) {
  return page.evaluate(
    async (body) => {
      const response = await fetch("/api/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const created = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !created.id) {
        throw new Error(`Page create failed (${response.status}): ${created.error ?? "unknown"}`);
      }
      return created.id;
    },
    { title, markdown },
  );
}

async function savedMarkdown(page: Page, id: string) {
  return page.evaluate(async (pageId) => {
    const response = await fetch(`/api/page/${pageId}`);
    const body = (await response.json()) as { markdown?: string };
    return (body.markdown ?? "").trimEnd();
  }, id);
}

/** Open a page whose body is one line, and put the caret on a new empty line
 *  under it, the way a writer about to type a slash command has it. */
async function openOnNewLine(page: Page, id: string, line: string) {
  await page.goto(`/p/${id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  const intro = content.locator("p").filter({ hasText: line });
  await expect(intro).toBeVisible();
  await intro.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  return content;
}

async function runSlash(page: Page, query: string, label: string) {
  await page.keyboard.type(`/${query}`);
  const item = page
    .getByTestId("slash-menu")
    .getByRole("button", { name: label, exact: true });
  await expect(item).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("slash-menu")).toBeHidden();
}

test("/callout puts the caret in the callout and saves only what was typed", async ({ page }) => {
  await login(page);
  const id = await createPage(page, "Callout insert", "Intro");
  const content = await openOnNewLine(page, id, "Intro");

  await runSlash(page, "callout", "Callout");
  await page.keyboard.type("note body");

  await expect(content.locator(".brain-callout-content")).toHaveText("note body");
  await expect
    .poll(() => savedMarkdown(page, id), { timeout: 15_000 })
    .toBe('Intro\n\n:::callout{icon="💡"}\nnote body\n:::');
});

test("/toggle takes a title, Enter goes to the body, and a fold survives a reload", async ({
  page,
}) => {
  await login(page);
  const id = await createPage(page, "Toggle insert", "Intro");
  const content = await openOnNewLine(page, id, "Intro");

  await runSlash(page, "toggle", "Toggle");
  const toggle = content.locator("details.brain-toggle");
  await expect(toggle.locator(".brain-toggle-head")).toHaveClass(/is-empty/);
  await page.keyboard.type("Two words");
  await page.keyboard.press("Enter");
  await page.keyboard.type("body");

  await expect(toggle.locator(".brain-toggle-summary")).toHaveText("Two words");
  await expect(toggle.locator(":scope > p")).toHaveText("body");
  const saved = ':::toggle{summary="Two words"}\nbody\n:::';
  await expect
    .poll(() => savedMarkdown(page, id), { timeout: 15_000 })
    .toBe(`Intro\n\n${saved}`);

  const arrow = toggle.getByRole("button", { name: "Collapse Two words" });
  await arrow.click();
  await expect(toggle).not.toHaveAttribute("open", "");
  await expect(toggle.getByRole("button", { name: "Expand Two words" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await page.reload();
  const reopened = page
    .getByRole("textbox", { name: "Page content" })
    .locator("details.brain-toggle");
  await expect(reopened.locator(".brain-toggle-summary")).toHaveText("Two words");
  await expect(reopened).not.toHaveAttribute("open", "");
  // folding is reading, not writing: the file is what it was
  expect(await savedMarkdown(page, id)).toBe(`Intro\n\n${saved}`);

  await reopened.getByRole("button", { name: "Expand Two words" }).click();
  await expect(reopened).toHaveAttribute("open", "");
});

test("an existing toggle's title edits in place without folding it", async ({ page }) => {
  await login(page);
  const id = await createPage(page, "Toggle title", ':::toggle{summary="Details"}\nHidden\n:::');
  await page.goto(`/p/${id}`);
  const toggle = page
    .getByRole("textbox", { name: "Page content" })
    .locator("details.brain-toggle");
  const title = toggle.locator(".brain-toggle-summary");
  await expect(title).toHaveText("Details");

  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");

  await expect(title).toHaveText("Details and more");
  await expect(toggle).toHaveAttribute("open", "");
  await expect
    .poll(() => savedMarkdown(page, id), { timeout: 15_000 })
    .toBe(':::toggle{summary="Details and more"}\nHidden\n:::');
});

test("two quick Enters in a toggle title open two body lines", async ({ page }) => {
  await login(page);
  const id = await createPage(page, "Toggle double Enter", ':::toggle{summary="Title"}\nbody\n:::');
  await page.goto(`/p/${id}`);
  const toggle = page
    .getByRole("textbox", { name: "Page content" })
    .locator("details.brain-toggle");
  const title = toggle.locator(".brain-toggle-summary");
  await expect(title).toHaveText("Title");

  await title.click();
  await page.keyboard.press("End");
  // back to back, well inside the window ProseMirror's iOS replay waits for
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("x");

  await expect(title).toHaveText("Title");
  await expect(toggle.locator(":scope > p")).toHaveText(["", "x", "body"]);
  await expect
    .poll(() => savedMarkdown(page, id), { timeout: 15_000 })
    .toBe(':::toggle{summary="Title"}\n<br />\n\nx\n\nbody\n:::');
});
