import type { FetchMessageObject, MailboxObject } from "imapflow";
import { describe, expect, it, vi } from "vitest";

import type { StoredImapMailAccount } from "../../service/account-types";
import type { ImapSessionClient } from "../../service/imapflow-adapter";
import {
  ImapMailSyncAdapter,
  imapMessageToCached,
  parseListHeaders,
} from "./sync-adapter";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";

describe("IMAP metadata sync adapter", () => {
  it("publishes a bounded newest-first Inbox metadata page as message threads", async () => {
    const fixture = providerFixture({ exists: 25, uidNext: 26 });

    const page = await fixture.provider.listInitialThreads(
      { pageToken: null, maxItems: 5 },
      new AbortController().signal,
    );

    expect(fixture.client.fetchAll).toHaveBeenCalledWith(
      "21:25",
      expect.objectContaining({
        bodyStructure: true,
        envelope: true,
        flags: true,
        internalDate: true,
        uid: true,
      }),
    );
    expect(page.threads.map((thread) => thread.thread.threadId)).toEqual([
      "i77u21",
      "i77u22",
      "i77u23",
      "i77u24",
      "i77u25",
    ]);
    expect(page.threads[0]).toMatchObject({
      thread: {
        accountId: ACCOUNT_ID,
        messageCount: 1,
        snippet: null,
        subject: "Subject 21",
      },
      inInbox: true,
      mailboxes: ["all", "inbox"],
      messages: [
        {
          accountId: ACCOUNT_ID,
          messageId: "i77u21",
          threadId: "i77u21",
          textBody: null,
          htmlBody: null,
        },
      ],
    });
    expect(page.nextPageToken).toMatch(/^i2_/);
  });

  it("caps an initial rebuild at the newest 200 messages", async () => {
    const fixture = providerFixture({ exists: 205, uidNext: 206 });
    let pageToken: string | null = null;
    const ids: string[] = [];
    for (let page = 0; page < 10; page += 1) {
      const result = await fixture.provider.listInitialThreads(
        { pageToken, maxItems: 20 },
        new AbortController().signal,
      );
      ids.push(...result.threads.map((thread) => thread.thread.threadId));
      pageToken = result.nextPageToken;
    }

    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
    expect(ids).toContain("i77u6");
    expect(ids).toContain("i77u205");
    expect(ids).not.toContain("i77u5");
    expect(pageToken).toBeNull();
  });

  it("rejects an initial continuation after impossible mailbox regression", async () => {
    const fixture = providerFixture({ exists: 25, uidNext: 26 });
    const first = await fixture.provider.listInitialThreads(
      { pageToken: null, maxItems: 5 },
      new AbortController().signal,
    );
    fixture.mailbox.uidNext = 25;

    await expect(
      fixture.provider.listInitialThreads(
        { pageToken: first.nextPageToken, maxItems: 5 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_cursor_invalid" });
  });

  it("restarts an initial snapshot when an expunge shifts sequences between pages", async () => {
    const fixture = providerFixture({ exists: 25, uidNext: 26 });
    const first = await fixture.provider.listInitialThreads(
      { pageToken: null, maxItems: 5 },
      new AbortController().signal,
    );
    vi.mocked(fixture.client.fetchAll).mockImplementationOnce(async () =>
      [17, 18, 19, 20, 21].map((uid, index) => ({
        ...messageFixture(uid),
        seq: 16 + index,
      })),
    );

    await expect(
      fixture.provider.listInitialThreads(
        { pageToken: first.nextPageToken, maxItems: 5 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_cursor_invalid" });
  });

  it("syncs new UIDs in bounded pages and reuses fetched metadata", async () => {
    const fixture = providerFixture({ exists: 2, uidNext: 3 });
    const signal = new AbortController().signal;
    const anchor = await fixture.provider.getSyncAnchor(signal);
    fixture.mailbox.exists = 4;
    fixture.mailbox.uidNext = 5;

    const first = await fixture.provider.listChanges(
      { startHistoryId: anchor, pageToken: null, maxItems: 1 },
      signal,
    );
    expect(first.changedThreadIds).toEqual(["i77u3"]);
    expect(first.nextPageToken).toMatch(/^c1_/);
    const fetched = await fixture.provider.getThread("i77u3", signal);
    expect(fetched?.thread.subject).toBe("Subject 3");
    expect(fixture.client.fetchAll).toHaveBeenCalledTimes(1);

    const second = await fixture.provider.listChanges(
      {
        startHistoryId: anchor,
        pageToken: first.nextPageToken,
        maxItems: 1,
      },
      signal,
    );
    expect(second.changedThreadIds).toEqual(["i77u4"]);
    expect(second.nextPageToken).toBeNull();
    expect(second.resultingHistoryId).not.toBe(anchor);
  });

  it("rejects out-of-range UIDs returned for an incremental UID fetch", async () => {
    const fixture = providerFixture({ exists: 2, uidNext: 3 });
    const signal = new AbortController().signal;
    const anchor = await fixture.provider.getSyncAnchor(signal);
    fixture.mailbox.exists = 3;
    fixture.mailbox.uidNext = 4;
    vi.mocked(fixture.client.fetchAll).mockResolvedValueOnce([
      { ...messageFixture(4), seq: 3 },
    ]);

    await expect(
      fixture.provider.listChanges(
        { startHistoryId: anchor, pageToken: null, maxItems: 20 },
        signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_response_invalid" });
  });

  it("forces a rebuild on UIDVALIDITY change or definite expunge", async () => {
    const fixture = providerFixture({ exists: 10, uidNext: 11 });
    const signal = new AbortController().signal;
    const anchor = await fixture.provider.getSyncAnchor(signal);

    fixture.mailbox.uidValidity = BigInt(78);
    await expect(
      fixture.provider.listChanges(
        { startHistoryId: anchor, pageToken: null, maxItems: 20 },
        signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_cursor_invalid" });

    fixture.mailbox.uidValidity = BigInt(77);
    fixture.mailbox.exists = 9;
    await expect(
      fixture.provider.listChanges(
        { startHistoryId: anchor, pageToken: null, maxItems: 20 },
        signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_cursor_invalid" });
  });

  it("periodically rebuilds so deletions and flag drift cannot remain forever", async () => {
    const fixture = providerFixture({ exists: 2, uidNext: 3 });
    const signal = new AbortController().signal;
    let anchor = await fixture.provider.getSyncAnchor(signal);
    for (let cycle = 1; cycle < 10; cycle += 1) {
      const result = await fixture.provider.listChanges(
        { startHistoryId: anchor, pageToken: null, maxItems: 20 },
        signal,
      );
      expect(result.changedThreadIds).toEqual([]);
      anchor = result.resultingHistoryId;
    }
    await expect(
      fixture.provider.listChanges(
        { startHistoryId: anchor, pageToken: null, maxItems: 20 },
        signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_cursor_invalid" });
  });

  it("keeps non-Inbox mailbox listing unavailable in this slice", async () => {
    const fixture = providerFixture({ exists: 1, uidNext: 2 });
    const signal = new AbortController().signal;

    await expect(
      fixture.provider.listMailboxThreads(
        { mailboxId: "sent", pageToken: null, maxItems: 20 },
        signal,
      ),
    ).rejects.toMatchObject({ code: "mail_provider_unavailable" });
  });

  it("bounds metadata and detects attachments without fetching message bodies", () => {
    const cached = imapMessageToCached(ACCOUNT_ID, BigInt(77), {
      seq: 1,
      uid: 8,
      flags: new Set(["\\Flagged"]),
      internalDate: new Date("2026-07-20T00:00:00Z"),
      envelope: {
        subject: "x".repeat(1_100),
        messageId: "<message@example.test>",
        inReplyTo: "<parent@example.test>",
        from: [
          { name: "Sender", address: "sender@example.test" },
          { name: "Invalid", address: "invalid" },
        ],
        to: [{ address: "reader@example.test" }],
        replyTo: [{ name: "Support", address: "reply@example.test" }],
      },
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          {
            type: "application/pdf",
            disposition: "attachment",
            dispositionParameters: { filename: "document.pdf" },
          },
        ],
      },
    });

    expect(Buffer.byteLength(cached.thread.subject ?? "")).toBe(998);
    expect(cached.thread.participants).toEqual([
      { name: "Sender", address: "sender@example.test" },
    ]);
    expect(cached.thread).toMatchObject({
      starred: true,
      unread: true,
      hasAttachments: true,
    });
    expect(cached.messages[0]).toMatchObject({
      replyTo: [{ name: "Support", address: "reply@example.test" }],
      rfcMessageId: "<message@example.test>",
      references: ["<parent@example.test>"],
      textBody: null,
      htmlBody: null,
    });
  });
});

describe("IMAP list-message classification and size", () => {
  it("requests message size and list headers in the metadata fetch", async () => {
    const fixture = providerFixture({ exists: 3, uidNext: 4 });

    await fixture.provider.listInitialThreads(
      { pageToken: null, maxItems: 5 },
      new AbortController().signal,
    );

    expect(fixture.client.fetchAll).toHaveBeenCalledWith(
      "1:3",
      expect.objectContaining({
        size: true,
        headers: ["list-id", "list-unsubscribe", "precedence", "auto-submitted"],
      }),
    );
  });

  it("unfolds continuations and matches header names case-insensitively", () => {
    const parsed = parseListHeaders(
      Buffer.from(
        "LIST-UNSUBSCRIBE:\r\n <mailto:leave@example.test>\r\n" +
          "precedence: Bulk\r\n" +
          "AUTO-submitted: auto-generated\r\n",
        "latin1",
      ),
    );

    expect(parsed).toEqual({
      hasListId: false,
      hasListUnsubscribe: true,
      precedence: "Bulk",
      autoSubmitted: "auto-generated",
    });
  });

  it("reads nothing from an absent header block", () => {
    expect(parseListHeaders(undefined)).toEqual({
      hasListId: false,
      hasListUnsubscribe: false,
      precedence: null,
      autoSubmitted: null,
    });
  });

  it.each([
    ["List-Id: <news.example.test>", "newsletter"],
    ["List-Unsubscribe: <mailto:leave@example.test>", "newsletter"],
    ["Precedence: bulk", "notification"],
    ["Precedence: List", "notification"],
    ["Auto-Submitted: auto-generated", "notification"],
    ["Auto-Submitted: auto-replied; owner=server", "notification"],
  ] as const)("classifies %s as %s list mail", (header, category) => {
    const cached = imapMessageToCached(ACCOUNT_ID, BigInt(77), {
      ...messageFixture(8),
      headers: Buffer.from(`${header}\r\n`, "latin1"),
    });
    expect(cached.thread.listMessage).toBe(true);
    expect(cached.thread.category).toBe(category);
    expect(cached.messages[0]?.listMessage).toBe(true);
    expect(cached.messages[0]?.category).toBe(category);
  });

  it.each([
    "Precedence: first-class",
    "Auto-Submitted: no",
    "Auto-Submitted: No ; irrelevant=param",
  ])("keeps %s out of list mail", (header) => {
    const cached = imapMessageToCached(ACCOUNT_ID, BigInt(77), {
      ...messageFixture(8),
      headers: Buffer.from(`${header}\r\n`, "latin1"),
    });
    expect(cached.thread.listMessage).toBe(false);
    expect(cached.thread.category).toBe("people");
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
    // Three labels whose first is not a mailing one, so only the local
    // part can classify this.
    "jobs@my.example.test",
    "careers@example.test",
  ])("classifies the %s sender as a notification", (address) => {
    const source = messageFixture(8);
    const cached = imapMessageToCached(ACCOUNT_ID, BigInt(77), {
      ...source,
      envelope: {
        ...source.envelope,
        from: [{ name: "Robot", address }],
      },
    });
    expect(cached.thread.category).toBe("notification");
    expect(cached.thread.listMessage).toBe(true);
    expect(cached.messages[0]?.category).toBe("notification");
    expect(cached.messages[0]?.listMessage).toBe(true);
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
    const source = messageFixture(8);
    const cached = imapMessageToCached(ACCOUNT_ID, BigInt(77), {
      ...source,
      envelope: {
        ...source.envelope,
        from: [{ name: "Robot", address }],
      },
    });
    expect(cached.thread.category).toBe("notification");
    expect(cached.thread.listMessage).toBe(true);
    expect(cached.messages[0]?.category).toBe("notification");
    expect(cached.messages[0]?.listMessage).toBe(true);
  });

  it.each([
    "sender@example.test",
    "team-noreply@example.test",
    "team+eu@example.test",
    "alerting@example.test",
    "hi@example.test",
    "contact@example.test",
    "developer@example.test",
    "person@example.com",
    "person@corp.example.com",
  ])("keeps the %s sender as people mail", (address) => {
    const source = messageFixture(8);
    const cached = imapMessageToCached(ACCOUNT_ID, BigInt(77), {
      ...source,
      envelope: {
        ...source.envelope,
        from: [{ name: "Sender", address }],
      },
    });
    expect(cached.thread.category).toBe("people");
    expect(cached.thread.listMessage).toBe(false);
  });

  it.each(["noreply@example.test", "developer@email.example.test"])(
    "prefers newsletter over the automated %s sender",
    (address) => {
      const source = messageFixture(8);
      const cached = imapMessageToCached(ACCOUNT_ID, BigInt(77), {
        ...source,
        envelope: {
          ...source.envelope,
          from: [{ name: "Robot", address }],
        },
        headers: Buffer.from(
          "List-Unsubscribe: <mailto:leave@example.test>\r\n",
          "latin1",
        ),
      });
      expect(cached.thread.category).toBe("newsletter");
      expect(cached.thread.listMessage).toBe(true);
    },
  );

  it("projects the exact RFC822 size and defaults a missing one to null", () => {
    const sized = imapMessageToCached(ACCOUNT_ID, BigInt(77), {
      ...messageFixture(8),
      size: 2_048,
    });
    expect(sized.messages[0]?.sizeEstimate).toBe(2_048);
    expect(sized.thread.sizeBytes).toBe(2_048);

    const unsized = imapMessageToCached(ACCOUNT_ID, BigInt(77), messageFixture(8));
    expect(unsized.messages[0]?.sizeEstimate).toBeNull();
    expect(unsized.thread.sizeBytes).toBe(0);
  });
});

function providerFixture(input: { readonly exists: number; readonly uidNext: number }) {
  const mailbox: MailboxObject = {
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    uidValidity: BigInt(77),
    uidNext: input.uidNext,
    exists: input.exists,
  };
  const client = clientFixture(mailbox);
  const sessions = {
    async withSession<T>(
      _account: StoredImapMailAccount,
      _signal: AbortSignal,
      operation: (value: ImapSessionClient) => Promise<T>,
    ): Promise<T> {
      return operation(client);
    },
  };
  return {
    mailbox,
    client,
    provider: new ImapMailSyncAdapter(accountFixture(), sessions),
  };
}

function clientFixture(mailbox: MailboxObject): ImapSessionClient & {
  readonly fetchAll: ReturnType<typeof vi.fn>;
} {
  const client = {
    secureConnection: true,
    authenticated: true,
    mailbox,
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
    unbind: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue({
      path: "INBOX",
      release: vi.fn(),
    }),
    fetchAll: vi.fn(
      async (range: string | number, _query: unknown, options?: { uid?: boolean }) => {
        const [start, end] =
          typeof range === "number"
            ? [range, range]
            : range.split(":").map(Number);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return [];
        const messages: FetchMessageObject[] = [];
        for (let value = start!; value <= end!; value += 1) {
          const uid = options?.uid ? value : value;
          if (uid >= mailbox.uidNext) continue;
          messages.push(messageFixture(uid));
        }
        return messages;
      },
    ),
  };
  return client as unknown as ImapSessionClient & {
    readonly fetchAll: ReturnType<typeof vi.fn>;
  };
}

function messageFixture(uid: number): FetchMessageObject {
  return {
    seq: uid,
    uid,
    flags: new Set(["\\Seen"]),
    internalDate: new Date(1_700_000_000_000 + uid),
    envelope: {
      subject: `Subject ${uid}`,
      messageId: `<message-${uid}@example.test>`,
      from: [{ name: `Sender ${uid}`, address: `sender${uid}@example.test` }],
      to: [{ address: "reader@example.test" }],
    },
    bodyStructure: { type: "text/plain" },
  };
}

function accountFixture(): StoredImapMailAccount {
  return Object.freeze({
    account: Object.freeze({
      accountId: ACCOUNT_ID,
      emailAddress: "reader@example.test",
      endpoint: Object.freeze({
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit" as const,
      }),
      username: "reader@example.test",
      credentialRef: Object.freeze({
        id: "credential-r11111111111111111111111111111111",
        version: 1,
      }),
      transportBindingRef: Object.freeze({
        id: "binding-r11111111111111111111111111111111",
        version: 1,
      }),
      connectedAt: 1,
    }),
    providerKind: "imap",
    displayName: null,
    status: "connected",
    createdAt: 1,
    updatedAt: 1,
  });
}
