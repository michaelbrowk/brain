import { describe, expect, it } from "vitest";

import {
  normalizeMailSearchQuery,
  validateMailBlockedSenders,
  validateMailMailboxThreadPage,
  validateMailSearchAllInput,
  validateMailSearchInput,
  validateMailSearchThreadPage,
  validateMailSendInput,
  validateMailSenderDecisionInput,
  validateMailSenderDecisionResult,
  validateMailSenderScreenState,
  validateMailSenderUndoResult,
  validateMailThreadDetail,
  validateMailThreadListFilter,
  validateMailThreadMutationInput,
  validateMailThreadPage,
} from "./message-codec";

const accountId = "account-a0123456789abcdef0123456789abcdef";

describe("Mail message boundary codec", () => {
  it("accepts an exact provider-neutral thread page", () => {
    const page = validateMailThreadPage({
      apiVersion: 1,
      items: [threadFixture()],
      nextCursor: "cursor_2",
      sync: { status: "idle", lastSuccessfulAt: 123 },
    });

    expect(page.items[0]).toMatchObject({
      accountId,
      threadId: "thread_1",
      unread: true,
    });
    expect(Object.isFrozen(page.items)).toBe(true);
  });

  it("keeps old apiVersion 1 thread payloads readable with a safe star default", () => {
    const legacyThread = Object.fromEntries(
      Object.entries(threadFixture()).filter(([key]) => key !== "starred"),
    );

    expect(
      validateMailThreadPage({
        apiVersion: 1,
        items: [legacyThread],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 123 },
      }).items[0],
    ).toMatchObject({ threadId: "thread_1", starred: false });
  });

  it("keeps the pre-Reply-To message shape readable during a staged rollout", () => {
    const legacyMessage = Object.fromEntries(
      Object.entries(messageFixture()).filter(([key]) => key !== "replyTo"),
    );
    expect(
      validateMailThreadDetail({
        apiVersion: 1,
        thread: threadFixture(),
        messages: [legacyMessage],
      }).messages[0]?.replyTo,
    ).toEqual([]);
  });

  it("accepts exact mailbox pages without exposing internal sync cursors", () => {
    expect(
      validateMailMailboxThreadPage({
        apiVersion: 1,
        mailboxId: "sent",
        items: [threadFixture()],
        nextCursor: null,
        availability: {
          status: "available",
          lastSuccessfulAt: 123,
          windowTruncated: true,
        },
      }),
    ).toMatchObject({
      mailboxId: "sent",
      availability: { status: "available", windowTruncated: true },
    });
    expect(
      validateMailMailboxThreadPage({
        apiVersion: 1,
        mailboxId: "trash",
        items: [],
        nextCursor: null,
        availability: {
          status: "unavailable",
          reason: "mailbox_syncing",
          lastSuccessfulAt: null,
          windowTruncated: null,
        },
      }),
    ).toMatchObject({ availability: { reason: "mailbox_syncing" } });

    for (const invalid of [
      {
        apiVersion: 1,
        mailboxId: "drafts",
        items: [],
        nextCursor: null,
        availability: {
          status: "unavailable",
          reason: "mailbox_syncing",
          lastSuccessfulAt: null,
          windowTruncated: null,
        },
      },
      {
        apiVersion: 1,
        mailboxId: "spam",
        items: [threadFixture()],
        nextCursor: null,
        availability: {
          status: "unavailable",
          reason: "history_mismatch",
          lastSuccessfulAt: 123,
          windowTruncated: null,
        },
      },
      {
        apiVersion: 1,
        mailboxId: "sent",
        items: [],
        nextCursor: null,
        availability: {
          status: "available",
          lastSuccessfulAt: 123,
          windowTruncated: false,
          observedHistoryId: "SECRET",
        },
      },
    ]) {
      expect(() => validateMailMailboxThreadPage(invalid)).toThrow(
        "mail_response_invalid",
      );
    }
  });

  it("rejects provider fields and cross-thread messages", () => {
    expect(() =>
      validateMailThreadPage({
        apiVersion: 1,
        items: [{ ...threadFixture(), gmailHistoryId: "SECRET" }],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: null },
      }),
    ).toThrow("mail_response_invalid");

    expect(() =>
      validateMailThreadDetail({
        apiVersion: 1,
        thread: threadFixture(),
        messages: [{ ...messageFixture(), threadId: "another_thread" }],
      }),
    ).toThrow("mail_response_invalid");
  });

  it("bounds compose and reply while keeping threading headers server-owned", () => {
    const compose = validateMailSendInput({
      accountId,
      idempotencyKey: "12345678-1234-4123-8123-123456789abc",
      mode: "compose",
      to: ["PERSON@example.test"],
      cc: [],
      bcc: [],
      subject: "Hello",
      text: "Body",
      replyToMessageId: null,
      attachments: [],
      origin: "app",
      agentLine: false,
    });
    expect(compose.to).toEqual(["person@example.test"]);

    for (const invalid of [
      { ...compose, mode: "reply", replyToMessageId: null },
      { ...compose, mode: "compose", replyToMessageId: "message_1" },
      { ...compose, references: ["provider-owned"] },
      { ...compose, to: [], text: "x".repeat(1024 * 1024 + 1) },
    ]) {
      expect(() => validateMailSendInput(invalid)).toThrow("mail_request_invalid");
    }
  });

  it("requires exactly one thread mutation", () => {
    for (const mutation of [
      { accountId, read: false },
      { accountId, archive: true },
      // Archive is the one removal with an inverse — Undo of a bulk Done
      // needs it, so `archive: false` is a mutation, not a malformed one.
      { accountId, archive: false },
      { accountId, trash: true },
      { accountId, restore: true },
      { accountId, spam: true },
      { accountId, spam: false },
      { accountId, starred: true },
      { accountId, starred: false },
    ] as const) {
      expect(validateMailThreadMutationInput(mutation)).toEqual(mutation);
    }

    for (const invalid of [
      { accountId },
      { accountId, trash: false },
      { accountId, restore: false },
      { accountId, spam: "true" },
      { accountId, starred: 1 },
      { accountId, read: true, archive: true },
      { accountId, trash: true, restore: true },
      { accountId, trash: true, providerLabel: "TRASH" },
    ]) {
      expect(() => validateMailThreadMutationInput(invalid)).toThrow(
        "mail_request_invalid",
      );
    }
  });

  it("normalizes bounded Unicode search terms without accepting FTS syntax", () => {
    expect(normalizeMailSearchQuery("  Café ПРИВЕТ launch* OR ")).toBe(
      "café привет launch or",
    );
    expect(
      validateMailSearchInput({
        accountId,
        mailboxId: "inbox",
        query: "Quarterly quarterly LAUNCH",
      }),
    ).toEqual({
      accountId,
      mailboxId: "inbox",
      query: "quarterly launch",
      cursor: null,
      limit: 50,
    });
    for (const invalid of [
      "***",
      "x".repeat(257),
      Array.from({ length: 13 }, (_, index) => `term${index}`).join(" "),
      `${"é".repeat(65)}`,
    ]) {
      expect(() => normalizeMailSearchQuery(invalid)).toThrow(
        "mail_request_invalid",
      );
    }
  });

  it("accepts an every-account search of a query and a bounded limit", () => {
    expect(validateMailSearchAllInput({ query: "Quarterly launch" })).toEqual({
      query: "Quarterly launch",
      limit: 20,
    });
    expect(validateMailSearchAllInput({ query: "***", limit: 1 })).toEqual({
      query: "***",
      limit: 1,
    });
    expect(Object.isFrozen(validateMailSearchAllInput({ query: "x" }))).toBe(
      true,
    );
    for (const invalid of [
      null,
      [],
      {},
      { query: 5 },
      { query: "x", limit: 0 },
      { query: "x", limit: 21 },
      { query: "x", limit: 2.5 },
      { query: "x", limit: "5" },
      { query: "x", accountId },
      { query: "x", mailboxId: "inbox" },
      { query: "x", cursor: "cursor_1" },
    ]) {
      expect(() => validateMailSearchAllInput(invalid), JSON.stringify(invalid)).toThrow(
        "mail_request_invalid",
      );
    }
  });

  it("accepts only exact view and sort enum values with safe defaults", () => {
    expect(validateMailThreadListFilter({})).toEqual({
      view: null,
      sort: "date",
    });
    expect(validateMailThreadListFilter({ view: null, sort: null })).toEqual({
      view: null,
      sort: "date",
    });
    for (const view of ["unread", "attachments", "lists", "people"] as const) {
      expect(validateMailThreadListFilter({ view })).toEqual({
        view,
        sort: "date",
      });
    }
    for (const sort of ["date", "unread", "sender", "size"] as const) {
      expect(validateMailThreadListFilter({ sort })).toEqual({
        view: null,
        sort,
      });
    }

    for (const invalid of [
      { view: "" },
      { sort: "" },
      { view: "starred" },
      { view: "UNREAD" },
      { view: "unread " },
      { sort: "sender ASC" },
      { sort: "newest" },
      { view: 1 },
      { sort: ["size"] },
    ]) {
      expect(() => validateMailThreadListFilter(invalid)).toThrow(
        "mail_request_invalid",
      );
    }
  });

  it("requires listMessage and sizeBytes to ship together", () => {
    const withViewFields = {
      ...threadFixture(),
      listMessage: true,
      sizeBytes: 4_096,
    };
    expect(
      validateMailThreadPage({
        apiVersion: 1,
        items: [withViewFields],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 123 },
      }).items[0],
    ).toMatchObject({ listMessage: true, sizeBytes: 4_096 });

    // A tier-2 projection omits both fields; the defaults stay safe.
    expect(
      validateMailThreadPage({
        apiVersion: 1,
        items: [threadFixture()],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 123 },
      }).items[0],
    ).toMatchObject({ listMessage: false, sizeBytes: 0 });

    for (const invalid of [
      { ...threadFixture(), listMessage: true },
      { ...threadFixture(), sizeBytes: 4_096 },
      { ...withViewFields, listMessage: 1 },
      { ...withViewFields, sizeBytes: -1 },
      { ...withViewFields, sizeBytes: 1.5 },
    ]) {
      expect(() =>
        validateMailThreadPage({
          apiVersion: 1,
          items: [invalid],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 123 },
        }),
      ).toThrow("mail_response_invalid");
    }
  });

  it("reads the tier-4 category and defaults it to people when absent", () => {
    for (const category of ["people", "notification", "newsletter"] as const) {
      expect(
        validateMailThreadPage({
          apiVersion: 1,
          items: [{ ...threadFixture(), category }],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 123 },
        }).items[0],
      ).toMatchObject({ category });
    }

    // A tier-3 projection omits category; the default stays safe.
    expect(
      validateMailThreadPage({
        apiVersion: 1,
        items: [threadFixture()],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 123 },
      }).items[0],
    ).toMatchObject({ category: "people" });

    for (const invalid of [
      { ...threadFixture(), category: "spam" },
      { ...threadFixture(), category: "People" },
      { ...threadFixture(), category: true },
      { ...threadFixture(), category: null },
      { ...threadFixture(), category: "people", categories: "people" },
    ]) {
      expect(() =>
        validateMailThreadPage({
          apiVersion: 1,
          items: [invalid],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 123 },
        }),
      ).toThrow("mail_response_invalid");
    }
  });

  it("reads the tier-5 newSender and reads an older service's thread as not waiting", () => {
    for (const newSender of [true, false]) {
      expect(
        validateMailThreadPage({
          apiVersion: 1,
          items: [{ ...threadFixture(), category: "people", newSender }],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 123 },
        }).items[0],
      ).toMatchObject({ newSender });
    }
    // A service from before the screen, or a tier-4 projection, never says.
    expect(
      validateMailThreadDetail({
        apiVersion: 1,
        thread: { ...threadFixture(), category: "people" },
        messages: [messageFixture()],
      }).thread.newSender,
    ).toBe(false);

    for (const invalid of [
      { ...threadFixture(), newSender: "true" },
      { ...threadFixture(), newSender: null },
      { ...threadFixture(), newSender: true, newSenders: true },
    ]) {
      expect(() =>
        validateMailThreadPage({
          apiVersion: 1,
          items: [invalid],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 123 },
        }),
      ).toThrow("mail_response_invalid");
    }
  });

  it("reads a blocked sender's mark, and only as a mark", () => {
    const page = (item: Record<string, unknown>) =>
      validateMailThreadPage({
        apiVersion: 1,
        items: [item],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 123 },
      });
    expect(
      page({ ...threadFixture(), newSender: false, senderBlocked: true }).items[0],
    ).toMatchObject({ senderBlocked: true });
    expect(page({ ...threadFixture(), newSender: false }).items[0]!.senderBlocked).toBeUndefined();
    for (const invalid of [
      { ...threadFixture(), newSender: false, senderBlocked: false },
      { ...threadFixture(), newSender: false, senderBlocked: "yes" },
      // A letter cannot wait on a sender already blocked.
      {
        ...threadFixture(),
        newSender: true,
        newSenderFrom: { name: null, address: "x@example.test" },
        senderBlocked: true,
      },
    ]) {
      expect(() => page(invalid)).toThrow("mail_response_invalid");
    }
  });

  it("reads the sender a waiting thread names, and only on a waiting thread", () => {
    const from = { name: "Lena Okafor", address: "lena@okafor.example" };
    const page = (item: Record<string, unknown>) =>
      validateMailThreadPage({
        apiVersion: 1,
        items: [item],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 123 },
      });

    expect(
      page({ ...threadFixture(), newSender: true, newSenderFrom: from }).items[0],
    ).toMatchObject({ newSender: true, newSenderFrom: from });
    expect(
      page({ ...threadFixture(), newSender: true }).items[0]!.newSenderFrom,
    ).toBeUndefined();

    for (const invalid of [
      // A sender named on a thread nobody is waiting on is a contradiction.
      { ...threadFixture(), newSender: false, newSenderFrom: from },
      { ...threadFixture(), newSenderFrom: from },
      { ...threadFixture(), newSender: true, newSenderFrom: null },
      { ...threadFixture(), newSender: true, newSenderFrom: "lena@okafor.example" },
      {
        ...threadFixture(),
        newSender: true,
        newSenderFrom: { name: null, address: "not an address" },
      },
    ]) {
      expect(() => page(invalid)).toThrow("mail_response_invalid");
    }
  });

  it("holds the new-senders requests and answers to their exact shapes", () => {
    expect(
      validateMailSenderDecisionInput({
        address: "Lena <lena@example.test>",
        scope: "domain",
        decision: "block",
      }),
    ).toEqual({ address: "Lena <lena@example.test>", scope: "domain", decision: "block" });
    for (const invalid of [
      { address: "", scope: "address", decision: "accept" },
      { address: "lena@example.test", scope: "everyone", decision: "accept" },
      { address: "lena@example.test", scope: "address", decision: "ignore" },
      { address: "lena@example.test", scope: "address", decision: "accept", extra: 1 },
      { address: 7, scope: "address", decision: "accept" },
    ]) {
      expect(() => validateMailSenderDecisionInput(invalid)).toThrow("mail_request_invalid");
    }

    const state = {
      apiVersion: 1,
      enabled: true,
      enabledAt: 5,
      backfillComplete: false,
      domainScopeRefused: ["gmail.com", "example.test"],
    };
    expect(validateMailSenderScreenState(state)).toEqual(state);
    for (const invalid of [
      { ...state, enabledAt: null },
      { ...state, enabled: false },
      { ...state, enabled: false, enabledAt: null, backfillComplete: true },
      { ...state, domainScopeRefused: "gmail.com" },
      { ...state, domainScopeRefused: [7] },
      { apiVersion: 1, enabled: true, enabledAt: 5, backfillComplete: false },
    ]) {
      expect(() => validateMailSenderScreenState(invalid)).toThrow("mail_response_invalid");
    }

    const decisionId = "decision-a0123456789abcdef0123456789abcdef";
    const ref = { accountId, threadId: "thread_1" };
    expect(
      validateMailSenderDecisionResult({
        apiVersion: 1,
        decisionId,
        archived: [ref],
        pending: true,
      }),
    ).toEqual({ apiVersion: 1, decisionId, archived: [ref], pending: true });
    for (const decisionId of [
      "decision-1",
      `decision-a${"z".repeat(32)}`,
      "decision-a0123",
      `decision-a${"0".repeat(33)}`,
    ]) {
      expect(() =>
        validateMailSenderDecisionResult({
          apiVersion: 1,
          decisionId,
          archived: [],
          pending: false,
        }),
      ).toThrow("mail_response_invalid");
    }
    expect(
      validateMailSenderUndoResult({ apiVersion: 1, restored: [ref], pending: false }),
    ).toEqual({ apiVersion: 1, restored: [ref], pending: false });
    expect(() =>
      validateMailSenderUndoResult({
        apiVersion: 1,
        restored: [{ ...ref, subject: "x" }],
        pending: false,
      }),
    ).toThrow("mail_response_invalid");
    expect(
      validateMailBlockedSenders({
        apiVersion: 1,
        blocked: [
          {
            decisionId,
            key: "growth.test",
            scope: "domain",
            decidedAt: 9,
            archivedCount: 3,
          },
        ],
      }).blocked[0],
    ).toEqual({
      decisionId,
      key: "growth.test",
      scope: "domain",
      decidedAt: 9,
      archivedCount: 3,
    });
  });

  it("requires search responses to disclose building and truncated windows", () => {
    const available = {
      status: "available",
      lastSuccessfulAt: 123,
      windowTruncated: false,
    } as const;
    expect(
      validateMailSearchThreadPage({
        apiVersion: 1,
        mailboxId: "inbox",
        scope: "headers_and_previews",
        items: [threadFixture()],
        nextCursor: null,
        availability: available,
        indexStatus: "ready",
        resultsTruncated: false,
      }),
    ).toMatchObject({ indexStatus: "ready", resultsTruncated: false });

    for (const invalid of [
      {
        apiVersion: 1,
        mailboxId: "inbox",
        scope: "headers_and_previews",
        items: [],
        nextCursor: "cursor_1",
        availability: available,
        indexStatus: "building",
        resultsTruncated: true,
      },
      {
        apiVersion: 1,
        mailboxId: "inbox",
        scope: "headers_and_previews",
        items: [],
        nextCursor: null,
        availability: { ...available, windowTruncated: true },
        indexStatus: "ready",
        resultsTruncated: false,
      },
    ]) {
      expect(() => validateMailSearchThreadPage(invalid)).toThrow(
        "mail_response_invalid",
      );
    }
  });
});

function threadFixture() {
  return {
    accountId,
    threadId: "thread_1",
    subject: "Hello",
    participants: [{ name: "Person", address: "person@example.test" }],
    snippet: "Preview",
    lastMessageAt: 123,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
  };
}

function messageFixture() {
  return {
    accountId,
    messageId: "message_1",
    threadId: "thread_1",
    from: { name: "Person", address: "person@example.test" },
    replyTo: [],
    to: [{ name: null, address: "me@example.test" }],
    cc: [],
    subject: "Hello",
    sentAt: 123,
    unread: true,
    inInbox: true,
    snippet: "Preview",
    textBody: "Body",
    htmlBody: null,
    hasAttachments: false,
  };
}
