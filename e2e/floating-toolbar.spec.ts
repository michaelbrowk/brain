import { expect, test, type Page } from "playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

test("floating toolbar stays hidden after the editor loses focus", async ({ page }) => {
  await login(page);
  const created = await page.evaluate(async () => {
    const response = await fetch("/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Floating toolbar focus regression",
        markdown: "Persistent selected text",
      }),
    });
    const body = (await response.json()) as { id?: string; error?: string };
    if (!response.ok || !body.id) {
      throw new Error(
        `Page create failed (${response.status}): ${body.error ?? "unknown"}`,
      );
    }
    return { id: body.id };
  });

  await page.goto(`/p/${created.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  const paragraph = content
    .locator("p")
    .filter({ hasText: "Persistent selected text" });
  await expect(paragraph).toBeVisible();

  await paragraph.evaluate((element) => {
    const editor = element.closest<HTMLElement>('[contenteditable="true"]');
    const text = element.firstChild;
    if (!editor || !text) throw new Error("Missing editable paragraph text");
    editor.focus();
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 10);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });

  const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
  await expect(toolbar).toBeVisible();

  const blurState = await content.evaluate((editor) => {
    (editor as HTMLElement).blur();
    return {
      activeTag: document.activeElement?.tagName ?? "",
      selectedText: window.getSelection()?.toString() ?? "",
    };
  });
  expect(blurState.activeTag).toBe("BODY");
  expect(blurState.selectedText).toBe("Persistent");
  await expect(toolbar).toBeHidden();

  // The old painted range is still alive while focus belongs to the document.
  // A scroll/resize used to interpret that stale range as a fresh selection and
  // bring the toolbar back without any user selection gesture.
  await page.evaluate(() => {
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  });
  await expect(toolbar).toBeHidden();
});

test("floating toolbar preserves select-all, keyboard focus, and Link Escape", async ({
  page,
}) => {
  await login(page);
  const created = await page.evaluate(async () => {
    const response = await fetch("/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Floating toolbar selection ownership",
        markdown: "Keyboard selected text",
      }),
    });
    const body = (await response.json()) as { id?: string; error?: string };
    if (!response.ok || !body.id) {
      throw new Error(
        `Page create failed (${response.status}): ${body.error ?? "unknown"}`,
      );
    }
    return { id: body.id };
  });

  await page.goto(`/p/${created.id}`);
  const content = page.getByRole("textbox", { name: "Page content" });
  await expect(content).toBeVisible();
  await content.focus();
  await page.keyboard.press("ControlOrMeta+A");

  const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
  await expect(toolbar).toBeVisible();

  const aiButton = toolbar.getByRole("button", { name: "AI", exact: true });
  const boldButton = toolbar.getByRole("button", { name: "Bold", exact: true });
  // The editor owns Tab for indentation. Enter the toolbar without a pointer,
  // then verify that real keyboard Tab navigation does not destroy its range.
  await aiButton.focus();
  await expect(aiButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(boldButton).toBeFocused();
  await expect(toolbar).toBeVisible();

  await content.focus();
  await page.keyboard.press("ControlOrMeta+A");
  const linkButton = toolbar.getByRole("button", {
    name: "Link to page",
    exact: true,
  });
  await linkButton.click();
  const linkInput = toolbar.getByRole("textbox", { name: "Link to page" });
  await expect(linkInput).toBeFocused();

  await linkInput.press("Escape");
  await expect(linkInput).toBeHidden();
  await expect(content).toBeFocused();
  await expect(toolbar).toBeVisible();
  expect(
    await page.evaluate(() => window.getSelection()?.toString() ?? ""),
  ).toContain("Keyboard selected text");
});
