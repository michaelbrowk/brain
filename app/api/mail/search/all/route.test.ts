import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createBrainMailClient: vi.fn() }));

// Only the factory is replaced. `BrainMailClientError` stays the real class,
// because the route branches on `instanceof` and a stand-in would make every
// service refusal read as an outage.
vi.mock("@/lib/mail/brain-mail-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/brain-mail-client")>()),
  createBrainMailClient: mocks.createBrainMailClient,
}));

import {
  FAKE_ACCOUNT_ID,
  FAKE_ACCOUNT_ID_TWO,
  createMailClientFake,
  fakeAccountV3,
  fakeThread,
} from "@/app/api/mcp/mail-client-fake";
import { BrainMailClientError } from "@/lib/mail/brain-mail-client";
import type {
  MailSearchAllResponse,
  MailSearchThreadPage,
  MailThreadListItem,
} from "@/lib/mail/message-types";
import { POST } from "./route";

const URL = "https://brain.test/api/mail/search/all";

/** One Gmail account with every mailbox and one IMAP account with only the
 *  Inbox, which is the pair that shows the mailbox chosen per account. */
const ACCOUNTS = [
  fakeAccountV3(FAKE_ACCOUNT_ID, { emailAddress: "me@gmail.test" }),
  fakeAccountV3(FAKE_ACCOUNT_ID_TWO, {
    providerKind: "imap",
    emailAddress: "me@imap.test",
  }),
];

