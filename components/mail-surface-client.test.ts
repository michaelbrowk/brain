import { afterEach, describe, expect, it, vi } from "vitest";

import { MAIL_RESOURCE_LIMITS } from "@/lib/mail/security";
import {
  clearOpenThreadRequest,
  defaultMailSurfaceClient,
  isDeletableDraft,
  isListedDraft,
  isMailMutationTimeout,
  isResumableDraft,
  MAIL_MUTATION_TIMEOUT_MS,
  MAX_MAIL_ACCOUNTS,
  MailApiError,
  pendingOpenThread,
  requestOpenThread,
  subscribeOpenThread,
  type MailDraftState,
  type MailDraftSummary,
  type MailSystemMailbox,
} from "./mail-surface-client";

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";
const THREAD_ID = "thread-1";
const thread = {
  accountId: ACCOUNT_ID,
  threadId: THREAD_ID,
  subject: "Folder contract",
  participants: [{ name: "Ben", address: "ben@example.test" }],
  snippet: "Cached safely",
  lastMessageAt: 1_700_000_000_000,
  messageCount: 1,
  unread: true,
  starred: false,
  hasAttachments: false,
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("defaultMailSurfaceClient system mailboxes", () => {
  it("rejects an Inbox page containing another account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          apiVersion: 1,
          items: [
            {
              ...thread,
              accountId: "account-a11111111111111111111111111111111",
            },
          ],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
        }),
      ),
    );

    await expect(
      defaultMailSurfaceClient.listThreads({ accountId: ACCOUNT_ID }),
    ).rejects.toThrow("invalid mail thread list");
  });

  it("loads an exact mailbox snapshot and binds the requested mailbox", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        apiVersion: 1,
        mailboxId: "sent",
        items: [thread],
        nextCursor: "cursor_1",
        availability: {
          status: "available",
          lastSuccessfulAt: 1_700_000_000_000,
          windowTruncated: false,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultMailSurfaceClient.listMailboxThreads({
        accountId: ACCOUNT_ID,
        mailboxId: "sent",
        cursor: "cursor_0",
        limit: 25,
      }),
    ).resolves.toMatchObject({ mailboxId: "sent", items: [thread] });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/mailboxes/sent/threads?accountId=${ACCOUNT_ID}&limit=25&cursor=cursor_0`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("rejects a mailbox response for a different folder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          apiVersion: 1,
          mailboxId: "trash",
          items: [],
          nextCursor: null,
          availability: {
            status: "available",
            lastSuccessfulAt: 1_700_000_000_000,
            windowTruncated: false,
          },
        }),
      ),
    );

    await expect(
      defaultMailSurfaceClient.listMailboxThreads({
        accountId: ACCOUNT_ID,
        mailboxId: "sent",
      }),
    ).rejects.toThrow("invalid mail mailbox thread list");
  });

  it("reads an old apiVersion 1 thread without star state as safely unstarred", async () => {
    const threadWithoutStarred = Object.fromEntries(
      Object.entries(thread).filter(([key]) => key !== "starred"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          apiVersion: 1,
          mailboxId: "sent",
          items: [threadWithoutStarred],
          nextCursor: null,
          availability: {
            status: "available",
            lastSuccessfulAt: 1_700_000_000_000,
            windowTruncated: false,
          },
        }),
      ),
    );

    await expect(
      defaultMailSurfaceClient.listMailboxThreads({
        accountId: ACCOUNT_ID,
        mailboxId: "sent",
      }),
    ).resolves.toMatchObject({ items: [{ starred: false }] });
  });

  it("sends view and sort params only when non-default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        apiVersion: 1,
        items: [thread],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await defaultMailSurfaceClient.listThreads({
      accountId: ACCOUNT_ID,
      limit: 25,
      view: "lists",
      sort: "size",
    });
    await defaultMailSurfaceClient.listThreads({
      accountId: ACCOUNT_ID,
      limit: 25,
      sort: "date",
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/mail/threads?accountId=${ACCOUNT_ID}&limit=25&view=lists&sort=size`,
      `/api/mail/threads?accountId=${ACCOUNT_ID}&limit=25`,
    ]);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(
      response({
        apiVersion: 1,
        mailboxId: "sent",
        items: [],
        nextCursor: null,
        availability: {
          status: "available",
          lastSuccessfulAt: 1_700_000_000_000,
          windowTruncated: false,
        },
      }),
    );
    await defaultMailSurfaceClient.listMailboxThreads({
      accountId: ACCOUNT_ID,
      mailboxId: "sent",
      limit: 25,
      view: "people",
      sort: "sender",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/mailboxes/sent/threads?accountId=${ACCOUNT_ID}&limit=25&view=people&sort=sender`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("reads the tier-3 fields together or not at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          apiVersion: 1,
          items: [{ ...thread, listMessage: true, sizeBytes: 4_096 }],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
        }),
      ),
    );
    await expect(
      defaultMailSurfaceClient.listThreads({ accountId: ACCOUNT_ID }),
    ).resolves.toMatchObject({
      items: [{ listMessage: true, sizeBytes: 4_096 }],
    });

    // A tier-2 projection omits both fields; the defaults stay safe.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          apiVersion: 1,
          items: [thread],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
        }),
      ),
    );
    await expect(
      defaultMailSurfaceClient.listThreads({ accountId: ACCOUNT_ID }),
    ).resolves.toMatchObject({ items: [{ listMessage: false, sizeBytes: 0 }] });

    for (const partial of [
      { ...thread, listMessage: true },
      { ...thread, sizeBytes: 4_096 },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          response({
            apiVersion: 1,
            items: [partial],
            nextCursor: null,
            sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
          }),
        ),
      );
      await expect(
        defaultMailSurfaceClient.listThreads({ accountId: ACCOUNT_ID }),
      ).rejects.toThrow("invalid mail thread");
    }
  });

  it("reads the tier-4 category and defaults it to people when absent", async () => {
    for (const category of ["people", "notification", "newsletter"] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          response({
            apiVersion: 1,
            items: [{ ...thread, category }],
            nextCursor: null,
            sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
          }),
        ),
      );
      await expect(
        defaultMailSurfaceClient.listThreads({ accountId: ACCOUNT_ID }),
      ).resolves.toMatchObject({ items: [{ category }] });
    }

    // A tier-3 projection omits category; the default stays safe.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          apiVersion: 1,
          items: [thread],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
        }),
      ),
    );
    await expect(
      defaultMailSurfaceClient.listThreads({ accountId: ACCOUNT_ID }),
    ).resolves.toMatchObject({ items: [{ category: "people" }] });

    for (const invalid of [
      { ...thread, category: "spam" },
      { ...thread, category: true },
      { ...thread, category: "people", categories: "people" },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          response({
            apiVersion: 1,
            items: [invalid],
            nextCursor: null,
            sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
          }),
        ),
      );
      await expect(
        defaultMailSurfaceClient.listThreads({ accountId: ACCOUNT_ID }),
      ).rejects.toThrow("invalid mail thread");
    }
  });

  it("reads the tier-5 newSender and reads an older server's thread as not waiting", async () => {
    const list = (items: readonly unknown[]) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          response({
            apiVersion: 1,
            items,
            nextCursor: null,
            sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
          }),
        ),
      );
      return defaultMailSurfaceClient.listThreads({ accountId: ACCOUNT_ID });
    };
    const older = Object.fromEntries(
      Object.entries(thread).filter(([key]) => key !== "newSender"),
    );

    await expect(list([{ ...thread, newSender: true }])).resolves.toMatchObject({
      items: [{ newSender: true }],
    });
    await expect(list([older])).resolves.toMatchObject({ items: [{ newSender: false }] });
    for (const invalid of [
      { ...thread, newSender: "yes" },
      { ...thread, newSender: 1 },
      { ...thread, newSender: null },
    ]) {
      await expect(list([invalid])).rejects.toThrow("invalid mail thread");
    }
  });

  it("reads a blocked sender's mark, and only as a mark", async () => {
    const list = (items: readonly unknown[]) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          response({
            apiVersion: 1,
            items,
            nextCursor: null,
            sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
          }),
        ),
      );
      return defaultMailSurfaceClient.listThreads({ accountId: ACCOUNT_ID });
    };
    await expect(
      list([{ ...thread, newSender: false, senderBlocked: true }]),
    ).resolves.toMatchObject({ items: [{ senderBlocked: true }] });
    for (const invalid of [
      { ...thread, newSender: false, senderBlocked: false },
      {
        ...thread,
        newSender: true,
        newSenderFrom: { name: null, address: "x@example.test" },
        senderBlocked: true,
      },
    ]) {
      await expect(list([invalid])).rejects.toThrow("invalid mail thread");
    }
  });

  it("reads the sender a waiting thread names, and only on a waiting thread", async () => {
    const list = (items: readonly unknown[]) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          response({
            apiVersion: 1,
            items,
            nextCursor: null,
            sync: { status: "idle", lastSuccessfulAt: 1_700_000_000_000 },
          }),
        ),
      );
      return defaultMailSurfaceClient.listThreads({ accountId: ACCOUNT_ID });
    };
    const from = { name: "Lena Okafor", address: "lena@okafor.example" };

    await expect(
      list([{ ...thread, newSender: true, newSenderFrom: from }]),
    ).resolves.toMatchObject({ items: [{ newSender: true, newSenderFrom: from }] });
    for (const invalid of [
      { ...thread, newSender: false, newSenderFrom: from },
      { ...thread, newSender: true, newSenderFrom: null },
      { ...thread, newSender: true, newSenderFrom: { name: null, address: "nobody" } },
    ]) {
      await expect(list([invalid])).rejects.toThrow("invalid mail thread");
    }
  });

  it("reads a thread through the selected mailbox boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        apiVersion: 1,
        thread,
        messages: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await defaultMailSurfaceClient.readMailboxThread({
      accountId: ACCOUNT_ID,
      mailboxId: "spam",
      threadId: THREAD_ID,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/mailboxes/spam/threads/${THREAD_ID}?accountId=${ACCOUNT_ID}`,
      expect.objectContaining({
        cache: "no-store",
        headers: { "x-brain-mail-thread-state": "5" },
      }),
    );
  });

  it("sends every supported system action as one exact mutation", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(response({ apiVersion: 1, thread }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const mutations = [
      { accountId: ACCOUNT_ID, threadId: THREAD_ID, trash: true },
      { accountId: ACCOUNT_ID, threadId: THREAD_ID, restore: true },
      { accountId: ACCOUNT_ID, threadId: THREAD_ID, spam: true },
      { accountId: ACCOUNT_ID, threadId: THREAD_ID, spam: false },
      { accountId: ACCOUNT_ID, threadId: THREAD_ID, starred: true },
      { accountId: ACCOUNT_ID, threadId: THREAD_ID, starred: false },
    ] as const;

    for (const mutation of mutations) {
      await defaultMailSurfaceClient.updateThread(mutation);
    }

    expect(bodies).toEqual([
      { accountId: ACCOUNT_ID, trash: true },
      { accountId: ACCOUNT_ID, restore: true },
      { accountId: ACCOUNT_ID, spam: true },
      { accountId: ACCOUNT_ID, spam: false },
      { accountId: ACCOUNT_ID, starred: true },
      { accountId: ACCOUNT_ID, starred: false },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(mutations.length);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/threads/${THREAD_ID}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-brain-mail-thread-state": "5",
        }),
      }),
    );
  });

  it("hands back the thread the server answers a mutation with", async () => {
    // The service reads the thread again after it applied the mutation. That
    // copy is the provider's word on what the thread holds now, and a
    // section's Done compares it with what the reader saw at the press.
    const answered = { ...thread, messageCount: 2, lastMessageAt: thread.lastMessageAt + 1 };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(response({ apiVersion: 1, thread: answered })),
        ),
    );

    await expect(
      defaultMailSurfaceClient.updateThread({
        accountId: ACCOUNT_ID,
        threadId: THREAD_ID,
        archive: true,
      }),
    ).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      threadId: THREAD_ID,
      messageCount: 2,
      lastMessageAt: thread.lastMessageAt + 1,
    });
  });

  it("sends a thread mutation with keepalive when the page is unloading", async () => {
    // What a section's Done still owes the provider leaves with the page the
    // way a parked draft delete does: allowed to outlive the tab. An ordinary
    // mutation asks for nothing of the kind.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(response({ apiVersion: 1, thread })));
    vi.stubGlobal("fetch", fetchMock);

    await defaultMailSurfaceClient.updateThread(
      { accountId: ACCOUNT_ID, threadId: THREAD_ID, archive: true },
      undefined,
      { keepalive: true },
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/mail/threads/${THREAD_ID}`,
      expect.objectContaining({ method: "PATCH", keepalive: true }),
    );

    await defaultMailSurfaceClient.updateThread({
      accountId: ACCOUNT_ID,
      threadId: THREAD_ID,
      archive: true,
    });
    expect(fetchMock.mock.calls.at(-1)?.[1]?.keepalive).toBeUndefined();
  });

  it("archives a section's threads in one keepalive POST and reads each answer", async () => {
    const answered = { ...thread, unread: false };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        response({
          apiVersion: 1,
          results: [
            { threadId: THREAD_ID, status: "done", thread: answered, markedRead: true },
            { threadId: "thread_2", status: "stale" },
            { threadId: "thread_3", status: "failed", errorCode: "mail_sync_unavailable" },
            {
              threadId: "thread_4",
              status: "renewed",
              thread: { ...thread, threadId: "thread_4", messageCount: 2 },
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const press = (threadId: string) => ({
      threadId,
      messageCount: 1,
      lastMessageAt: 1,
      unread: true,
    });
    const input = {
      accountId: ACCOUNT_ID,
      threads: [THREAD_ID, "thread_2", "thread_3", "thread_4"].map(press),
      archive: true,
      read: true,
    } as const;

    await expect(
      defaultMailSurfaceClient.archiveThreads(input, undefined, { keepalive: true }),
    ).resolves.toEqual([
      {
        threadId: THREAD_ID,
        status: "done",
        thread: expect.objectContaining({ unread: false }),
        markedRead: true,
      },
      { threadId: "thread_2", status: "stale" },
      { threadId: "thread_3", status: "failed", errorCode: "mail_sync_unavailable" },
      {
        threadId: "thread_4",
        status: "renewed",
        thread: expect.objectContaining({ messageCount: 2 }),
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mail/threads/batch",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        headers: expect.objectContaining({ "x-brain-mail-thread-state": "5" }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(input);

    // The longest batch a Done sends, each id with its press, fits the
    // batch's body bound, and three of them fit the keepalive quota.
    const fifty = {
      accountId: ACCOUNT_ID,
      threads: Array.from({ length: 50 }, (_value, index) => ({
        threadId: `${index}`.padEnd(255, "x"),
        messageCount: 200,
        lastMessageAt: 9_999_999_999_999,
        unread: false,
      })),
      archive: true,
      read: true,
    };
    const fiftyBytes = new TextEncoder().encode(JSON.stringify(fifty)).length;
    expect(fiftyBytes).toBeLessThan(24 * 1024);
    expect(2 * fiftyBytes).toBeLessThan(48 * 1024);

    // An answer for the wrong threads, in another order, or for a thread of
    // another account, is not this batch's answer.
    const otherAccount = `account-a${"2".repeat(32)}`;
    for (const results of [
      [{ threadId: "thread_2", status: "stale" }],
      [
        { threadId: "thread_2", status: "stale" },
        { threadId: THREAD_ID, status: "stale" },
        { threadId: "thread_3", status: "stale" },
        { threadId: "thread_4", status: "stale" },
      ],
      [
        {
          threadId: THREAD_ID,
          status: "done",
          thread: { ...answered, accountId: otherAccount },
          markedRead: true,
        },
        { threadId: "thread_2", status: "stale" },
        { threadId: "thread_3", status: "stale" },
        { threadId: "thread_4", status: "stale" },
      ],
      [
        { threadId: THREAD_ID, status: "stale" },
        { threadId: "thread_2", status: "stale" },
        { threadId: "thread_3", status: "stale" },
        {
          threadId: "thread_4",
          status: "renewed",
          thread: { ...thread, threadId: "thread_4", accountId: otherAccount },
        },
      ],
    ]) {
      fetchMock.mockImplementation(() => Promise.resolve(response({ apiVersion: 1, results })));
      await expect(defaultMailSurfaceClient.archiveThreads(input)).rejects.toThrow(
        "invalid mail thread batch",
      );
    }
  });
});

const DRAFT_ID ="draft-11111111-1111-4111-8111-111111111111";
const MUTATION_ID = "draft-mutation-22222222-2222-4222-8222-222222222222";
const SEND_OPERATION_ID = "send-33333333-3333-4333-8333-333333333333";
const SEND_IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";
const OTHER_ACCOUNT_ID = "account-a11111111111111111111111111111111";
const DRAFT_TS = 1_700_000_000_000;

function draftDto(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 1,
    draftId: DRAFT_ID,
    accountId: ACCOUNT_ID,
    revision: 0,
    state: "editing",
    intent: { kind: "compose" },
    to: "",
    cc: "",
    bcc: "",
    subject: "Hello",
    text: "Draft body",
    attachments: [],
    sendOperationId: null,
    sendErrorCode: null,
    createdAt: DRAFT_TS,
    updatedAt: DRAFT_TS,
    sentAt: null,
    ...overrides,
  };
}

function draftSummary(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 1,
    draftId: DRAFT_ID,
    accountId: ACCOUNT_ID,
    revision: 3,
    state: "editing",
    intent: { kind: "compose" },
    subject: "Hello",
    sendOperationId: null,
    sendErrorCode: null,
    createdAt: DRAFT_TS,
    updatedAt: DRAFT_TS + 5,
    sentAt: null,
    ...overrides,
  };
}

describe("defaultMailSurfaceClient drafts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a draft and returns its editable projection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ apiVersion: 1, created: true, draft: draftDto() }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      draftId: DRAFT_ID,
      accountId: ACCOUNT_ID,
      intent: { kind: "compose" as const },
      to: "",
      cc: "",
      bcc: "",
      subject: "Hello",
      text: "Draft body",
    };

    await expect(defaultMailSurfaceClient.createDraft(input)).resolves.toEqual({
      draftId: DRAFT_ID,
      accountId: ACCOUNT_ID,
      revision: 0,
      state: "editing",
      intent: { kind: "compose" },
      to: "",
      cc: "",
      bcc: "",
      subject: "Hello",
      text: "Draft body",
      updatedAt: DRAFT_TS,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mail/drafts",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify(input),
      }),
    );
  });

  it("keeps a draft creation alive while the page unloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ apiVersion: 1, created: true, draft: draftDto() }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      draftId: DRAFT_ID,
      accountId: ACCOUNT_ID,
      intent: { kind: "compose" as const },
      to: "",
      cc: "",
      bcc: "",
      subject: "Hello",
      text: "Draft body",
    };

    await defaultMailSurfaceClient.createDraft(input, undefined, {
      keepalive: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mail/drafts",
      expect.objectContaining({ keepalive: true }),
    );
  });

  it("lists editable draft summaries for the account", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ apiVersion: 1, drafts: [draftSummary()] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(defaultMailSurfaceClient.listDrafts(ACCOUNT_ID)).resolves.toEqual([
      {
        draftId: DRAFT_ID,
        accountId: ACCOUNT_ID,
        revision: 3,
        state: "editing",
        intent: { kind: "compose" },
        subject: "Hello",
        updatedAt: DRAFT_TS + 5,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/drafts?accountId=${ACCOUNT_ID}`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("reads a single draft and projects its reply intent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(
        draftDto({
          revision: 2,
          to: "a@b.test",
          subject: "Re: Hi",
          intent: { kind: "reply", sourceMessageId: "message-1" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultMailSurfaceClient.getDraft({ accountId: ACCOUNT_ID, draftId: DRAFT_ID }),
    ).resolves.toEqual({
      draftId: DRAFT_ID,
      accountId: ACCOUNT_ID,
      revision: 2,
      state: "editing",
      intent: { kind: "reply", sourceMessageId: "message-1" },
      to: "a@b.test",
      cc: "",
      bcc: "",
      subject: "Re: Hi",
      text: "Draft body",
      updatedAt: DRAFT_TS,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/drafts/${DRAFT_ID}?accountId=${ACCOUNT_ID}`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("patches a draft with a revision-scoped mutation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({ apiVersion: 1, replayed: false, appliedRevision: 3, operationId: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultMailSurfaceClient.patchDraft({
        accountId: ACCOUNT_ID,
        draftId: DRAFT_ID,
        mutationId: MUTATION_ID,
        expectedRevision: 2,
        patch: { subject: "New", text: "Body" },
      }),
    ).resolves.toEqual({ replayed: false, appliedRevision: 3 });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/drafts/${DRAFT_ID}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          kind: "patch",
          accountId: ACCOUNT_ID,
          draftId: DRAFT_ID,
          mutationId: MUTATION_ID,
          expectedRevision: 2,
          patch: { subject: "New", text: "Body" },
        }),
      }),
    );
  });

  it("keeps a final draft patch alive while the page unloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({ apiVersion: 1, replayed: false, appliedRevision: 3, operationId: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await defaultMailSurfaceClient.patchDraft(
      {
        accountId: ACCOUNT_ID,
        draftId: DRAFT_ID,
        mutationId: MUTATION_ID,
        expectedRevision: 2,
        patch: { text: "Final body" },
      },
      undefined,
      { keepalive: true },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/drafts/${DRAFT_ID}`,
      expect.objectContaining({ keepalive: true }),
    );
  });

  it("deletes a draft with a revision-scoped mutation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ apiVersion: 1, deleted: true, replayed: false }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultMailSurfaceClient.deleteDraft({
        accountId: ACCOUNT_ID,
        draftId: DRAFT_ID,
        mutationId: MUTATION_ID,
        expectedRevision: 4,
      }),
    ).resolves.toEqual({ replayed: false });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/drafts/${DRAFT_ID}`,
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          accountId: ACCOUNT_ID,
          draftId: DRAFT_ID,
          mutationId: MUTATION_ID,
          expectedRevision: 4,
        }),
      }),
    );
  });

  it("deletes a draft with keepalive when the page is unloading", async () => {
    // The delete a discard parked behind its Undo goes out at pagehide the
    // way the last autosave does: bounded, and allowed to outlive the tab.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ apiVersion: 1, deleted: true, replayed: false }));
    vi.stubGlobal("fetch", fetchMock);

    await defaultMailSurfaceClient.deleteDraft(
      {
        accountId: ACCOUNT_ID,
        draftId: DRAFT_ID,
        mutationId: MUTATION_ID,
        expectedRevision: 4,
      },
      undefined,
      { keepalive: true },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/drafts/${DRAFT_ID}`,
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    );
  });

  it("sends a draft through the atomic send route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(
        {
          apiVersion: 1,
          replayed: false,
          appliedRevision: 1,
          operationId: SEND_OPERATION_ID,
          created: true,
          status: "queued",
        },
        202,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultMailSurfaceClient.sendDraft({
        accountId: ACCOUNT_ID,
        draftId: DRAFT_ID,
        mutationId: MUTATION_ID,
        expectedRevision: 0,
        sendIdempotencyKey: SEND_IDEMPOTENCY_KEY,
        sendOperationId: SEND_OPERATION_ID,
      }),
    ).resolves.toEqual({
      replayed: false,
      appliedRevision: 1,
      operationId: SEND_OPERATION_ID,
      created: true,
      status: "queued",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/drafts/${DRAFT_ID}/send`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "send",
          accountId: ACCOUNT_ID,
          draftId: DRAFT_ID,
          mutationId: MUTATION_ID,
          expectedRevision: 0,
          sendIdempotencyKey: SEND_IDEMPOTENCY_KEY,
          sendOperationId: SEND_OPERATION_ID,
        }),
      }),
    );
  });

  it("rejects a created draft bound to another account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          { apiVersion: 1, created: true, draft: draftDto({ accountId: OTHER_ACCOUNT_ID }) },
          201,
        ),
      ),
    );
    await expect(
      defaultMailSurfaceClient.createDraft({
        draftId: DRAFT_ID,
        accountId: ACCOUNT_ID,
        intent: { kind: "compose" },
        to: "",
        cc: "",
        bcc: "",
        subject: "",
        text: "",
      }),
    ).rejects.toThrow("invalid mail draft");
  });

  it("rejects a draft response for a different draft id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(draftDto({ draftId: "draft-99999999-9999-4999-8999-999999999999" })),
      ),
    );
    await expect(
      defaultMailSurfaceClient.getDraft({ accountId: ACCOUNT_ID, draftId: DRAFT_ID }),
    ).rejects.toThrow("invalid mail draft");
  });

  it("rejects a draft list that mixes accounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ apiVersion: 1, drafts: [draftSummary({ accountId: OTHER_ACCOUNT_ID })] }),
      ),
    );
    await expect(defaultMailSurfaceClient.listDrafts(ACCOUNT_ID)).rejects.toThrow(
      "invalid mail draft",
    );
  });

  it("rejects a send result with an unknown status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            apiVersion: 1,
            replayed: false,
            appliedRevision: 1,
            operationId: SEND_OPERATION_ID,
            created: true,
            status: "exploded",
          },
          202,
        ),
      ),
    );
    await expect(
      defaultMailSurfaceClient.sendDraft({
        accountId: ACCOUNT_ID,
        draftId: DRAFT_ID,
        mutationId: MUTATION_ID,
        expectedRevision: 0,
        sendIdempotencyKey: SEND_IDEMPOTENCY_KEY,
        sendOperationId: SEND_OPERATION_ID,
      }),
    ).rejects.toThrow("invalid mail draft");
  });

  it("reads a send operation to its current status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        apiVersion: 1,
        operationId: SEND_OPERATION_ID,
        accountId: ACCOUNT_ID,
        status: "failed",
        threadId: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultMailSurfaceClient.getSendOperation(SEND_OPERATION_ID),
    ).resolves.toEqual({
      apiVersion: 1,
      operationId: SEND_OPERATION_ID,
      accountId: ACCOUNT_ID,
      status: "failed",
      threadId: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/send/${SEND_OPERATION_ID}`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("rejects a send operation answering for a different operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          apiVersion: 1,
          operationId: "send-99999999-9999-4999-8999-999999999999",
          status: "sent",
        }),
      ),
    );

    await expect(
      defaultMailSurfaceClient.getSendOperation(SEND_OPERATION_ID),
    ).rejects.toThrow("invalid mail send operation");
  });

  /** The account on the answer is what the Sent mark is written against, so
   *  the browser reads it under the same rule as every other account id it
   *  accepts rather than trusting whatever shape arrives. */
  it.each([
    ["an account id that is not one", "account-not-a-real-id"],
    ["an account id of the wrong type", 7],
    ["no account id at all", undefined],
  ])("rejects a send operation carrying %s", async (_name, accountId) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          apiVersion: 1,
          operationId: SEND_OPERATION_ID,
          ...(accountId === undefined ? {} : { accountId }),
          status: "sent",
          threadId: null,
        }),
      ),
    );

    await expect(
      defaultMailSurfaceClient.getSendOperation(SEND_OPERATION_ID),
    ).rejects.toThrow("invalid mail send operation");
  });

  it("rejects a send operation with an unknown status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ apiVersion: 1, operationId: SEND_OPERATION_ID, status: "lost" }),
      ),
    );

    await expect(
      defaultMailSurfaceClient.getSendOperation(SEND_OPERATION_ID),
    ).rejects.toThrow("invalid mail send operation");
  });

  it("refuses to request an unsafe send operation id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultMailSurfaceClient.getSendOperation("send/../secrets"),
    ).rejects.toThrow("invalid mail send operation request");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("defaultMailSurfaceClient error typing", () => {
  it("preserves the status and code of a rejected draft send", async () => {
    // The draft and send routes answer with apiVersion 1.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response(
            { apiVersion: 1, error: { code: "mail_draft_request_invalid" } },
            400,
          ),
        ),
    );

    const failure = await defaultMailSurfaceClient
      .sendDraft({
        accountId: ACCOUNT_ID,
        draftId: DRAFT_ID,
        mutationId: MUTATION_ID,
        expectedRevision: 0,
        sendIdempotencyKey: SEND_IDEMPOTENCY_KEY,
        sendOperationId: SEND_OPERATION_ID,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MailApiError);
    expect((failure as MailApiError).status).toBe(400);
    expect((failure as MailApiError).code).toBe("mail_draft_request_invalid");
  });

  it.each([
    [409, "mail_draft_revision_conflict", 1],
    [409, "mail_draft_idempotency_conflict", 1],
    [429, "mail_send_rate_limited", 1],
    // Account routes answer with apiVersion 2. The version must not gate the
    // code, or every draft error would decode as null.
    [409, "mail_draft_quota_exceeded", 2],
  ] as const)(
    "keeps status %i and code %s from an apiVersion %i envelope",
    async (status, code, apiVersion) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(response({ apiVersion, error: { code } }, status)),
      );

      const failure = await defaultMailSurfaceClient
        .listDrafts(ACCOUNT_ID)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MailApiError);
      expect((failure as MailApiError).status).toBe(status);
      expect((failure as MailApiError).code).toBe(code);
    },
  );

  it("keeps the status when a gateway answers with a non-JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(textResponse("<html>502 Bad Gateway</html>", 502)),
    );

    const failure = await defaultMailSurfaceClient
      .listDrafts(ACCOUNT_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MailApiError);
    expect((failure as MailApiError).status).toBe(502);
    expect((failure as MailApiError).code).toBeNull();
  });

  it("ignores an error code that is not a plain service code", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ apiVersion: 1, error: { code: "<script>alert(1)</script>" } }, 400),
        ),
    );

    const failure = await defaultMailSurfaceClient
      .listDrafts(ACCOUNT_ID)
      .catch((error: unknown) => error);

    expect((failure as MailApiError).code).toBeNull();
  });
});

