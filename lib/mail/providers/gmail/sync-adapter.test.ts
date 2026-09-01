import { describe, expect, it, vi } from "vitest";

import type { GmailApiClient } from "./api-client";
import { GmailApiError, type GmailMessage, type GmailThread } from "./api-types";
import {
  GmailMailSyncAdapter,
  gmailMessageToDto,
  gmailThreadToCached,
} from "./sync-adapter";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";

describe("Gmail sync adapter projection", () => {
  it("projects bounded reader text and hidden RFC reply metadata", () => {
    const message = messageFixture();
    const dto = gmailMessageToDto(ACCOUNT_ID, message);

    expect(dto).toMatchObject({
      from: { name: "Sender", address: "sender@example.test" },
      replyTo: [{ name: "Replies", address: "reply@example.test" }],
      to: [{ name: "Reader", address: "reader@example.test" }],
      subject: "A concrete subject",
      textBody: "Hello reader",
      htmlBody: null,
      rfcMessageId: "<message-a@example.test>",
      references: ["<root@example.test>", "<parent@example.test>"],
    });
    const cached = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Thread snippet",
      historyId: "20",
      messages: [message],
    });
    expect(cached.thread).toMatchObject({
      threadId: "thread-a",
      messageCount: 1,
      unread: true,
      starred: false,
      participants: [{ address: "sender@example.test" }],
    });
    expect(cached.inInbox).toBe(true);
    expect(cached.mailboxes).toEqual(["all", "inbox"]);
  });

  it("falls back to the newest message snippet when the thread carries none", () => {
    const older = messageFixture({
      id: "message-old",
      internalDate: "1000",
      snippet: "Older snippet",
    });
    const newest = messageFixture({
      id: "message-new",
      internalDate: "2000",
      snippet: "Newest snippet",
    });
    // threads.get returns no thread-level snippet in production.
    const fallback = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: null,
      historyId: "20",
      messages: [older, newest],
    });
    expect(fallback.thread.snippet).toBe("Newest snippet");

    // An explicit thread snippet, when a response ever carries one, wins.
    const explicit = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Thread snippet",
      historyId: "20",
      messages: [older, newest],
    });
    expect(explicit.thread.snippet).toBe("Thread snippet");
  });

  it.each([
    '"Unclosed <reply@example.test>',
    Array.from(
      { length: 101 },
      (_, index) => `reply-${index}@example.test`,
    ).join(", "),
    `${"x".repeat(257)} <reply@example.test>`,
  ])("ignores malformed optional Reply-To without poisoning sync", (replyTo) => {
    const source = messageFixture();
    const projected = gmailMessageToDto(
      ACCOUNT_ID,
      messageFixture({
        payload: {
          ...source.payload!,
          headers: source.payload!.headers.map((header) =>
            header.name.toLowerCase() === "reply-to"
              ? { ...header, value: replyTo }
              : header,
          ),
        },
      }),
    );

    expect(projected.replyTo).toEqual([]);
    expect(projected.from).toEqual({
      name: "Sender",
      address: "sender@example.test",
    });
  });

  it("rejects a partly valid Reply-To list without poisoning sync", () => {
    const source = messageFixture();
    const projected = gmailMessageToDto(
      ACCOUNT_ID,
      messageFixture({
        payload: {
          ...source.payload!,
          headers: source.payload!.headers.map((header) =>
            header.name.toLowerCase() === "reply-to"
              ? {
                  ...header,
                  value: "Replies <reply@example.test>, broken-token",
                }
              : header,
          ),
        },
      }),
    );

    expect(projected.replyTo).toEqual([]);
    expect(projected.from).toEqual({
      name: "Sender",
      address: "sender@example.test",
    });
  });

  it("keeps every address from a valid Reply-To list", () => {
    const source = messageFixture();
    const projected = gmailMessageToDto(
      ACCOUNT_ID,
      messageFixture({
        payload: {
          ...source.payload!,
          headers: source.payload!.headers.map((header) =>
            header.name.toLowerCase() === "reply-to"
              ? {
                  ...header,
                  value:
                    "Replies <reply@example.test>, Escalations <escalations@example.test>",
                }
              : header,
          ),
        },
      }),
    );

    expect(projected.replyTo).toEqual([
      { name: "Replies", address: "reply@example.test" },
      { name: "Escalations", address: "escalations@example.test" },
    ]);
  });

  it("derives every system mailbox from labels across the full thread", () => {
    const cached = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Mixed mailbox thread",
      historyId: "20",
      messages: [
        messageFixture({ labelIds: ["SENT", "STARRED"] }),
        messageFixture({ id: "message-b", labelIds: ["SPAM"] }),
        messageFixture({ id: "message-c", labelIds: ["TRASH"] }),
      ],
    });

    expect(cached.inInbox).toBe(false);
    expect(cached.thread.starred).toBe(true);
    expect(cached.mailboxes).toEqual([
      "all",
      "sent",
      "spam",
      "starred",
      "trash",
    ]);
  });

  it("shows recipients instead of the sender for a sent-only thread", () => {
    const source = messageFixture();
    const cached = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Sent thread",
      historyId: "20",
      messages: [
        messageFixture({
          labelIds: ["SENT"],
          payload: {
            ...source.payload!,
            headers: [
              { name: "From", value: "Me <reader@example.test>" },
              { name: "To", value: "Alex <alex@example.test>" },
              { name: "Cc", value: "Sam <sam@example.test>" },
              { name: "Subject", value: "Sent subject" },
            ],
          },
        }),
      ],
    });

    expect(cached.thread.participants).toEqual([
      { name: "Alex", address: "alex@example.test" },
      { name: "Sam", address: "sam@example.test" },
    ]);
  });

  it("filters Gmail dotted and tagged self aliases from sent recipients", () => {
    const source = messageFixture();
    const cached = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Sent aliases",
      historyId: "20",
      messages: [
        messageFixture({
          labelIds: ["SENT"],
          payload: {
            ...source.payload!,
            headers: [
              { name: "From", value: "Me <first.last@gmail.com>" },
              {
                name: "To",
                value: "Me tagged <f.i.r.s.t.l.a.s.t+tag@googlemail.com>",
              },
              { name: "Cc", value: "Alex <alex@example.test>" },
              { name: "Subject", value: "Sent aliases" },
            ],
          },
        }),
      ],
    });

    expect(cached.thread.participants).toEqual([
      { name: "Alex", address: "alex@example.test" },
    ]);
  });

  it("strips Workspace plus tags without collapsing dots", () => {
    const source = messageFixture();
    const cached = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Workspace aliases",
      historyId: "20",
      messages: [
        messageFixture({
          labelIds: ["SENT"],
          payload: {
            ...source.payload!,
            headers: [
              { name: "From", value: "Me <first.last@company.test>" },
              {
                name: "To",
                value:
                  "Me tagged <first.last+tag@company.test>, Different mailbox <firstlast@company.test>",
              },
              { name: "Subject", value: "Workspace aliases" },
            ],
          },
        }),
      ],
    });

    expect(cached.thread.participants).toEqual([
      { name: "Different mailbox", address: "firstlast@company.test" },
    ]);
  });

  it("keeps only the other party once in a mixed sent and received thread", () => {
    const source = messageFixture();
    const cached = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Mixed thread",
      historyId: "20",
      messages: [
        messageFixture({
          id: "message-inbound",
          labelIds: ["INBOX"],
          payload: {
            ...source.payload!,
            headers: [
              { name: "From", value: "Alex <alex@example.test>" },
              { name: "To", value: "Me <reader@example.test>" },
              { name: "Subject", value: "Mixed subject" },
            ],
          },
        }),
        messageFixture({
          id: "message-outbound",
          labelIds: ["SENT"],
          internalDate: "2000",
          payload: {
            ...source.payload!,
            headers: [
              { name: "From", value: "Me <reader@example.test>" },
              {
                name: "To",
                value:
                  "Alex duplicate <ALEX@example.test>, Me <READER@example.test>",
              },
              { name: "Subject", value: "Mixed subject" },
            ],
          },
        }),
      ],
    });

    expect(cached.thread.participants).toEqual([
      { name: "Alex", address: "alex@example.test" },
    ]);
  });

  it("omits All Mail when every message is in Spam or Trash", () => {
    const cached = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Removed thread",
      historyId: "20",
      messages: [
        messageFixture({ labelIds: ["SPAM"] }),
        messageFixture({ id: "message-b", labelIds: ["TRASH", "STARRED"] }),
      ],
    });

    expect(cached.mailboxes).toEqual(["spam", "starred", "trash"]);
  });

  it("keeps draft-only and unlabeled messages in All Mail without a drafts mailbox", () => {
    const draft = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Draft thread",
      historyId: "20",
      messages: [messageFixture({ labelIds: ["DRAFT"] })],
    });
    const unlabeled = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Unlabeled thread",
      historyId: "20",
      messages: [messageFixture({ labelIds: [] })],
    });

    expect(draft.mailboxes).toEqual(["all"]);
    expect(unlabeled.mailboxes).toEqual(["all"]);
  });

  it("does not report a draft-only star as an actionable thread star", () => {
    const cached = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Starred draft",
      historyId: "20",
      messages: [messageFixture({ labelIds: ["DRAFT", "STARRED"] })],
    });

    expect(cached.thread.starred).toBe(false);
    expect(cached.mailboxes).toEqual(["all"]);
  });

  it("never persists unsanitized HTML and rejects reader fields beyond Brain bounds", () => {
    const htmlOnly = messageFixture({
      payload: {
        ...messageFixture().payload!,
        parts: [
          {
            partId: "0",
            mimeType: "text/html",
            filename: "",
            headers: [],
            body: {
              attachmentId: null,
              size: 20,
              data: Buffer.from("<script>x()</script>").toString("base64url"),
            },
            parts: [],
          },
        ],
      },
    });
    expect(gmailMessageToDto(ACCOUNT_ID, htmlOnly).htmlBody).toBeNull();

    const oversizedSubject = messageFixture({
      payload: {
        ...messageFixture().payload!,
        headers: [
          { name: "Subject", value: "x".repeat(999) },
          { name: "From", value: "sender@example.test" },
        ],
      },
    });
    expect(() => gmailMessageToDto(ACCOUNT_ID, oversizedSubject)).toThrowError(
      expect.objectContaining({ code: "mail_provider_response_invalid" }),
    );
  });

  it("decodes a declared legacy text charset without blocking the inbox", () => {
    const legacy = messageFixture({
      payload: {
        ...messageFixture().payload!,
        parts: [
          {
            partId: "0",
            mimeType: "text/plain",
            filename: "",
            headers: [
              { name: "Content-Type", value: "text/plain; charset=windows-1252" },
            ],
            body: {
              attachmentId: null,
              size: 4,
              data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64url"),
            },
            parts: [],
          },
        ],
      },
    });
    expect(gmailMessageToDto(ACCOUNT_ID, legacy).textBody).toBe("café");
  });

  it.each(["quoted-printable", "base64"])(
    "keeps the Gmail snippet but omits an encoded %s preview body",
    (transferEncoding) => {
      const encoded = messageFixture({
        snippet: "Provider-decoded snippet",
        payload: {
          ...messageFixture().payload!,
          parts: [
            {
              partId: "0",
              mimeType: "text/plain",
              filename: "",
              headers: [
                {
                  name: "Content-Transfer-Encoding",
                  value: transferEncoding,
                },
              ],
              body: {
                attachmentId: null,
                size: 18,
                data: Buffer.from("Hello =F0=9F=8C=8D").toString("base64url"),
              },
              parts: [],
            },
          ],
        },
      });

      expect(gmailMessageToDto(ACCOUNT_ID, encoded)).toMatchObject({
        snippet: "Provider-decoded snippet",
        textBody: null,
      });
    },
  );

  it("lists one bounded system-mailbox page with at most two concurrent fetches", async () => {
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const signal = new AbortController().signal;
    const listThreads = vi.fn().mockResolvedValue({
      items: Object.freeze([
        { id: "thread-a", snippet: null, historyId: "20" },
        { id: "thread-b", snippet: null, historyId: "21" },
        { id: "thread-c", snippet: null, historyId: "22" },
      ]),
      nextPageToken: "next-mailbox-page",
      resultSizeEstimate: 30,
    });
    const getThread = vi.fn(async (threadId: string, received: AbortSignal) => {
      expect(received).toBe(signal);
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      activeFetches -= 1;
      return threadFixture(threadId, ["SENT"]);
    });
    const adapter = adapterWith({ listThreads, getThread });

    const page = await adapter.listMailboxThreads(
      { mailboxId: "sent", pageToken: "mailbox-page", maxItems: 20 },
      signal,
    );

    expect(listThreads).toHaveBeenCalledWith(
      "sent",
      { pageToken: "mailbox-page", maxItems: 20, maxPages: 1 },
      signal,
    );
    expect(getThread).toHaveBeenCalledTimes(3);
    expect(maxActiveFetches).toBe(2);
    expect(page.threads.map((thread) => thread.thread.threadId)).toEqual([
      "thread-a",
      "thread-b",
      "thread-c",
    ]);
    expect(page.nextPageToken).toBe("next-mailbox-page");
    expect(page.listedCount).toBe(3);
  });

  it("skips a thread deleted between list and fetch without losing listedCount", async () => {
    const listThreads = vi.fn().mockResolvedValue({
      items: Object.freeze([
        { id: "thread-gone", snippet: null, historyId: "20" },
        { id: "thread-kept", snippet: null, historyId: "21" },
      ]),
      nextPageToken: null,
      resultSizeEstimate: 2,
    });
    const getThread = vi.fn(async (threadId: string) => {
      if (threadId === "thread-gone") {
        throw new GmailApiError("gmail_not_found");
      }
      return threadFixture(threadId, ["STARRED"]);
    });
    const adapter = adapterWith({ listThreads, getThread });

    const page = await adapter.listMailboxThreads(
      { mailboxId: "starred", pageToken: null, maxItems: 10 },
      new AbortController().signal,
    );

    expect(page.threads.map((thread) => thread.thread.threadId)).toEqual([
      "thread-kept",
    ]);
    expect(page.listedCount).toBe(2);
  });

  it("rejects Inbox, invalid page sizes, aborted work, and oversized mailbox pages", async () => {
    const listThreads = vi.fn().mockResolvedValue({
      items: Object.freeze([
        { id: "thread-a", snippet: null, historyId: "20" },
        { id: "thread-b", snippet: null, historyId: "21" },
        { id: "thread-c", snippet: null, historyId: "22" },
      ]),
      nextPageToken: null,
      resultSizeEstimate: 3,
    });
    const getThread = vi.fn(async (threadId: string) =>
      threadFixture(
        threadId,
        ["SENT"],
        Array.from({ length: 200 }, (_, index) => `${threadId}-${index}`),
      ),
    );
    const adapter = adapterWith({ listThreads, getThread });
    const signal = new AbortController().signal;

    await expect(
      adapter.listMailboxThreads(
        { mailboxId: "inbox" as "sent", pageToken: null, maxItems: 10 },
        signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_response_invalid" });
    for (const maxItems of [0, 21, 1.5]) {
      await expect(
        adapter.listMailboxThreads(
          { mailboxId: "sent", pageToken: null, maxItems },
          signal,
        ),
      ).rejects.toMatchObject({ code: "mail_provider_response_invalid" });
    }

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      adapter.listMailboxThreads(
        { mailboxId: "sent", pageToken: null, maxItems: 10 },
        aborted.signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_unavailable" });
    expect(listThreads).not.toHaveBeenCalled();

    await expect(
      adapter.listMailboxThreads(
        { mailboxId: "sent", pageToken: null, maxItems: 3 },
        signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_response_invalid" });
  });

  it("dispatches safe thread mutations to the matching Gmail methods", async () => {
    const signal = new AbortController().signal;
    const client = {
      trashThread: vi.fn().mockResolvedValue(undefined),
      untrashThread: vi.fn().mockResolvedValue(undefined),
      markThreadSpam: vi.fn().mockResolvedValue(undefined),
      markThreadNotSpam: vi.fn().mockResolvedValue(undefined),
      starThread: vi.fn().mockResolvedValue(undefined),
      unstarThread: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = mutationAdapterWith(client);

    await adapter.trashThread("thread-a", signal);
    await adapter.restoreThread("thread-b", signal);
    await adapter.setThreadSpam("thread-c", true, signal);
    await adapter.setThreadSpam("thread-d", false, signal);
    await adapter.setThreadStarred("thread-e", true, signal);
    await adapter.setThreadStarred("thread-f", false, signal);

    expect(client.trashThread).toHaveBeenCalledWith("thread-a", signal);
    expect(client.untrashThread).toHaveBeenCalledWith("thread-b", signal);
    expect(client.markThreadSpam).toHaveBeenCalledWith("thread-c", signal);
    expect(client.markThreadNotSpam).toHaveBeenCalledWith("thread-d", signal);
    expect(client.starThread).toHaveBeenCalledWith("thread-e", signal);
    expect(client.unstarThread).toHaveBeenCalledWith("thread-f", signal);
  });

  it.each([
    ["reauth", new GmailApiError("gmail_reauth_required"), "mail_provider_reauth_required"],
    ["rate limit", new GmailApiError("gmail_rate_limited"), "mail_provider_rate_limited"],
    ["invalid response", new GmailApiError("gmail_response_invalid"), "mail_provider_response_invalid"],
    ["provider unavailable", new GmailApiError("gmail_service_unavailable"), "mail_provider_unavailable"],
    ["unknown failure", new Error("private provider detail"), "mail_provider_unavailable"],
  ] as const)("maps %s failures to the stable provider error", async (_name, error, code) => {
    const adapter = mutationAdapterWith({
      trashThread: vi.fn().mockRejectedValue(error),
    });

    await expect(
      adapter.trashThread("thread-a", new AbortController().signal),
    ).rejects.toMatchObject({ code, message: code });
  });

  it.each([
    ["gmail_rate_limited", "mail_provider_rate_limited"],
    ["gmail_service_unavailable", "mail_provider_unavailable"],
  ] as const)(
    "preserves bounded Retry-After metadata for %s",
    async (gmailCode, providerCode) => {
      const adapter = mutationAdapterWith({
        trashThread: vi
          .fn()
          .mockRejectedValue(new GmailApiError(gmailCode, 90_000)),
      });

      await expect(
        adapter.trashThread("thread-a", new AbortController().signal),
      ).rejects.toMatchObject({
        code: providerCode,
        message: providerCode,
        retryAfterMs: 90_000,
      });
    },
  );

  it("rejects unsafe provider IDs before dispatching mutations", async () => {
    const trashThread = vi.fn().mockResolvedValue(undefined);
    const adapter = mutationAdapterWith({ trashThread });

    await expect(
      adapter.trashThread("../thread-a", new AbortController().signal),
    ).rejects.toMatchObject({ code: "mail_provider_response_invalid" });
    expect(trashThread).not.toHaveBeenCalled();
  });
});

describe("Gmail list-message classification and size", () => {
  it.each([
    { name: "List-Id", value: "<news.example.test>", category: "newsletter" },
    {
      name: "List-Unsubscribe",
      value: "<mailto:leave@example.test>",
      category: "newsletter",
    },
    { name: "Precedence", value: "bulk", category: "notification" },
    { name: "Precedence", value: " List ", category: "notification" },
    { name: "Auto-Submitted", value: "auto-generated", category: "notification" },
    {
      name: "Auto-Submitted",
      value: "auto-replied; owner=server",
      category: "notification",
    },
  ] as const)("classifies $name: $value as $category list mail", (header) => {
    const dto = gmailMessageToDto(
      ACCOUNT_ID,
      messageWithHeaders([{ name: header.name, value: header.value }]),
    );
    expect(dto.listMessage).toBe(true);
    expect(dto.category).toBe(header.category);
  });

  it.each([
    { name: "Precedence", value: "first-class" },
    { name: "Auto-Submitted", value: "no" },
    { name: "Auto-Submitted", value: "No ; irrelevant=param" },
  ])("keeps $name: $value out of list mail", (header) => {
    const dto = gmailMessageToDto(ACCOUNT_ID, messageWithHeaders([header]));
    expect(dto.listMessage).toBe(false);
    expect(dto.category).toBe("people");
  });

  it.each([
    "noreply@example.test",
    "no-reply@example.test",
    "no_reply@example.test",
    "no.reply@example.test",
    "noreply2@example.test",
    "noreply-sales@example.test",
    "noreplyy@example.test",
    "donotreply@example.test",
    "do-not-reply@example.test",
    "do_not_reply@example.test",
    "do.not.reply@example.test",
    "Notification@example.test",
    "notifications@example.test",
    "notify@example.test",
    "alert@example.test",
    "alerts@example.test",
    "mailer-daemon@example.test",
    "postmaster@example.test",
    "bounce@example.test",
    "bounces@example.test",
    "support@example.test",
    "help@example.test",
    "helpdesk@example.test",
    "team@example.test",
    "info@example.test",
    "news@example.test",
    "newsletter@example.test",
    "newsletters@example.test",
    "update@example.test",
    "updates@example.test",
    "digest@example.test",
    "marketing@example.test",
    "promo@example.test",
    "promotion@example.test",
    "promotions@example.test",
    "offer@example.test",
    "offers@example.test",
    "sales@example.test",
    "billing@example.test",
    "account@example.test",
    "accounts@example.test",
    "security@example.test",
    "admin@example.test",
    "administrator@example.test",
    "feedback@example.test",
    "community@example.test",
    "service@example.test",
    "welcome@example.test",
    "invoice@example.test",
    "invoices@example.test",
    "receipt@example.test",
    "receipts@example.test",
    "order@example.test",
    "orders@example.test",
    "customercare@example.test",
    "customer-care@example.test",
    "customerservice@example.test",
    "customer_service@example.test",
    "hello@example.test",
    "hello@studio.example",
    // Three labels whose first is not a mailing one, so only the local
    // part can classify this.
    "jobs@my.example.test",
    "careers@example.test",
  ])("classifies the %s sender as a notification", (address) => {
    const dto = gmailMessageToDto(ACCOUNT_ID, messageFromAddress(address));
    expect(dto.category).toBe("notification");
    expect(dto.listMessage).toBe(true);
  });

  it.each([
    "developer@email.example.test",
    "person@emails.example.test",
    "person@mail.example.test",
    "person@mailer.example.com",
    "person@news.example.test",
    "person@marketing.example.test",
    "person@m1.example.com",
    "person@digest.example.test",
    "hello@digest.example.test",
  ])("classifies the %s mailing-subdomain sender as a notification", (address) => {
    const dto = gmailMessageToDto(ACCOUNT_ID, messageFromAddress(address));
    expect(dto.category).toBe("notification");
    expect(dto.listMessage).toBe(true);
  });

  it.each([
    "sender@example.test",
    "team-noreply@example.test",
    "team+eu@example.test",
    "alerting@example.test",
    "hi@example.test",
    "contact@example.test",
    "developer@example.test",
    "developer@studio.example",
    "person@mailbox.example",
    "person@example.com",
    "person@corp.example.com",
  ])("keeps the %s sender as people mail", (address) => {
    const dto = gmailMessageToDto(ACCOUNT_ID, messageFromAddress(address));
    expect(dto.category).toBe("people");
    expect(dto.listMessage).toBe(false);
  });

  it.each(["noreply@example.test", "developer@email.example.test"])(
    "prefers newsletter over the automated %s sender",
    (address) => {
      const source = messageFromAddress(address);
      const dto = gmailMessageToDto(ACCOUNT_ID, {
        ...source,
        payload: {
          ...source.payload!,
          headers: [
            ...source.payload!.headers,
            { name: "List-Unsubscribe", value: "<mailto:leave@example.test>" },
          ],
        },
      });
      expect(dto.category).toBe("newsletter");
      expect(dto.listMessage).toBe(true);
    },
  );

  it("keeps a message without list headers out of list mail", () => {
    const dto = gmailMessageToDto(ACCOUNT_ID, messageFixture());
    expect(dto.listMessage).toBe(false);
    expect(dto.category).toBe("people");
    expect(dto.sizeEstimate).toBe(200);
  });

  it("rolls the category up with newsletter > notification > people", () => {
    const newsletter = messageWithHeaders([
      { name: "List-Id", value: "<news.example.test>" },
    ]);
    const notification = messageFixture({
      id: "message-b",
      payload: {
        ...messageFixture().payload!,
        headers: [
          ...messageFixture().payload!.headers,
          { name: "Precedence", value: "bulk" },
        ],
      },
    });
    const plain = messageFixture({ id: "message-c" });
    const rollup = (messages: readonly GmailMessage[]) =>
      gmailThreadToCached(ACCOUNT_ID, {
        id: "thread-a",
        snippet: "Thread snippet",
        historyId: "20",
        messages: [...messages],
      }).thread;

    expect(rollup([plain, notification, newsletter])).toMatchObject({
      category: "newsletter",
      listMessage: true,
    });
    expect(rollup([plain, notification])).toMatchObject({
      category: "notification",
      listMessage: true,
    });
    expect(rollup([plain])).toMatchObject({
      category: "people",
      listMessage: false,
    });
  });

  it("carries a missing size estimate as null", () => {
    expect(
      gmailMessageToDto(ACCOUNT_ID, messageFixture({ sizeEstimate: null }))
        .sizeEstimate,
    ).toBeNull();
  });

  it("rolls listMessage and best-effort sizeBytes up to the thread", () => {
    const listMail = messageWithHeaders([
      { name: "List-Id", value: "<news.example.test>" },
    ]);
    const plainMail = messageFixture({ id: "message-b", sizeEstimate: null });
    const cached = gmailThreadToCached(ACCOUNT_ID, {
      id: "thread-a",
      snippet: "Thread snippet",
      historyId: "20",
      messages: [listMail, plainMail],
    });

    expect(cached.thread.listMessage).toBe(true);
    expect(cached.thread.category).toBe("newsletter");
    // A message without a size estimate counts as zero bytes.
    expect(cached.thread.sizeBytes).toBe(200);
    expect(cached.messages.map((message) => message.listMessage)).toEqual([
      true,
      false,
    ]);
    expect(cached.messages.map((message) => message.category)).toEqual([
      "newsletter",
      "people",
    ]);
    expect(cached.messages.map((message) => message.sizeEstimate)).toEqual([
      200,
      null,
    ]);
  });
});

function messageWithHeaders(
  headers: readonly { name: string; value: string }[],
): GmailMessage {
  const source = messageFixture();
  return messageFixture({
    payload: {
      ...source.payload!,
      headers: [...source.payload!.headers, ...headers],
    },
  });
}

function messageFromAddress(address: string): GmailMessage {
  const source = messageFixture();
  return messageFixture({
    payload: {
      ...source.payload!,
      headers: source.payload!.headers.map((header) =>
        header.name.toLowerCase() === "from"
          ? { ...header, value: `Sender <${address}>` }
          : header,
      ),
    },
  });
}

function adapterWith(overrides: {
  readonly listThreads: (...args: never[]) => unknown;
  readonly getThread: (...args: never[]) => unknown;
}): GmailMailSyncAdapter {
  return new GmailMailSyncAdapter(
    ACCOUNT_ID,
    {
      listThreads: overrides.listThreads,
      getThread: overrides.getThread,
    } as unknown as GmailApiClient,
  );
}

function mutationAdapterWith(
  client: Partial<GmailApiClient>,
): GmailMailSyncAdapter {
  return new GmailMailSyncAdapter(
    ACCOUNT_ID,
    client as GmailApiClient,
  );
}

function threadFixture(
  threadId: string,
  labelIds: readonly string[],
  messageIds: readonly string[] = [`message-${threadId}`],
): GmailThread {
  return {
    id: threadId,
    snippet: `Snippet ${threadId}`,
    historyId: "20",
    messages: messageIds.map((messageId, index) =>
      messageFixture({
        id: messageId,
        threadId,
        labelIds,
        internalDate: String(1000 + index),
      }),
    ),
  };
}

function messageFixture(
  override: Partial<GmailMessage> = {},
): GmailMessage {
  return {
    id: "message-a",
    threadId: "thread-a",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Message snippet",
    historyId: "20",
    internalDate: "1000",
    sizeEstimate: 200,
    payload: {
      partId: "",
      mimeType: "multipart/alternative",
      filename: "",
      headers: [
        { name: "From", value: '"Sender" <sender@example.test>' },
        { name: "Reply-To", value: "Replies <reply@example.test>" },
        { name: "To", value: "Reader <reader@example.test>" },
        { name: "Subject", value: "A concrete subject" },
        { name: "Message-ID", value: "<message-a@example.test>" },
        {
          name: "References",
          value: "<root@example.test> <parent@example.test>",
        },
      ],
      body: { attachmentId: null, size: 0, data: null },
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          filename: "",
          headers: [],
          body: {
            attachmentId: null,
            size: 12,
            data: Buffer.from("Hello reader").toString("base64url"),
          },
          parts: [],
        },
      ],
    },
    ...override,
  };
}
