// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY } from "@/lib/mail/content-types";
import type { MailMessageDto } from "@/lib/mail/message-types";
import {
  CONTENT_MAX_REQUESTS,
  CONTENT_POLL_BASE_DELAY_MS,
  CONTENT_POLL_DEADLINE_MS,
  CONTENT_POLL_MAX_DELAY_MS,
  CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST,
  MailReader,
  pollDelayMs,
  REMOTE_IMAGE_LOAD_DEADLINE_MS,
  remoteImagePollDelayMs,
} from "./mail-reader";
import type {
  MailAccountCapabilities,
  MailSurfaceClient,
  MailThreadDetail,
} from "./mail-surface-client";

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";
const FIRST_REMOTE_ID = `remote-image-a${"1".repeat(32)}`;
const SECOND_REMOTE_ID = `remote-image-a${"2".repeat(32)}`;

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
  subject: "Remote images",
  sentAt: 1_700_000_000_000,
  unread: false,
  inInbox: true,
  snippet: "Preview",
  textBody: null,
  htmlBody: null,
  hasAttachments: false,
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
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
  },
  messages: [message],
};

function contentClient(
  content: Awaited<ReturnType<MailSurfaceClient["requestMessageContent"]>>,
): Pick<MailSurfaceClient, "getMessageContent" | "requestMessageContent"> {
  return {
    getMessageContent: vi.fn().mockResolvedValue(content),
    requestMessageContent: vi.fn().mockResolvedValue(content),
  };
}

function reader(
  client: Pick<MailSurfaceClient, "getMessageContent" | "requestMessageContent">,
  ready = true,
) {
  return (
    <MailReader
      state={ready ? { kind: "ready", detail } : { kind: "idle" }}
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
    />
  );
}

function verifiedRemoteResponse(body: Buffer): Response {
  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(body.byteLength),
      "Content-Disposition": 'attachment; filename="remote.png"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY,
    },
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MailReader remote image lifecycle", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not fetch remote or CID images when clean plain text is preferred", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = contentClient({
      apiVersion: 1,
      accountId: ACCOUNT_ID,
      messageId: message.messageId,
      state: "ready",
      textBody: "Readable plain message",
      htmlBody: [
        "<p>Damaged \ufffd newsletter</p>",
        `<img data-brain-remote-image="${FIRST_REMOTE_ID}" alt="Remote">`,
        '<img data-brain-cid="logo@example.test" alt="Logo">',
      ].join(""),
      attachments: [
        {
          attachmentId: `attachment-a${"3".repeat(32)}`,
          filename: "logo.png",
          mimeType: "image/png",
          disposition: "inline",
          contentId: "logo@example.test",
          bytes: 4,
        },
      ],
    });

    await act(async () => root.render(reader(client)));
    await settle();

    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("Readable plain message");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes completed blob URLs immediately when pending image work is aborted", async () => {
    const body = Buffer.from("verified remote image");
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:https://brain.test/first-remote");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    let pendingSignal: AbortSignal | null = null;
    const fetchMock = vi.fn(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (String(input).includes(FIRST_REMOTE_ID)) {
          return Promise.resolve(verifiedRemoteResponse(body));
        }
        pendingSignal = init?.signal ?? null;
        return new Promise<Response>((_resolve, reject) => {
          pendingSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = contentClient({
      apiVersion: 1,
      accountId: ACCOUNT_ID,
      messageId: message.messageId,
      state: "ready",
      textBody: null,
      htmlBody: [
        `<img data-brain-remote-image="${FIRST_REMOTE_ID}" alt="First">`,
        `<img data-brain-remote-image="${SECOND_REMOTE_ID}" alt="Second">`,
      ].join(""),
      attachments: [],
    });

    await act(async () => root.render(reader(client)));
    await settle();
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((pendingSignal as AbortSignal | null)?.aborted).toBe(false);

    await act(async () => root.render(reader(client, false)));
    await settle();

    expect((pendingSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(
      "blob:https://brain.test/first-remote",
    );
  });

  it("polls the cache after a cold miss and renders the image once ready", async () => {
    vi.useFakeTimers();
    const body = Buffer.from("verified remote image");
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:https://brain.test/eventual-remote");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(verifiedRemoteResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const client = contentClient({
      apiVersion: 1,
      accountId: ACCOUNT_ID,
      messageId: message.messageId,
      state: "ready",
      textBody: null,
      htmlBody: `<img data-brain-remote-image="${FIRST_REMOTE_ID}" alt="Remote">`,
      attachments: [],
    });

    await act(async () => root.render(reader(client)));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(500));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0]).toMatchObject({
      size: body.byteLength,
      type: "image/png",
    });
  });
});

