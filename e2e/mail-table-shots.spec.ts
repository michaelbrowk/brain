// Owner-gate artifact capture for the mail reader's table layout — run on demand:
//
//   BRAIN_E2E_PORT=3136 BRAIN_DIST_DIR=.next-tables node scripts/e2e-dev.mjs
//   MAIL_TABLE_SHOTS=1 BRAIN_E2E_PORT=3136 pnpm exec playwright test e2e/mail-table-shots.spec.ts
//
// MAIL_TABLE_BEFORE=1 writes the same set under `-before-`. Run that pass on
// the commit BEFORE the fix, the way the phone artifacts are paired.
//
// One scheme only. The frame renders the sender's own colours over the sender's
// own background, so a dark pass would be the same picture twice.
//
// Screenshots land in docs/design/mail/. Skipped everywhere else so the full
// e2e suite never rewrites the artifacts on disk.
//
// The directory it writes into is on the publication denylist
// (scripts/publication-denylist.mjs), so this repository carries none of
// these frames. Shoot them, read them, throw them away — but do not commit
// them here: the forbidden-path step of `pnpm check` refuses a tracked path
// the list names.

import { expect, test } from "playwright/test";
import path from "node:path";

import { createMailHtmlDocument } from "../lib/mail/reader-html";
import { MAIL_RESOURCE_LIMITS } from "../lib/mail/security";
import { sanitizeMailHtml } from "../lib/mail/service/mail-html-sanitizer";
import {
  githubActionsRunEmailHtml,
  githubActionsRunEmailWithTokensHtml,
} from "../lib/mail/testing/reader-layout-fixtures";

const OUT = path.join(process.cwd(), "docs", "design", "mail");

test.skip(
  process.env.MAIL_TABLE_SHOTS !== "1",
  "artifact capture — run with MAIL_TABLE_SHOTS=1",
);

// 390 is the phone reader. 620 is a desktop reader column, past the 600px
// breakpoint where the sender's own nowrap still stands — the bug reached there
// too, so both widths belong in the pair.
//
// `table-390-token` is the cost of the fix rather than the bug: two cells no
// column can hold, so the message grows past the column and the frame pans
// instead of clipping.
const SHOTS = [
  { name: "table-390", width: 390, email: githubActionsRunEmailHtml },
  { name: "table-620", width: 620, email: githubActionsRunEmailHtml },
  { name: "table-390-token", width: 390, email: githubActionsRunEmailWithTokensHtml },
] as const;

function readerDocument(emailHtml: string): string {
  const sanitized = sanitizeMailHtml(emailHtml, {
    maxCharacters: MAIL_RESOURCE_LIMITS.htmlCharacters,
    maxNodes: MAIL_RESOURCE_LIMITS.maxDomNodes,
    maxAttributes: MAIL_RESOURCE_LIMITS.maxDomAttributes,
    maxRemoteImages: MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage,
  });
  expect(sanitized).not.toBeNull();
  return createMailHtmlDocument({
    sanitizedHtml: sanitized ?? "",
    attachments: [],
    cidSources: new Map(),
  });
}

test("capture the mail table artifacts", async ({ page }) => {
  // Same origin as the app so a srcdoc frame behaves, blank so the artifact is
  // the message and not the shell behind it.
  await page.goto("/login");
  // The login page is still settling its own client navigation. Replacing the
  // document under it races that and loses the frame.
  await page.waitForLoadState("networkidle");
  await page.setContent("<!doctype html><html><body></body></html>");
  for (const { name, width, email } of SHOTS) {
    const documentHtml = readerDocument(email);
    await page.evaluate(
      async ([html, frameWidth]) => {
        document.querySelector("#brain-mail-shot")?.remove();
        const host = document.createElement("div");
        host.id = "brain-mail-shot";
        host.style.cssText = `position:absolute;inset:0 auto auto 0;width:${frameWidth}px;background:#fff`;
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-same-origin");
        frame.style.cssText = "border:0;width:100%;height:2400px;display:block";
        frame.srcdoc = html as string;
        host.append(frame);
        await new Promise<void>((resolve) => {
          frame.addEventListener("load", () => resolve(), { once: true });
          document.body.append(host);
        });
        // The reader sizes the frame to its content. Do the same here so the
        // artifact is the message, not the message plus empty paper.
        const root = frame.contentDocument!.getElementById("brain-mail-content")!;
        frame.style.height = `${Math.ceil(root.scrollHeight)}px`;
      },
      [documentHtml, width] as const,
    );
    await page.waitForTimeout(200);
    const file =
      process.env.MAIL_TABLE_BEFORE === "1" ? `${name}-before.png` : `${name}.png`;
    await page.locator("#brain-mail-shot").screenshot({ path: path.join(OUT, file) });
  }
});
