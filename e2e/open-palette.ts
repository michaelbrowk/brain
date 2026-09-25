import { expect, type Page } from "playwright/test";

/** ⌘K, PRESSED ONLY ONCE THE SHELL IS LISTENING FOR IT.
 *
 *  The shortcut lives in a mount effect in `components/shell.tsx`, so it is
 *  live a moment after hydration, not when `page.goto` resolves. Everything the
 *  shell draws is server-rendered, the Search button included, so no element
 *  being visible proves the listener is attached — and `design-audit.spec.ts`
 *  failed once in ci:local under memory pressure on exactly that gap: the press
 *  landed on inert markup and the palette never opened.
 *
 *  So the wait is for the condition the caller actually needs, which is that
 *  the shortcut is handled. Retrying a press is safe because ⌘K toggles and the
 *  check sits BETWEEN presses: a press that opens the palette ends the loop, and
 *  the only press that can follow a visible palette is one that never happened.
 *  No sleep, and no readiness attribute added to production markup for a test to
 *  read. */
export async function openPalette(page: Page): Promise<void> {
  await expect(async () => {
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}
