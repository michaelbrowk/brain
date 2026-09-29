// @vitest-environment jsdom

// THE SERVICE'S TWO DOWNLOAD SLOTS, SEEN FROM A WHOLE LETTER. The mail service
// streams at most two attachment downloads at once and answers a third with
// 409 `capacity_exceeded`, no queue. The body's inline images and every
// preview under the letter share that budget, so here a letter with four
// picture tiles and one inline image the body draws must never have more
// than two downloads out, and must still get all five.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY } from "@/lib/mail/content-types";
import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import type { MailMessageDto } from "@/lib/mail/message-types";
import { MailReader } from "./mail-reader";
import type { MailAccountCapabilities, MailThreadDetail } from "./mail-surface-client";

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const capabilities: MailAccountCapabilities = {
  mailboxes: ["inbox"],
  listThreads: true,
  sync: true,
  headerPreview: true,
  messageBodies: true,
  threadMutations: false,
  compose: false,
  send: false,
  reply: false,
};

const message: MailMessageDto = {
  accountId: ACCOUNT_ID,
  messageId: "message-1",
  threadId: "thread-1",
  from: { name: "Sender", address: "sender@example.test" },
  replyTo: [],
  to: [{ name: "Reader", address: "reader@example.test" }],
  cc: [],
  subject: "Photos",
  sentAt: 1_700_000_000_000,
  unread: false,
  inInbox: true,
  snippet: "Photos",
  textBody: null,
  htmlBody: null,
  hasAttachments: true,
};

const detail: MailThreadDetail = {
  apiVersion: 1,
  thread: {
    accountId: ACCOUNT_ID,
    threadId: message.threadId,
    subject: message.subject,
    participants: [message.from!],
    snippet: message.snippet,
    lastMessageAt: message.sentAt,
    messageCount: 1,
    unread: false,
    starred: false,
    hasAttachments: true,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
  },
  messages: [message],
};

function image(digit: string, overrides: Partial<MailContentAttachmentDto> = {}) {
  return {
    attachmentId: `attachment-a${digit.repeat(32)}`,
    filename: `IMG_${digit}.png`,
    mimeType: "image/png",
    disposition: "attachment",
    contentId: null,
    bytes: BYTES.byteLength,
    ...overrides,
  } satisfies MailContentAttachmentDto;
}

const photos = ["1", "2", "3", "4"].map((digit) => image(digit));
const logo = image("5", {
  filename: "image001.png",
  disposition: "inline",
  contentId: "logo@example.test",
});

function verified(file: MailContentAttachmentDto): Response {
  return new Response(BYTES as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(BYTES.byteLength),
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY,
    },
  });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (_blob: Blob, options: ImageBitmapOptions) => ({
      width: options.resizeWidth ?? 112,
      height: options.resizeWidth ?? 112,
      close: () => {},
    })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ drawImage: () => {} }) as unknown as CanvasRenderingContext2D,
  );
  let next = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:brain/${(next += 1)}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("never has more than two attachment downloads out for a letter, and gets them all", async () => {
  let inFlight = 0;
  let most = 0;
  const requested: string[] = [];
  const everything = [...photos, logo];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requested.push(input);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      const file = everything.find((candidate) => input.includes(candidate.attachmentId));
      return file ? verified(file) : new Response("", { status: 404 });
    }),
  );
  const content = {
    apiVersion: 1 as const,
    accountId: ACCOUNT_ID,
    messageId: message.messageId,
    state: "ready" as const,
    textBody: null,
    htmlBody: '<p>Photos from the weekend.</p><img data-brain-cid="logo@example.test" alt="Logo">',
    attachments: everything,
  };
  const client = {
    getMessageContent: vi.fn().mockResolvedValue(content),
    requestMessageContent: vi.fn().mockResolvedValue(content),
  };

  await act(async () =>
    root.render(
      <MailReader
        state={{ kind: "ready", detail }}
        mutating={false}
        onBack={() => {}}
        onRetry={() => {}}
        onReply={() => {}}
        onReplyAll={() => {}}
        onForward={() => {}}
        mailboxId="inbox"
        capabilities={capabilities}
        onAction={() => {}}
        contentClient={client}
      />,
    ),
  );
  await vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(requested).toHaveLength(5);
      expect(host.querySelector("iframe")?.getAttribute("srcdoc")).toContain("blob:brain/");
    },
    { timeout: 3_000 },
  );

  expect(most).toBeLessThanOrEqual(2);
  expect(new Set(requested).size).toBe(5);
  // Four tiles, each drawn, and the logo drawn in the body rather than listed.
  const tiles = [...host.querySelectorAll("button.brain-mail-tile")];
  expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual(
    photos.map((photo) => `${photo.filename}, 8 B`),
  );
  expect(host.querySelectorAll("a.brain-mail-chip")).toHaveLength(0);
});
