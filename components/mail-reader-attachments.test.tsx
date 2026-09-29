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
    vi.fn(
      async (
        _blob: Blob,
        _sx: number,
        _sy: number,
        _sw: number,
        _sh: number,
        options: ImageBitmapOptions,
      ) => ({ width: options.resizeWidth!, height: options.resizeHeight!, close: () => {} }),
    ),
  );
  // A tile reads the picture's size from an <img> load of its blob URL.
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      set src(value: string) {
        if (!value) return;
        setTimeout(() => {
          this.naturalWidth = 600;
          this.naturalHeight = 800;
          this.onload?.();
        }, 0);
      }
    },
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

/** A download route that takes 10ms per file and records the order the
 *  downloads started in and the most that were ever out at once. */
function recordingFetch(files: readonly MailContentAttachmentDto[]) {
  const record = { requested: [] as string[], inFlight: 0, most: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      record.requested.push(input);
      record.inFlight += 1;
      record.most = Math.max(record.most, record.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      record.inFlight -= 1;
      const file = files.find((candidate) => input.includes(candidate.attachmentId));
      return file ? verified(file) : new Response("", { status: 404 });
    }),
  );
  return record;
}

async function renderLetter(htmlBody: string, attachments: readonly MailContentAttachmentDto[]) {
  const content = {
    apiVersion: 1 as const,
    accountId: ACCOUNT_ID,
    messageId: message.messageId,
    state: "ready" as const,
    textBody: null,
    htmlBody,
    attachments,
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
}

it("starts every image the body draws before the tiles under it take the slots", async () => {
  const inline = ["5", "6", "7"].map((digit) =>
    image(digit, {
      filename: `image00${digit}.png`,
      disposition: "inline",
      contentId: `part${digit}@example.test`,
    }),
  );
  const record = recordingFetch([...photos, ...inline]);
  await renderLetter(
    [
      "<p>Photos from the weekend.</p>",
      ...inline.map((part) => `<img data-brain-cid="${part.contentId}" alt="">`),
    ].join(""),
    [...photos, ...inline],
  );
  await vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(record.requested).toHaveLength(7);
    },
    { timeout: 3_000 },
  );

  const started = (file: MailContentAttachmentDto) =>
    record.requested.findIndex((input) => input.includes(file.attachmentId));
  const tileStarts = photos.map(started).sort((left, right) => left - right);
  for (const part of inline) {
    expect(started(part)).toBeLessThan(tileStarts[1]!);
  }
  expect(record.most).toBeLessThanOrEqual(2);
});

it("never has more than two attachment downloads out for a letter, and gets them all", async () => {
  const everything = [...photos, logo];
  const record = recordingFetch(everything);
  const requested = record.requested;
  await renderLetter(
    '<p>Photos from the weekend.</p><img data-brain-cid="logo@example.test" alt="Logo">',
    everything,
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

  expect(record.most).toBeLessThanOrEqual(2);
  expect(new Set(requested).size).toBe(5);
  // Four tiles, each drawn, and the logo drawn in the body rather than listed.
  const tiles = [...host.querySelectorAll("button.brain-mail-tile")];
  expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual(
    photos.map((photo) => `${photo.filename}, 8 B`),
  );
  expect(host.querySelectorAll("a.brain-mail-chip")).toHaveLength(0);
});
