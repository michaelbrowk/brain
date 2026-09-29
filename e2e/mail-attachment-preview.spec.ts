import { expect, test, type Page, type Route } from "playwright/test";

import { MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY } from "../lib/mail/content-types";

/*  Part of the compact release gate (@release). A letter's pictures and PDFs
 *  open inside Brain: the tiles, the viewer's keyboard, and a real PDF drawn by
 *  pdf.js in its own module worker, which is the part no unit test can reach.
 *  Only the mail transport is stubbed; the attachment bytes are real files. */

const account = {
  accountId: "account-a0123456789abcdef0123456789abcdef",
  emailAddress: "person@example.test",
  displayName: "Personal",
  status: "connected",
  connectedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerKind: "gmail",
  capabilities: {
    mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: true,
    send: true,
    reply: true,
  },
} as const;

const thread = {
  accountId: account.accountId,
  threadId: "thread-1",
  subject: "Photos from the weekend",
  participants: [{ name: "Ben Johnson", address: "ben@example.test" }],
  snippet: "Photos attached.",
  lastMessageAt: 1_700_000_000_000,
  messageCount: 1,
  unread: false,
  starred: false,
  hasAttachments: true,
} as const;

const detail = {
  apiVersion: 1,
  thread,
  messages: [
    {
      accountId: account.accountId,
      messageId: "message-1",
      threadId: thread.threadId,
      from: { name: "Ben Johnson", address: "ben@example.test" },
      replyTo: [],
      to: [{ name: "Personal", address: account.emailAddress }],
      cc: [],
      subject: thread.subject,
      sentAt: 1_700_000_000_000,
      unread: false,
      inInbox: true,
      snippet: "Photos attached.",
      textBody: null,
      htmlBody: null,
      hasAttachments: true,
    },
  ],
} as const;

/** 2×2 PNGs, one red and one green: real files a browser decodes. */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWO4o6FxR0ODAUIBACOuBLGwh8F2AAAAAElFTkSuQmCC",
  "base64",
);
const GREEN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWPQ2GKjscWGAUIBAB5eBGF5YaPlAAAAAElFTkSuQmCC",
  "base64",
);

/** A one-page PDF with a blue square on it, its cross-reference table
 *  counted from the bytes rather than typed in. */
function onePagePdf(): Buffer {
  const content = "0 0 1 rg 20 20 160 160 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const PDF = onePagePdf();
const ZIP = Buffer.from("PK\u0005\u0006".padEnd(22, "\u0000"), "latin1");

/** Ids the client accepts: `attachment-a` and 32 hex. */
function attachmentId(digit: string): string {
  return `attachment-a${digit.repeat(32)}`;
}

const files = [
  { id: attachmentId("1"), filename: "photo-1.png", mimeType: "image/png", bytes: RED_PNG },
  { id: attachmentId("2"), filename: "photo-2.png", mimeType: "image/png", bytes: GREEN_PNG },
  { id: attachmentId("3"), filename: "agenda.pdf", mimeType: "application/pdf", bytes: PDF },
  { id: attachmentId("4"), filename: "archive.zip", mimeType: "application/zip", bytes: ZIP },
  // The signature logo the letter's HTML draws, which must not be listed again.
  {
    id: attachmentId("5"),
    filename: "image001.png",
    mimeType: "image/png",
    bytes: RED_PNG,
    inline: "logo@example.test",
  },
] as const;

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

async function installRoutes(page: Page) {
  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
  await page.route("**/api/mail/accounts/capabilities", (route) =>
    fulfill(route, { apiVersion: 3, accounts: [account] }),
  );
  await page.route(/\/api\/mail\/threads\/thread-1(?:\?.*)?$/, (route) =>
    fulfill(route, detail),
  );
  await page.route(/\/api\/mail\/threads\?.*$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      items: [thread],
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
    }),
  );
  await page.route("**/api/mail/sync", (route) =>
    fulfill(route, { apiVersion: 1, status: "idle", changedCount: 0, hasMore: false }),
  );
  await page.route("**/api/mail/drafts**", (route) =>
    fulfill(route, { apiVersion: 1, drafts: [] }),
  );
  await page.route(/\/api\/mail\/message-content\/message-1(?:\?.*)?$/, (route) =>
    fulfill(route, {
      apiVersion: 1,
      accountId: account.accountId,
      messageId: "message-1",
      state: "ready",
      textBody: null,
      htmlBody:
        '<p>Photos from the weekend, and the agenda.</p><img data-brain-cid="logo@example.test" alt="Logo">',
      attachments: files.map((file) => ({
        attachmentId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        disposition: "inline" in file ? "inline" : "attachment",
        contentId: "inline" in file ? file.inline : null,
        bytes: file.bytes.byteLength,
      })),
    }),
  );
  // The download route's own headers, so the body's inline fetch verifies.
  await page.route(/\/api\/mail\/attachments\/([^?]+)\?/, (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-1) ?? "",
    );
    const file = files.find((candidate) => candidate.id === id);
    if (!file) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      status: 200,
      body: file.bytes,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY,
      },
    });
  });
}