describe("draft state predicates", () => {
  const summary = (state: MailDraftState): MailDraftSummary => ({
    draftId: DRAFT_ID,
    accountId: ACCOUNT_ID,
    revision: 3,
    state,
    intent: { kind: "compose" },
    subject: "Hello",
    updatedAt: DRAFT_TS,
  });

  it.each([
    ["editing", true, true, true],
    ["failed", true, true, true],
    ["submitting", true, false, false],
    ["delivery_unknown", true, false, false],
    ["sent", false, false, false],
  ] as const)(
    "%s is listed=%s resumable=%s deletable=%s",
    (state, listed, resumable, deletable) => {
      expect(isListedDraft(summary(state))).toBe(listed);
      expect(isResumableDraft(summary(state))).toBe(resumable);
      expect(isDeletableDraft(summary(state))).toBe(deletable);
    },
  );
});

describe("defaultMailSurfaceClient account capabilities", () => {
  const imapEndpoint = {
    hostname: "imap.custom.test",
    port: 993,
    tls: "implicit",
    username: "person@custom.test",
  } as const;
  const smtpEndpoint = {
    hostname: "smtp.custom.test",
    port: 465,
    tls: "implicit",
    username: "person@custom.test",
  } as const;
  const receiveOnlyCapabilities = {
    mailboxes: ["inbox"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: false,
    send: false,
    reply: false,
  } as const;
  const sendCapableCapabilities = {
    ...receiveOnlyCapabilities,
    compose: true,
    send: true,
    reply: true,
  } as const;

  function imapAccount(patch: Record<string, unknown> = {}): unknown {
    return {
      accountId: ACCOUNT_ID,
      emailAddress: "person@custom.test",
      displayName: "Custom domain",
      status: "connected",
      connectedAt: DRAFT_TS,
      createdAt: DRAFT_TS,
      updatedAt: DRAFT_TS,
      providerKind: "imap",
      imap: imapEndpoint,
      capabilities: receiveOnlyCapabilities,
      ...patch,
    };
  }

  function stubAccounts(account: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(response({ apiVersion: 3, accounts: [account] })),
    );
  }

  it("keeps a custom-domain IMAP account that carries an SMTP transport", async () => {
    stubAccounts(
      imapAccount({ smtp: smtpEndpoint, capabilities: sendCapableCapabilities }),
    );

    const accounts = await defaultMailSurfaceClient.loadAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      providerKind: "imap",
      smtp: smtpEndpoint,
      capabilities: { compose: true, send: true, reply: true },
    });
  });

  it("keeps a receive-only IMAP account without a send capability", async () => {
    stubAccounts(imapAccount());

    const accounts = await defaultMailSurfaceClient.loadAccounts();

    expect(accounts[0]).toMatchObject({
      providerKind: "imap",
      capabilities: { compose: false, send: false, reply: false },
    });
    expect(accounts[0]).not.toHaveProperty("smtp");
  });

  it("trusts the service when SMTP is provisioned but submission is not ready", async () => {
    stubAccounts(imapAccount({ smtp: smtpEndpoint }));

    const accounts = await defaultMailSurfaceClient.loadAccounts();

    expect(accounts[0]).toMatchObject({
      smtp: smtpEndpoint,
      capabilities: { compose: false, send: false, reply: false },
    });
  });

  it("refuses a send capability no SMTP transport backs", async () => {
    stubAccounts(imapAccount({ capabilities: sendCapableCapabilities }));

    await expect(defaultMailSurfaceClient.loadAccounts()).rejects.toThrow(
      "invalid mail account capabilities",
    );
  });

  it("folds thread actions away when the service withholds them", async () => {
    stubAccounts(
      imapAccount({
        capabilities: { ...receiveOnlyCapabilities, threadMutations: false },
      }),
    );

    const accounts = await defaultMailSurfaceClient.loadAccounts();

    expect(accounts[0]).toMatchObject({
      capabilities: { threadMutations: false },
    });
  });

  it("refuses a Gmail-only capability on a custom-domain account", async () => {
    stubAccounts(
      imapAccount({
        smtp: smtpEndpoint,
        capabilities: {
          ...sendCapableCapabilities,
          mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
        },
      }),
    );

    await expect(defaultMailSurfaceClient.loadAccounts()).rejects.toThrow(
      "invalid mail account capabilities",
    );
  });

  // The capability set is derived from the presence of an SMTP block, so a
  // malformed one must never survive as a send-capable account.
  it.each([
    ["an out-of-range port", { ...smtpEndpoint, port: 0 }],
    ["a missing endpoint", null],
    ["an unknown transport field", { ...smtpEndpoint, password: "secret" }],
  ])("refuses an SMTP transport with %s", async (_label, smtp) => {
    stubAccounts(imapAccount({ smtp, capabilities: sendCapableCapabilities }));

    await expect(defaultMailSurfaceClient.loadAccounts()).rejects.toThrow(
      "invalid mail account",
    );
  });

  /** The browser cannot import the service module that owns the cap, so the
   *  mirror below is what the wire check reads. It has to be the same number. */
  it("mirrors the account cap the mail service enforces", () => {
    expect(MAX_MAIL_ACCOUNTS).toBe(MAIL_RESOURCE_LIMITS.maxAccounts);
  });

  function accountList(count: number): unknown {
    return {
      apiVersion: 3,
      accounts: Array.from({ length: count }, (_, index) =>
        imapAccount({
          accountId: `account-a${String(index + 1).repeat(32)}`,
          emailAddress: `person-${index + 1}@custom.test`,
        }),
      ),
    };
  }

  it("reads a full account list and refuses one past the cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(accountList(MAX_MAIL_ACCOUNTS))),
    );
    await expect(defaultMailSurfaceClient.loadAccounts()).resolves.toHaveLength(
      MAX_MAIL_ACCOUNTS,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(accountList(MAX_MAIL_ACCOUNTS + 1))),
    );
    await expect(defaultMailSurfaceClient.loadAccounts()).rejects.toThrow(
      "invalid mail accounts",
    );
  });
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

