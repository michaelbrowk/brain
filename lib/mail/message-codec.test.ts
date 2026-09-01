import { describe, expect, it } from "vitest";

import {
  normalizeMailSearchQuery,
  validateMailMailboxThreadPage,
  validateMailSearchInput,
  validateMailSearchThreadPage,
  validateMailSendInput,
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
