import { describe, expect, it } from "vitest";

import {
  FAKE_ACCOUNT_ID,
  FAKE_ACCOUNT_ID_TWO,
  createMailClientFake,
  fakeAccountV2,
  fakeThread,
} from "@/app/api/mcp/mail-client-fake";
import { BrainMailClientError } from "./brain-mail-client";
import type { MailSearchThreadPage, MailThreadListItem } from "./message-types";
import {
  byNewest,
  decodeSearchCursor,
  encodeSearchCursor,
  searchAllAccounts,
} from "./search-all";

const ACCOUNTS = [fakeAccountV2(FAKE_ACCOUNT_ID), fakeAccountV2(FAKE_ACCOUNT_ID_TWO)];

function page(
  items: readonly MailThreadListItem[],
  overrides: Partial<MailSearchThreadPage> = {},
): MailSearchThreadPage {
  return {
    apiVersion: 1,
    mailboxId: "inbox",
    scope: "headers_and_previews",
    items,
    nextCursor: null,
    availability: {
      status: "available",
      lastSuccessfulAt: 1,
      windowTruncated: false,
    },
    indexStatus: "ready",
    resultsTruncated: false,
    ...overrides,
  };
}

describe("one search across every account", () => {
  it("merges every account's rows newest first behind per-account cursors", async () => {
    const older = fakeThread({
      accountId: FAKE_ACCOUNT_ID,
      threadId: "thread-older",
      lastMessageAt: 1_000,
    });
    const newer = fakeThread({
      accountId: FAKE_ACCOUNT_ID_TWO,
      threadId: "thread-newer",
      lastMessageAt: 2_000,
    });
    const fake = createMailClientFake({
      searchThreads: async (input) =>
        input.accountId === FAKE_ACCOUNT_ID
          ? page([older], { nextCursor: "cursor-one" })
          : page([newer]),
    });

    const result = await searchAllAccounts(fake.client, {
      query: "invoice",
      limit: 25,
      accounts: ACCOUNTS,
      mailboxFor: () => "inbox",
    });

    expect(result.threads.map((thread) => thread.threadId)).toEqual([
      "thread-newer",
      "thread-older",
    ]);
    expect(result.next).toEqual({
      [FAKE_ACCOUNT_ID]: "cursor-one",
      [FAKE_ACCOUNT_ID_TWO]: null,
    });
    expect(result.accounts).toEqual([
      {
        accountId: FAKE_ACCOUNT_ID,
        availability: {
          status: "available",
          lastSuccessfulAt: 1,
          windowTruncated: false,
        },
        indexStatus: "ready",
        resultsTruncated: false,
      },
      {
        accountId: FAKE_ACCOUNT_ID_TWO,
        availability: {
          status: "available",
          lastSuccessfulAt: 1,
          windowTruncated: false,
        },
        indexStatus: "ready",
        resultsTruncated: false,
      },
    ]);
    expect(fake.calls.map((call) => call.args[0])).toEqual([
      {
        accountId: FAKE_ACCOUNT_ID,
        mailboxId: "inbox",
        query: "invoice",
        cursor: null,
        limit: 25,
      },
      {
        accountId: FAKE_ACCOUNT_ID_TWO,
        mailboxId: "inbox",
        query: "invoice",
        cursor: null,
        limit: 25,
      },
    ]);
  });

  it("asks each account in the mailbox the caller chose for it", async () => {
    const fake = createMailClientFake();

    await searchAllAccounts(fake.client, {
      query: "invoice",
      limit: 20,
      accounts: ACCOUNTS,
      mailboxFor: (account) =>
        account.accountId === FAKE_ACCOUNT_ID ? "all" : "inbox",
    });

    expect(
      fake.calls.map((call) => {
        const input = call.args[0] as { accountId: string; mailboxId: string };
        return [input.accountId, input.mailboxId];
      }),
    ).toEqual([
      [FAKE_ACCOUNT_ID, "all"],
      [FAKE_ACCOUNT_ID_TWO, "inbox"],
    ]);
  });

  it("keeps the other accounts' rows when one account fails", async () => {
    const alive = fakeThread({
      accountId: FAKE_ACCOUNT_ID_TWO,
      threadId: "thread-alive",
      lastMessageAt: 2_000,
    });
    const fake = createMailClientFake({
      searchThreads: async (input) => {
        if (input.accountId === FAKE_ACCOUNT_ID) {
          throw new BrainMailClientError(409, "mail_account_reauth_required");
        }
        return page([alive]);
      },
    });

    const result = await searchAllAccounts(fake.client, {
      query: "invoice",
      limit: 25,
      accounts: ACCOUNTS,
      mailboxFor: () => "inbox",
    });

    expect(result.threads.map((thread) => thread.threadId)).toEqual([
      "thread-alive",
    ]);
    expect(result.accounts).toEqual([
      {
        accountId: FAKE_ACCOUNT_ID,
        error: "this account needs to be reconnected",
        reason: "mail_account_reauth_required",
      },
      {
        accountId: FAKE_ACCOUNT_ID_TWO,
        availability: {
          status: "available",
          lastSuccessfulAt: 1,
          windowTruncated: false,
        },
        indexStatus: "ready",
        resultsTruncated: false,
      },
    ]);
    // No entry for the account that failed: a cursor built from this answer
    // asks it again from the start rather than marking it exhausted.
    expect(result.next).toEqual({ [FAKE_ACCOUNT_ID_TWO]: null });
  });

  it("reads an error that is not the client's own as an outage", async () => {
    const fake = createMailClientFake({
      searchThreads: async () => {
        throw new TypeError("socket path is not a string");
      },
    });

    const result = await searchAllAccounts(fake.client, {
      query: "invoice",
      limit: 25,
      accounts: [ACCOUNTS[0]],
      mailboxFor: () => "inbox",
    });

    expect(result.threads).toEqual([]);
    expect(result.accounts).toEqual([
      {
        accountId: FAKE_ACCOUNT_ID,
        error: "the mail service is unavailable",
        reason: "mail_service_unavailable",
      },
    ]);
  });

  it("resumes each account from its own cursor and leaves an exhausted one alone", async () => {
    const fake = createMailClientFake();

    const result = await searchAllAccounts(fake.client, {
      query: "invoice",
      limit: 25,
      accounts: ACCOUNTS,
      mailboxFor: () => "inbox",
      cursor: { [FAKE_ACCOUNT_ID]: "cursor-one", [FAKE_ACCOUNT_ID_TWO]: null },
    });

    expect(fake.calls.map((call) => call.args[0])).toEqual([
      {
        accountId: FAKE_ACCOUNT_ID,
        mailboxId: "inbox",
        query: "invoice",
        cursor: "cursor-one",
        limit: 25,
      },
    ]);
    expect(result.next).toEqual({
      [FAKE_ACCOUNT_ID]: null,
      [FAKE_ACCOUNT_ID_TWO]: null,
    });
    expect(result.accounts.map((status) => status.accountId)).toEqual([
      FAKE_ACCOUNT_ID,
    ]);
  });

  it("starts an account the cursor never named from the beginning", async () => {
    const fake = createMailClientFake();

    await searchAllAccounts(fake.client, {
      query: "invoice",
      limit: 25,
      accounts: ACCOUNTS,
      mailboxFor: () => "inbox",
      cursor: { [FAKE_ACCOUNT_ID]: "cursor-one" },
    });

    expect(
      fake.calls.map((call) => (call.args[0] as { cursor: unknown }).cursor),
    ).toEqual(["cursor-one", null]);
  });

  it("passes the caller's signal to every account's request", async () => {
    const fake = createMailClientFake();
    const controller = new AbortController();

    await searchAllAccounts(fake.client, {
      query: "invoice",
      limit: 25,
      accounts: ACCOUNTS,
      mailboxFor: () => "inbox",
      signal: controller.signal,
    });

    expect(fake.calls.map((call) => call.args[1])).toEqual([
      controller.signal,
      controller.signal,
    ]);
  });
});

describe("the merge order", () => {
  it("puts the newest first and breaks a tie on the thread id", () => {
    const rows = [
      fakeThread({ threadId: "b", lastMessageAt: 5 }),
      fakeThread({ threadId: "c", lastMessageAt: null }),
      fakeThread({ threadId: "a", lastMessageAt: 5 }),
      fakeThread({ threadId: "d", lastMessageAt: 9 }),
    ];

    expect([...rows].sort(byNewest).map((row) => row.threadId)).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });
});

describe("the merged cursor", () => {
  it("round-trips the per-account cursors it was built from", () => {
    const per = { [FAKE_ACCOUNT_ID]: "cursor-one", [FAKE_ACCOUNT_ID_TWO]: null };
    const encoded = encodeSearchCursor(per);

    expect(encoded).not.toContain("cursor-one");
    expect(decodeSearchCursor(encoded)).toEqual(per);
  });

  it("refuses anything that is not a version-1 cursor of strings or nulls", () => {
    for (const bad of [
      "not-base64url-json",
      Buffer.from("[]").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 2, per: {} })).toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1 })).toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, per: { a: 1 } })).toString("base64url"),
    ]) {
      expect(decodeSearchCursor(bad), bad).toBeNull();
    }
  });
});