const AVAILABLE = {
  status: "available",
  lastSuccessfulAt: 1,
  windowTruncated: false,
} as const;

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
    availability: AVAILABLE,
    indexStatus: "ready",
    resultsTruncated: false,
    ...overrides,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: "POST",
    headers: {
      Origin: "https://brain.test",
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function install(
  overrides: Parameters<typeof createMailClientFake>[0] = {},
) {
  const fake = createMailClientFake({
    listAccountCapabilities: async () => ({ apiVersion: 3, accounts: ACCOUNTS }),
    ...overrides,
  });
  mocks.createBrainMailClient.mockReturnValue(fake.client);
  return fake;
}

function searchCalls(fake: ReturnType<typeof install>) {
  return fake.calls
    .filter((call) => call.method === "searchThreads")
    .map((call) => call.args[0]);
}

beforeEach(() => {
  process.env.BRAIN_PUBLIC_ORIGIN = "https://brain.test";
  mocks.createBrainMailClient.mockReset();
});

afterEach(() => {
  delete process.env.BRAIN_PUBLIC_ORIGIN;
});

describe("POST /api/mail/search/all", () => {
  it("searches every account in its widest mailbox and merges newest first", async () => {
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
    const fake = install({
      searchThreads: async (input) =>
        input.accountId === FAKE_ACCOUNT_ID
          ? page([older], { mailboxId: "all" })
          : page([newer]),
    });

    const response = await POST(request({ query: "invoice", limit: 5 }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      apiVersion: 1,
      threads: [newer, older],
      accounts: [
        {
          accountId: FAKE_ACCOUNT_ID,
          emailAddress: "me@gmail.test",
          mailboxId: "all",
          availability: AVAILABLE,
          indexStatus: "ready",
          resultsTruncated: false,
        },
        {
          accountId: FAKE_ACCOUNT_ID_TWO,
          emailAddress: "me@imap.test",
          mailboxId: "inbox",
          availability: AVAILABLE,
          indexStatus: "ready",
          resultsTruncated: false,
        },
      ],
      indexBuilding: false,
      truncated: false,
    } satisfies MailSearchAllResponse);
    expect(searchCalls(fake)).toEqual([
      {
        accountId: FAKE_ACCOUNT_ID,
        mailboxId: "all",
        query: "invoice",
        cursor: null,
        limit: 5,
      },
      {
        accountId: FAKE_ACCOUNT_ID_TWO,
        mailboxId: "inbox",
        query: "invoice",
        cursor: null,
        limit: 5,
      },
    ]);
  });

  it("asks each account for twenty rows when the body names no limit", async () => {
    const fake = install();

    const response = await POST(request({ query: "invoice" }));

    expect(response.status).toBe(200);
    expect(
      searchCalls(fake).map((input) => (input as { limit: number }).limit),
    ).toEqual([20, 20]);
  });

  it("says the index is still building when any account says so", async () => {
    install({
      searchThreads: async (input) =>
        page([], {
          indexStatus: input.accountId === FAKE_ACCOUNT_ID ? "building" : "ready",
        }),
    });

    const body = (await (
      await POST(request({ query: "invoice" }))
    ).json()) as MailSearchAllResponse;

    expect(body.indexBuilding).toBe(true);
    expect(body.threads).toEqual([]);
  });

  it("cuts the merge to the limit and says so", async () => {
    const rows = [
      fakeThread({ threadId: "thread-1", lastMessageAt: 1 }),
      fakeThread({ threadId: "thread-3", lastMessageAt: 3 }),
    ];
    install({
      searchThreads: async (input) =>
        input.accountId === FAKE_ACCOUNT_ID
          ? page(rows)
          : page([
              fakeThread({
                accountId: FAKE_ACCOUNT_ID_TWO,
                threadId: "thread-2",
                lastMessageAt: 2,
              }),
            ]),
    });

    const body = (await (
      await POST(request({ query: "invoice", limit: 2 }))
    ).json()) as MailSearchAllResponse;

    expect(body.threads.map((thread) => thread.threadId)).toEqual([
      "thread-3",
      "thread-2",
    ]);
    expect(body.truncated).toBe(true);
  });

  it("says truncated when an account cut its own page short", async () => {
    install({
      searchThreads: async (input) =>
        page([], {
          resultsTruncated: input.accountId === FAKE_ACCOUNT_ID_TWO,
        }),
    });

    const body = (await (
      await POST(request({ query: "invoice" }))
    ).json()) as MailSearchAllResponse;

    expect(body.threads).toEqual([]);
    expect(body.truncated).toBe(true);
  });

  it("keeps the other account's rows when one account is down", async () => {
    const alive = fakeThread({
      accountId: FAKE_ACCOUNT_ID_TWO,
      threadId: "thread-alive",
    });
    install({
      searchThreads: async (input) => {
        if (input.accountId === FAKE_ACCOUNT_ID) {
          throw new BrainMailClientError(409, "mail_account_reauth_required");
        }
        return page([alive]);
      },
    });

    const response = await POST(request({ query: "invoice" }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as MailSearchAllResponse;
    expect(body.threads).toEqual([alive]);
    expect(body.accounts[0]).toEqual({
      accountId: FAKE_ACCOUNT_ID,
      emailAddress: "me@gmail.test",
      error: "this account needs to be reconnected",
      reason: "mail_account_reauth_required",
    });
    expect(body.accounts[1]).toMatchObject({
      accountId: FAKE_ACCOUNT_ID_TWO,
      mailboxId: "inbox",
    });
  });

  it("answers the service's own refusal when no account can be listed", async () => {
    const fake = install({
      listAccountCapabilities: async () => {
        throw new BrainMailClientError(503, "mail_service_unavailable");
      },
    });

    const response = await POST(request({ query: "invoice" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "mail_service_unavailable" },
    });
    expect(searchCalls(fake)).toEqual([]);
  });

  it("refuses a query with nothing to search for under its own code", async () => {
    const fake = install();

    for (const query of ["", "   ", "***", "x".repeat(300)]) {
      const response = await POST(request({ query }));
      expect(response.status, JSON.stringify(query)).toBe(400);
      expect(await response.json()).toEqual({
        apiVersion: 1,
        error: { code: "invalid_query" },
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it("refuses a body of the wrong shape before the client is touched", async () => {
    const fake = install();

    for (const body of [
      { query: "invoice", limit: 0 },
      { query: "invoice", limit: 21 },
      { query: "invoice", limit: 2.5 },
      { query: "invoice", accountId: FAKE_ACCOUNT_ID },
      { query: 5 },
      {},
      [],
      "not json at all",
    ]) {
      const response = await POST(request(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({
        apiVersion: 1,
        error: { code: "mail_request_invalid" },
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it("refuses a request from another origin or without JSON before the client is touched", async () => {
    const fake = install();

    const crossOrigin = await POST(
      new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "invoice" }),
      }),
    );
    const nonJson = await POST(
      new Request(URL, {
        method: "POST",
        headers: { Origin: "https://brain.test", "Content-Type": "text/plain" },
        body: JSON.stringify({ query: "invoice" }),
      }),
    );

    expect(crossOrigin.status).toBe(403);
    expect(nonJson.status).toBe(415);
    expect(await crossOrigin.json()).toEqual({
      apiVersion: 1,
      error: { code: "mail_request_invalid" },
    });
    expect(await nonJson.json()).toEqual({
      apiVersion: 1,
      error: { code: "mail_request_invalid" },
    });
    expect(fake.calls).toEqual([]);
  });
});