test("@release a letter's pictures and PDF open in the viewer, and Esc hands the tile back", async ({
  page,
}) => {
  await login(page);
  await installRoutes(page);
  await page.goto("/mail");
  await expect(page.locator('button[aria-label="Mailbox: Inbox"]')).toHaveCount(1);
  await page.getByText(thread.subject, { exact: true }).click();

  // Three tiles in list order, a chip for the zip, nothing for the logo the
  // body already draws.
  const attachments = page.getByRole("group", { name: "Attachments" });
  const tiles = attachments.locator("button.brain-mail-tile");
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0)).toHaveAccessibleName(/^photo-1\.png, /);
  await expect(tiles.nth(1)).toHaveAccessibleName(/^photo-2\.png, /);
  await expect(tiles.nth(2)).toHaveAccessibleName(/^agenda\.pdf, /);
  await expect(attachments.locator("a.brain-mail-chip")).toHaveCount(1);
  await expect(attachments.locator("a.brain-mail-chip")).toHaveAttribute("download", "archive.zip");
  await expect(attachments.getByText("image001.png")).toHaveCount(0);
  await expect
    .poll(() =>
      tiles.nth(0).locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(2);

  await tiles.nth(0).click();
  const viewer = page.locator('[role="dialog"]');
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveAttribute("aria-modal", "true");
  await expect(viewer.locator("h2")).toHaveText("photo-1.png");
  await expect(viewer.locator("[data-viewer-counter]")).toHaveText("1 of 3");
  expect(
    await page.evaluate(() => document.querySelector(".brain-shell")?.hasAttribute("inert")),
  ).toBe(true);

  await page.keyboard.press("ArrowRight");
  await expect(viewer.locator("h2")).toHaveText("photo-2.png");
  await expect(viewer.locator("[data-viewer-counter]")).toHaveText("2 of 3");
  await expect
    .poll(() =>
      viewer
        .locator('img[alt="photo-2.png"]')
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth),
    )
    .toBe(2);

  await page.keyboard.press("ArrowRight");
  await expect(viewer.locator("h2")).toHaveText("agenda.pdf");
  await expect(viewer.locator("[data-viewer-counter]")).toHaveText("3 of 3");
  await expect(viewer.getByText("Page 1 of 1")).toBeVisible();
  // pdf.js drew the page: a canvas with a real backing store, blue in the
  // middle where the square is.
  await expect
    .poll(
      () =>
        viewer.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) => {
          const box = canvas.getBoundingClientRect();
          if (canvas.width === 0 || canvas.height === 0 || box.width === 0) return null;
          const context = canvas.getContext("2d");
          const [red, green, blue] = context!.getImageData(
            Math.floor(canvas.width / 2),
            Math.floor(canvas.height / 2),
            1,
            1,
          ).data;
          return blue! > 200 && red! < 60 && green! < 60 ? "blue" : `rgb ${red} ${green} ${blue}`;
        }),
      { timeout: 15_000 },
    )
    .toBe("blue");

  // The end stops: → leaves the PDF where it is.
  await page.keyboard.press("ArrowRight");
  await expect(viewer.locator("[data-viewer-counter]")).toHaveText("3 of 3");

  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(tiles.nth(2)).toBeFocused();
  expect(
    await page.evaluate(() => document.querySelector(".brain-shell")?.hasAttribute("inert")),
  ).toBe(false);
});
