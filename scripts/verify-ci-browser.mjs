import assert from "node:assert/strict";
import { chromium } from "playwright";

// The pinned Ubuntu runner already supplies Chromium's native libraries and
// emoji fonts. Validate the actual bundled browser instead of fetching optional
// font packs from Ubuntu mirrors. Never skip Playwright's host validation.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  const text = "Brain Chromium ready ✅";
  await page.setContent(`<p id="ready">${text}</p>`);
  await page.waitForFunction(() => document.fonts.status === "loaded");
  const content = page.locator("#ready");
  assert.equal(await content.innerText(), text);
  const bounds = await content.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
  const png = await page.screenshot();
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  console.log(`Chromium ${browser.version()} launch and render passed`);
} finally {
  await browser.close();
}