/** A gateway or proxy failure whose body is not JSON at all. */
function textResponse(body: string, status: number): Response {
  return {
    ok: false,
    status,
    json: async (): Promise<unknown> => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
    text: async () => body,
  } as Response;
}

describe("defaultMailSurfaceClient mutation deadline", () => {
  /** A PATCH the server never answers: the promise settles only on abort. */
  function hangingFetch() {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const signal = init.signal!;
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, signals };
  }

  it.each([
    [
      "decision",
      () =>
        defaultMailSurfaceClient.decideSender({
          address: "lena@example.test",
          scope: "address",
          decision: "block",
        }),
    ],
    [
      "Undo",
      () =>
        defaultMailSurfaceClient.undoSenderDecision({
          decisionId: `decision-a${"0".repeat(30)}ab`,
        }),
    ],
  ])("gives up on a sender %s nobody answers, and says it was the clock", async (_, call) => {
    vi.useFakeTimers();
    try {
      hangingFetch();
      const outcome = call().then(
        () => "resolved",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(MAIL_MUTATION_TIMEOUT_MS - 1);
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(isMailMutationTimeout(await outcome)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a thread mutation nobody answers, and says it was the clock", async () => {
    vi.useFakeTimers();
    try {
      hangingFetch();
      const pending = defaultMailSurfaceClient.updateThread({
        accountId: ACCOUNT_ID,
        threadId: THREAD_ID,
        archive: true,
      });
      const outcome = pending.then(
        () => "resolved",
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(MAIL_MUTATION_TIMEOUT_MS - 1);
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const error = await outcome;
      expect(isMailMutationTimeout(error)).toBe(true);
      expect(isMailMutationTimeout(new Error("other"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still lets the caller abort first, with the caller's reason", async () => {
    vi.useFakeTimers();
    try {
      const { signals } = hangingFetch();
      const controller = new AbortController();
      const outcome = defaultMailSurfaceClient
        .updateThread(
          { accountId: ACCOUNT_ID, threadId: THREAD_ID, read: true },
          controller.signal,
        )
        .then(
          () => "resolved",
          (error: unknown) => error,
        );
      const reason = new DOMException("view changed", "AbortError");
      controller.abort(reason);
      expect(await outcome).toBe(reason);
      expect(isMailMutationTimeout(reason)).toBe(false);
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a mutation that lands in time without touching the clock", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(response({ apiVersion: 1, thread })),
      );
      await expect(
        defaultMailSurfaceClient.updateThread({
          accountId: ACCOUNT_ID,
          threadId: THREAD_ID,
          archive: false,
        }),
      ).resolves.toMatchObject({ threadId: THREAD_ID });
      // No timer is left armed behind a request that already answered.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** The pending-open request: a thread named from outside Mail, left here for
 *  the surface to find. The surface's own half is in `mail-surface.test.tsx`. */
describe("a thread asked for from outside Mail", () => {
  afterEach(() => {
    clearOpenThreadRequest();
  });

  it("holds the pair and tells whoever is listening", () => {
    const heard = vi.fn();
    const stop = subscribeOpenThread(heard);
    requestOpenThread(ACCOUNT_ID, THREAD_ID);
    // A caller that names no mailbox is the centre, whose letters are new
    // mail: Inbox.
    expect(pendingOpenThread()).toEqual({
      accountId: ACCOUNT_ID,
      threadId: THREAD_ID,
      mailboxId: "inbox",
    });
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    requestOpenThread(ACCOUNT_ID, "thread-2");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("carries the mailbox the letter was found in", () => {
    requestOpenThread(ACCOUNT_ID, THREAD_ID, "all");
    expect(pendingOpenThread()).toEqual({
      accountId: ACCOUNT_ID,
      threadId: THREAD_ID,
      mailboxId: "all",
    });
    requestOpenThread(ACCOUNT_ID, THREAD_ID, "archive" as MailSystemMailbox);
    // A mailbox no route knows is a request nothing could answer: the one
    // before it stays.
    expect(pendingOpenThread()?.mailboxId).toBe("all");
  });

  it("keeps the last request, because a second press is a change of mind", () => {
    requestOpenThread(ACCOUNT_ID, THREAD_ID);
    requestOpenThread(ACCOUNT_ID, "thread-2");
    expect(pendingOpenThread()?.threadId).toBe("thread-2");
  });

  it("drops an id no mail route could serve", () => {
    requestOpenThread("account one", THREAD_ID);
    expect(pendingOpenThread()).toBeNull();
    requestOpenThread(ACCOUNT_ID, "thread one");
    expect(pendingOpenThread()).toBeNull();
  });

  it("goes quiet once it has been answered", () => {
    const heard = vi.fn();
    const stop = subscribeOpenThread(heard);
    requestOpenThread(ACCOUNT_ID, THREAD_ID);
    clearOpenThreadRequest();
    expect(pendingOpenThread()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    // Clearing what is already clear says nothing, so a surface that answers
    // twice does not publish twice.
    clearOpenThreadRequest();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("defaultMailSurfaceClient new senders", () => {
  const DECISION_ID = `decision-a${"0".repeat(30)}ab`;
  const state = {
    apiVersion: 1,
    enabled: true,
    enabledAt: 1_700_000_000_000,
    backfillComplete: true,
    domainScopeRefused: ["mail.example", "person.example"],
  };

  it("reads the screen's state and switches it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(state))
      .mockResolvedValueOnce(response({ ...state, enabled: false, enabledAt: null, backfillComplete: false }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(defaultMailSurfaceClient.getSenderScreenState()).resolves.toEqual(state);
    await expect(
      defaultMailSurfaceClient.setSenderScreenEnabled(false),
    ).resolves.toMatchObject({ enabled: false, enabledAt: null });

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/mail/senders/state");
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/mail/senders/state");
    expect(init).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
  });

  it("refuses a state that contradicts itself", async () => {
    for (const invalid of [
      { ...state, enabled: true, enabledAt: null },
      { ...state, domainScopeRefused: [7] },
      { ...state, extra: true },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(invalid)));
      await expect(defaultMailSurfaceClient.getSenderScreenState()).rejects.toThrow(
        "invalid mail sender state",
      );
    }
  });

  it("posts one decision and reads what a block archived", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        apiVersion: 1,
        decisionId: DECISION_ID,
        archived: [{ accountId: ACCOUNT_ID, threadId: THREAD_ID }],
        pending: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultMailSurfaceClient.decideSender({
        address: "lena@okafor.example",
        scope: "domain",
        decision: "block",
      }),
    ).resolves.toEqual({
      apiVersion: 1,
      decisionId: DECISION_ID,
      archived: [{ accountId: ACCOUNT_ID, threadId: THREAD_ID }],
      pending: false,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/mail/senders/decisions");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(init.body as string)).toEqual({
      address: "lena@okafor.example",
      scope: "domain",
      decision: "block",
    });
  });

  it("undoes a decision, and unblocks without moving old mail when told", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ apiVersion: 1, restored: [], pending: false }));
    vi.stubGlobal("fetch", fetchMock);

    await defaultMailSurfaceClient.undoSenderDecision({ decisionId: DECISION_ID });
    await defaultMailSurfaceClient.undoSenderDecision({
      decisionId: DECISION_ID,
      restore: false,
    });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [`/api/mail/senders/decisions/${DECISION_ID}`, "DELETE"],
      [`/api/mail/senders/decisions/${DECISION_ID}?restore=false`, "DELETE"],
    ]);
  });

  it("refuses to name a decision no route could serve", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      defaultMailSurfaceClient.undoSenderDecision({ decisionId: "../state" }),
    ).rejects.toThrow("invalid mail sender decision");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the code of a refused undo so the toast can tell the cases apart", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ apiVersion: 1, error: { code: "mail_sender_decision_changed" } }, 409),
        ),
    );
    const failure = await defaultMailSurfaceClient
      .undoSenderDecision({ decisionId: DECISION_ID })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MailApiError);
    expect((failure as MailApiError).code).toBe("mail_sender_decision_changed");
  });

  it("lists who is blocked", async () => {
    const blocked = {
      apiVersion: 1,
      blocked: [
        {
          decisionId: DECISION_ID,
          key: "growthly.example",
          scope: "domain",
          decidedAt: 1_700_000_000_000,
          archivedCount: 3,
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(response(blocked));
    vi.stubGlobal("fetch", fetchMock);

    await expect(defaultMailSurfaceClient.listBlockedSenders()).resolves.toEqual(blocked);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/mail/senders/blocked");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ ...blocked, blocked: [{ ...blocked.blocked[0], scope: "everyone" }] }),
      ),
    );
    await expect(defaultMailSurfaceClient.listBlockedSenders()).rejects.toThrow(
      "invalid blocked senders",
    );
  });
});