describe("MailReader remote image demand", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const singleImage = {
    apiVersion: 1 as const,
    accountId: ACCOUNT_ID,
    messageId: message.messageId,
    state: "ready" as const,
    textBody: null,
    htmlBody: `<img data-brain-remote-image="${FIRST_REMOTE_ID}" alt="Remote">`,
    attachments: [],
  };

  it("asks for the message again after a run of cache misses, a bounded number of times", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(null, { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = contentClient(singleImage);

    await act(async () => root.render(reader(client)));
    await settle();
    // The body path made the first request. The image path re-asks after
    // every run of consecutive misses until the shared budget is spent.
    expect(client.requestMessageContent).toHaveBeenCalledTimes(1);
    let polls = 1;
    let attempt = 0;
    const advanceOnePoll = async () => {
      await act(async () =>
        vi.advanceTimersByTimeAsync(remoteImagePollDelayMs(attempt)),
      );
      await settle();
      attempt += 1;
      polls += 1;
      expect(fetchMock).toHaveBeenCalledTimes(polls);
    };
    // The first poll already counted as one miss.
    for (let miss = 1; miss < CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST; miss += 1) {
      await advanceOnePoll();
    }
    expect(client.requestMessageContent).toHaveBeenCalledTimes(2);
    for (let request = 3; request <= CONTENT_MAX_REQUESTS; request += 1) {
      for (let miss = 0; miss < CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST; miss += 1) {
        await advanceOnePoll();
      }
      expect(client.requestMessageContent).toHaveBeenCalledTimes(request);
    }
    // One more run of misses with nothing left to ask: the image gives up
    // instead of polling forever.
    for (let miss = 0; miss < CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST; miss += 1) {
      await advanceOnePoll();
    }
    const finalPolls = fetchMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(finalPolls);
    expect(client.requestMessageContent).toHaveBeenCalledTimes(CONTENT_MAX_REQUESTS);
    expect(signals.at(-1)?.aborted).toBe(false);
  });

  it("does not let the load deadline expire while the cache is still answering", async () => {
    vi.useFakeTimers();
    const answerDelayMs = 35_000;
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          if (init?.signal) signals.push(init.signal);
          setTimeout(() => resolve(new Response(null, { status: 503 })), answerDelayMs);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = contentClient(singleImage);

    await act(async () => root.render(reader(client)));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Three slow answers straddle the 90-second deadline. A deadline armed
    // once at the start would abort the third poll mid-flight; one that is
    // re-armed by every answer lets the run finish and ask again.
    let elapsed = 0;
    for (let poll = 1; poll < CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST; poll += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(answerDelayMs));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(remoteImagePollDelayMs(poll - 1)));
      await settle();
      elapsed += answerDelayMs + remoteImagePollDelayMs(poll - 1);
      expect(fetchMock).toHaveBeenCalledTimes(poll + 1);
    }
    expect(elapsed).toBeLessThan(REMOTE_IMAGE_LOAD_DEADLINE_MS);
    await act(async () =>
      vi.advanceTimersByTimeAsync(REMOTE_IMAGE_LOAD_DEADLINE_MS - elapsed + 1_000),
    );
    await settle();
    expect(signals.at(-1)?.aborted).toBe(false);
    expect(client.requestMessageContent).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(answerDelayMs));
    await settle();
    expect(client.requestMessageContent).toHaveBeenCalledTimes(2);
    expect(signals.at(-1)?.aborted).toBe(false);
  });

  it("treats a missing image as one more ask, not a permanent stop", async () => {
    vi.useFakeTimers();
    const body = Buffer.from("verified remote image");
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:https://brain.test/re-asked-remote");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(verifiedRemoteResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const client = contentClient(singleImage);

    await act(async () => root.render(reader(client)));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.requestMessageContent).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(remoteImagePollDelayMs(0)));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("stops on a refused image without spending an ask", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 410 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = contentClient(singleImage);

    await act(async () => root.render(reader(client)));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.requestMessageContent).toHaveBeenCalledTimes(1);
  });

  it("draws the images' re-asks from the budget the body already spent on", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      getMessageContent: vi.fn().mockResolvedValue(singleImage),
      requestMessageContent: vi
        .fn()
        .mockResolvedValueOnce({
          apiVersion: 1 as const,
          accountId: ACCOUNT_ID,
          messageId: message.messageId,
          state: "not_requested" as const,
        })
        .mockResolvedValue(singleImage),
    };

    // The body's first answer is a dropped row, so the body asks a second
    // time before it renders. That leaves the images one ask, not two.
    await act(async () => root.render(reader(client)));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await settle();
    expect(client.requestMessageContent).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    let attempt = 0;
    for (let miss = 1; miss < CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST; miss += 1) {
      await act(async () =>
        vi.advanceTimersByTimeAsync(remoteImagePollDelayMs(attempt)),
      );
      await settle();
      attempt += 1;
    }
    expect(client.requestMessageContent).toHaveBeenCalledTimes(CONTENT_MAX_REQUESTS);
    for (let miss = 0; miss < CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST; miss += 1) {
      await act(async () =>
        vi.advanceTimersByTimeAsync(remoteImagePollDelayMs(attempt)),
      );
      await settle();
      attempt += 1;
    }
    const finalPolls = fetchMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(finalPolls);
    expect(finalPolls).toBe(2 * CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST);
    expect(client.requestMessageContent).toHaveBeenCalledTimes(CONTENT_MAX_REQUESTS);
  });

  it("stops after a second missing answer once the re-ask changed nothing", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = contentClient(singleImage);

    await act(async () => root.render(reader(client)));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(remoteImagePollDelayMs(0)));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.requestMessageContent).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.requestMessageContent).toHaveBeenCalledTimes(2);
  });
});

describe("MailReader content poll budget", () => {
  it("covers the 30-second deadline with a capped exponential ladder", () => {
    expect(CONTENT_POLL_DEADLINE_MS).toBe(30_000);
    expect(CONTENT_POLL_MAX_DELAY_MS).toBe(2_400);
    expect(pollDelayMs(0)).toBe(0);
    expect(pollDelayMs(1)).toBe(CONTENT_POLL_BASE_DELAY_MS);
    expect(pollDelayMs(4)).toBe(CONTENT_POLL_MAX_DELAY_MS);
    expect(pollDelayMs(20)).toBe(CONTENT_POLL_MAX_DELAY_MS);

    // The capped ladder reaches the full deadline in a bounded attempt count.
    let elapsed = 0;
    let attempts = 0;
    while (elapsed < CONTENT_POLL_DEADLINE_MS && attempts < 100) {
      elapsed += pollDelayMs(attempts);
      attempts += 1;
    }
    expect(elapsed).toBeGreaterThanOrEqual(CONTENT_POLL_DEADLINE_MS);
    expect(attempts).toBeLessThanOrEqual(20);
  });
});
