import { expect, test, type Page } from "playwright/test";
import { freshNotes } from "./fresh-notes";

freshNotes();

/** A PAGE WITH SEVERAL LINKED WORDS OPENS.
 *
 *  Words linked to a page (`[the spec](/p/<id>#words)`) are drawn with a
 *  marker class. On 0.21.0 a second writer put that class on the link's DOM
 *  after ProseMirror drew it: ProseMirror read the write as a DOM change, and
 *  once two links changed in one flush the redraw replaced both anchors, the
 *  writer marked the new ones, and the main thread never got out of the loop.
 *  The page never loaded. One linked link settled, and it stays here as the
 *  case that always opened; the others hold two or three, alone and next to a
 *  chip and a web link. */

async function login(page: Page) {
  await page.goto("/login");
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "e2e-password" }),
    });
    return response.status;
  });
  expect(status).toBe(200);
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
      if (!response.ok || !created.id) throw new Error(created.error ?? `HTTP ${response.status}`);
      return created.id;
    },
    { title, markdown },
  );
}

const cases: [string, (a: string, b: string) => string][] = [
  ["one linked word", (a) => `Read [the spec](/p/${a}#words) today.`],
  ["two linked words to one page", (a) => `Read [the spec](/p/${a}#words) and [the spec again](/p/${a}#words) today.`],
  ["two linked words to two pages", (a, b) => `Read [one](/p/${a}#words) then [two](/p/${b}#words) today.`],
  [
    "three linked words across two paragraphs",
    (a, b) => `Read [one](/p/${a}#words) and [two](/p/${b}#words).\n\nThen [three](/p/${a}#words) today.`,
  ],
  [
    "linked words beside a chip and a web link",
    (a, b) =>
      `Read [one](/p/${a}#words), [${"Target B"}](/p/${b}), [a site](https://example.com) and [two](/p/${b}#words) today.`,
  ],
];

for (const [name, markdown] of cases) {
  test(`a page holding ${name} opens and takes typing`, async ({ page }) => {
    await login(page);
    const a = await createPage(page, `Target A ${name}`, "");
    const b = await createPage(page, `Target B ${name}`, "");
    const id = await createPage(page, `Linked ${name}`, markdown(a, b));

    await page.goto(`/p/${id}`, { waitUntil: "commit" });
    const content = page.getByRole("textbox", { name: "Page content" });
    await expect(content).toBeVisible({ timeout: 10_000 });
    const marked = content.locator("a.brain-internal-page-link");
    await expect(marked.first()).toBeVisible({ timeout: 5_000 });

    // The caret after the last word through the DOM selection ProseMirror
    // reads: a click on the line could land on the chip and leave the page.
    await content.focus();
    await page.waitForTimeout(150);
    await content.evaluate((editor) => {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let last: Node | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes("today.")) last = node;
      }
      if (!last) throw new Error("no text today.");
      window.getSelection()?.collapse(last, last.textContent!.length);
    });
    await page.keyboard.type(" typed");
    await expect(content).toContainText("today. typed", { timeout: 5_000 });
  });
}
