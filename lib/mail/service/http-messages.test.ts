import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailSendService } from "./outbound";
import {
  createBrainMailClient,
  SAFE_SERVICE_ERROR_CODES,
} from "../brain-mail-client";
import type { MailThreadListItem } from "../message-types";
import { MailAccountError } from "./account-types";
import type { MailAccountServiceV2 } from "./accounts";
import {
  AccountMailMessageService,
  type MailMessageService,
  type MailProviderSyncPort,
  MailProviderSyncError,
} from "./message-service";
import {
  type CachedProviderMessage,
  type CachedProviderThread,
  MailCacheError,
  SqliteMailMessageCache,
} from "./message-cache";
import { createMailServiceHttpServer, MAIL_SERVICE_ERROR_CODES } from "./http";
import { MAIL_SERVICE_HTTP_LIMITS } from "./limits";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const THREAD_ID = "thread_1";
const OPERATION_ID = "send-11111111-1111-4111-8111-111111111111";
const running: Array<{ server: Server; root: string }> = [];

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(async ({ server, root }) => {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("brain-mail message HTTP surface", () => {
  it("dispatches exact list, detail, sync, mutation, send, and status contracts", async () => {
    const messages = messageServiceFixture();
    const send = sendServiceFixture();
    const socketPath = await startServer(messages, send);

    const list = await requestJson(
      socketPath,
      "GET",
      `/v1/threads?accountId=${ACCOUNT_ID}&limit=20`,
    );
    const mailboxList = await requestJson(
      socketPath,
      "GET",
      `/v1/mailboxes/sent/threads?accountId=${ACCOUNT_ID}&limit=20`,
    );
    const search = await requestJson(
      socketPath,
      "POST",
      "/v1/search",
      JSON.stringify({
        accountId: ACCOUNT_ID,
        mailboxId: "inbox",
        query: "Quarterly launch",
        limit: 20,
      }),
    );
    const detail = await requestJson(
      socketPath,
      "GET",
      `/v1/threads/${THREAD_ID}?accountId=${ACCOUNT_ID}`,
    );
    const mailboxDetail = await requestJson(
      socketPath,
      "GET",
      `/v1/mailboxes/sent/threads/${THREAD_ID}?accountId=${ACCOUNT_ID}`,
    );
    const sync = await requestJson(
      socketPath,
      "POST",
      "/v1/sync",
      JSON.stringify({ accountId: ACCOUNT_ID, maxItems: 20 }),
    );
    const mutation = await requestJson(
      socketPath,
      "PATCH",
      `/v1/threads/${THREAD_ID}`,
      JSON.stringify({ accountId: ACCOUNT_ID, read: true }),
    );
    const sent = await requestJson(
      socketPath,
      "POST",
      "/v1/send",
      JSON.stringify(sendInput()),
    );
    const status = await requestJson(
      socketPath,
      "GET",
      `/v1/send/${OPERATION_ID}`,
    );

    expect([
      list.status,
      mailboxList.status,
      search.status,
      detail.status,
      mailboxDetail.status,
      sync.status,
      mutation.status,
    ]).toEqual([
      200, 200, 200, 200, 200, 200, 200,
    ]);
    expect(sent.status).toBe(202);
    expect(status.status).toBe(200);
    expect(messages.listThreads).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      limit: 20,
      view: null,
      sort: "date",
    });
    expect(messages.listMailboxThreads).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      mailboxId: "sent",
      limit: 20,
      view: null,
      sort: "date",
    });
    expect(messages.searchThreads).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      mailboxId: "inbox",
      query: "quarterly launch",
      cursor: null,
      limit: 20,
    });
    expect(messages.getThread).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      threadId: THREAD_ID,
    });
    expect(messages.getMailboxThread).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      mailboxId: "sent",
      threadId: THREAD_ID,
    });
    expect(messages.sync).toHaveBeenCalledWith(
      { accountId: ACCOUNT_ID, maxItems: 20 },
      expect.any(AbortSignal),
    );
    expect(messages.updateThread).toHaveBeenCalledWith(
      { accountId: ACCOUNT_ID, threadId: THREAD_ID, read: true },
      expect.any(AbortSignal),
    );
    expect(send.send).toHaveBeenCalledWith(
      sendInput(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const sendContext = (send.send as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      deadlineAt: number;
    };
    expect(sendContext.deadlineAt - Date.now()).toBeGreaterThan(
      MAIL_SERVICE_HTTP_LIMITS.requestDeadlineMs,
    );
    expect(sendContext.deadlineAt - Date.now()).toBeLessThanOrEqual(
      MAIL_SERVICE_HTTP_LIMITS.providerOperationDeadlineMs,
    );
    expect(send.status).toHaveBeenCalledWith(OPERATION_ID);
  });

  it("keeps search POST-only and rejects malformed or ambiguous bodies before the service", async () => {
    const messages = messageServiceFixture();
    const socketPath = await startServer(messages, sendServiceFixture());

    await expect(
      requestJson(
        socketPath,
        "GET",
        `/v1/search?accountId=${ACCOUNT_ID}&mailboxId=inbox&query=secret`,
      ),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      requestJson(
        socketPath,
        "POST",
        "/v1/search",
        JSON.stringify({
          accountId: ACCOUNT_ID,
          mailboxId: "inbox",
          query: "valid",
          unexpected: true,
        }),
      ),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "mail_request_invalid" } },
    });
    await expect(
      requestJson(
        socketPath,
        "POST",
        "/v1/search",
        JSON.stringify({
          accountId: ACCOUNT_ID,
          mailboxId: "inbox",
          query: "***",
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
    expect(messages.searchThreads).not.toHaveBeenCalled();
  });

  it("projects thread-state fields by contract tier on both list routes", async () => {
    const socketPath = await startServer(
      messageServiceFixture(),
      sendServiceFixture(),
    );
    const itemFor = async (
      routePath: string,
      header: Record<string, string>,
    ) => {
      const response = await requestJson(
        socketPath,
        "GET",
        routePath,
        undefined,
        header,
      );
      expect(response.status).toBe(200);
      return (response.body as { items: Record<string, unknown>[] }).items[0]!;
    };

    for (const routePath of [
      `/v1/threads?accountId=${ACCOUNT_ID}&limit=20`,
      `/v1/mailboxes/sent/threads?accountId=${ACCOUNT_ID}&limit=20`,
    ]) {
      const legacy = await itemFor(routePath, {});
      expect(legacy).not.toHaveProperty("starred");
      expect(legacy).not.toHaveProperty("listMessage");
      expect(legacy).not.toHaveProperty("sizeBytes");
      expect(legacy).not.toHaveProperty("category");

      const starOnly = await itemFor(routePath, {
        "x-brain-mail-thread-state": "2",
      });
      expect(starOnly).toHaveProperty("starred", false);
      expect(starOnly).not.toHaveProperty("listMessage");
      expect(starOnly).not.toHaveProperty("sizeBytes");
      expect(starOnly).not.toHaveProperty("category");

      const viewFields = await itemFor(routePath, {
        "x-brain-mail-thread-state": "3",
      });
      expect(viewFields).toMatchObject({
        starred: false,
        listMessage: false,
        sizeBytes: 0,
      });
      expect(viewFields).not.toHaveProperty("category");

      const current = await itemFor(routePath, {
        "x-brain-mail-thread-state": "4",
      });
      expect(current).toMatchObject({
        starred: false,
        listMessage: false,
        sizeBytes: 0,
        category: "people",
      });

      const garbage = await itemFor(routePath, {
        "x-brain-mail-thread-state": "999",
      });
      expect(garbage).not.toHaveProperty("starred");
      expect(garbage).not.toHaveProperty("listMessage");
      expect(garbage).not.toHaveProperty("sizeBytes");
      expect(garbage).not.toHaveProperty("category");
    }
  });

  it("forwards view and sort to the service and rejects bad values first", async () => {
    const messages = messageServiceFixture();
    const socketPath = await startServer(messages, sendServiceFixture());

    const list = await requestJson(
      socketPath,
      "GET",
      `/v1/threads?accountId=${ACCOUNT_ID}&limit=20&view=lists&sort=size`,
    );
    const mailboxList = await requestJson(
      socketPath,
      "GET",
      `/v1/mailboxes/sent/threads?accountId=${ACCOUNT_ID}&limit=20&view=unread&sort=sender`,
    );
    expect([list.status, mailboxList.status]).toEqual([200, 200]);
    expect(messages.listThreads).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      limit: 20,
      view: "lists",
      sort: "size",
    });
    expect(messages.listMailboxThreads).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      mailboxId: "sent",
      limit: 20,
      view: "unread",
      sort: "sender",
    });

    vi.mocked(messages.listThreads).mockClear();
    vi.mocked(messages.listMailboxThreads).mockClear();
    for (const badQuery of [
      `view=starred`,
      `sort=newest`,
      `view=`,
      `sort=`,
      `view=lists&view=lists`,
      `sort=size&sort=size`,
    ]) {
      const rejected = await requestJson(
        socketPath,
        "GET",
        `/v1/threads?accountId=${ACCOUNT_ID}&limit=20&${badQuery}`,
      );
      const mailboxRejected = await requestJson(
        socketPath,
        "GET",
        `/v1/mailboxes/sent/threads?accountId=${ACCOUNT_ID}&limit=20&${badQuery}`,
      );
      expect([rejected.status, mailboxRejected.status]).toEqual([400, 400]);
    }
    expect(messages.listThreads).not.toHaveBeenCalled();
    expect(messages.listMailboxThreads).not.toHaveBeenCalled();

    // Search deliberately keeps rejecting view and sort; the surface fails
    // closed instead of silently ignoring an unsupported filter.
    const searchRejected = await requestJson(
      socketPath,
      "POST",
      "/v1/search",
      JSON.stringify({
        accountId: ACCOUNT_ID,
        mailboxId: "inbox",
        query: "quarterly",
        view: "lists",
      }),
    );
    expect(searchRejected.status).toBe(400);
    expect(messages.searchThreads).not.toHaveBeenCalled();
  });

  it("reports both paths degraded while any account holds a sync error", async () => {
    const messages = messageServiceFixture();
    const lastSuccessfulAt = Date.now() - 60_000;
    const readBackgroundSyncHealth =
      messages.readBackgroundSyncHealth as ReturnType<typeof vi.fn>;
    readBackgroundSyncHealth.mockResolvedValue({
      lastSuccessfulAt,
      lastErrorCode: "mail_provider_rate_limited",
    });
    const send = sendServiceFixture();
    const accounts = {
      localSchemaVersion: 2,
      accountCount: vi.fn(async () => 1),
      status: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as Parameters<typeof createMailServiceHttpServer>[0]["accounts"];
    const socketPath = await startServer(messages, send, accounts);

    const response = await requestJson(socketPath, "GET", "/v1/health");
    expect(response).toMatchObject({
      status: 200,
      body: {
        status: "degraded",
        localSchemaVersion: 2,
        cacheSchemaVersion: 1,
        receiveReadiness: "degraded",
        sendReadiness: "degraded",
        activeAccounts: 1,
        lastErrorCode: "mail_provider_rate_limited",
      },
    });
    const age = (response.body as { lastSuccessfulSyncAgeMs: number })
      .lastSuccessfulSyncAgeMs;
    expect(age).toBeGreaterThanOrEqual(60_000);
    expect(age).toBeLessThan(65_000);
    expect(readBackgroundSyncHealth).toHaveBeenCalledTimes(1);
  });

  /*
    Readiness used to be the string "degraded" written down, with no branch that
    could ever produce "ready". An account syncing cleanly every few seconds
    reported degraded on both paths with a null error code, which is a sentence
    with no information in it — during a real incident the health endpoint said
    exactly what it says on a healthy morning.
  */
  it("reports ready once every account has synced without recording an error", async () => {
    const messages = messageServiceFixture();
    (messages.readBackgroundSyncHealth as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        lastSuccessfulAt: Date.now() - 19_000,
        lastErrorCode: null,
      });
    const accounts = {
      localSchemaVersion: 2,
      accountCount: vi.fn(async () => 2),
      status: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as Parameters<typeof createMailServiceHttpServer>[0]["accounts"];
    const socketPath = await startServer(
      messages,
      sendServiceFixture(),
      accounts,
    );

    await expect(
      requestJson(socketPath, "GET", "/v1/health"),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        status: "ok",
        receiveReadiness: "ready",
        sendReadiness: "ready",
        activeAccounts: 2,
        lastErrorCode: null,
      },
    });
  });

  it("holds receive back until a first sync has actually completed", async () => {
    const messages = messageServiceFixture();
    (messages.readBackgroundSyncHealth as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ lastSuccessfulAt: null, lastErrorCode: null });
    const accounts = {
      localSchemaVersion: 2,
      accountCount: vi.fn(async () => 1),
      status: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as Parameters<typeof createMailServiceHttpServer>[0]["accounts"];
    const socketPath = await startServer(
      messages,
      sendServiceFixture(),
      accounts,
    );

    // Send does not wait on a sync — a queue can take a letter on an account
    // whose first refresh is still running.
    await expect(
      requestJson(socketPath, "GET", "/v1/health"),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        status: "degraded",
        receiveReadiness: "degraded",
        sendReadiness: "ready",
        lastSuccessfulSyncAgeMs: null,
      },
    });
  });

  it("dispatches every exact system action and rejects ambiguous mutations", async () => {
    const messages = messageServiceFixture();
    const socketPath = await startServer(messages, sendServiceFixture());
    const mutations = [
      { accountId: ACCOUNT_ID, trash: true },
      { accountId: ACCOUNT_ID, restore: true },
      { accountId: ACCOUNT_ID, spam: true },
      { accountId: ACCOUNT_ID, spam: false },
      { accountId: ACCOUNT_ID, starred: true },
      { accountId: ACCOUNT_ID, starred: false },
    ] as const;

    for (const mutation of mutations) {
      await expect(
        requestJson(
          socketPath,
          "PATCH",
          `/v1/threads/${THREAD_ID}`,
          JSON.stringify(mutation),
        ),
      ).resolves.toMatchObject({ status: 200 });
    }
    await expect(
      requestJson(
        socketPath,
        "PATCH",
        `/v1/threads/${THREAD_ID}`,
        JSON.stringify({
          accountId: ACCOUNT_ID,
          trash: true,
          restore: true,
        }),
      ),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "mail_request_invalid" } },
    });

    expect(messages.updateThread).toHaveBeenCalledTimes(mutations.length);
    mutations.forEach((mutation, index) => {
      expect(messages.updateThread).toHaveBeenNthCalledWith(
        index + 1,
        { ...mutation, threadId: THREAD_ID },
        expect.any(AbortSignal),
      );
    });
  });

  it.each([
    ["mail_provider_reauth_required", 409, "mail_account_reauth_required"],
    ["mail_provider_rate_limited", 429, "mail_sync_rate_limited"],
    ["mail_provider_unavailable", 503, "mail_sync_unavailable"],
    // A server with no mailbox for the action is a refusal, not an outage, so
    // it must not arrive as a retryable 503.
    [
      "mail_provider_mutation_unsupported",
      409,
      "mail_thread_mutation_unsupported",
    ],
    // The thread is not where the account last saw it: another client moved
    // it, or Brain moved it and lost the handle in a restart. No retry brings
    // the handle back, and the next sync rebuilds the list without it.
    ["mail_provider_thread_stale", 409, "mail_thread_stale"],
  ] as const)("maps %s system-action failures to a stable HTTP error", async (
    providerCode,
    status,
    publicCode,
  ) => {
    const messages = messageServiceFixture();
    vi.mocked(messages.updateThread).mockRejectedValueOnce(
      new MailProviderSyncError(providerCode),
    );
    const socketPath = await startServer(messages, sendServiceFixture());

    await expect(
      requestJson(
        socketPath,
        "PATCH",
        `/v1/threads/${THREAD_ID}`,
        JSON.stringify({ accountId: ACCOUNT_ID, trash: true }),
      ),
    ).resolves.toMatchObject({
      status,
      body: { error: { code: publicCode } },
    });
  });

  /*
    The refusal has to survive the trip through Brain, not merely leave the
    service intact. `mail_thread_mutation_unsupported` shipped with the IMAP
    mutations and was never added to the proxy's forwarding set, so Brain
    turned its own 409 into a 502 `mail_service_invalid_response` on the way to
    the browser. The status and the meaning both went: the surface stopped
    recognising the refusal, so it kept spending a login per thread on an
    answer that could not change and reported "stayed put" with no reason
    attached. Asserting through the real client is what makes that visible —
    the service's own test above passed the whole time.
  */
  it("carries a mutation refusal through the proxy with its status and code", async () => {
    const messages = messageServiceFixture();
    vi.mocked(messages.updateThread).mockRejectedValue(
      new MailProviderSyncError("mail_provider_mutation_unsupported"),
    );
    const socketPath = await startServer(messages, sendServiceFixture());

    await expect(
      createBrainMailClient({ socketPath }).updateThread(THREAD_ID, {
        accountId: ACCOUNT_ID,
        archive: true,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "mail_thread_mutation_unsupported",
    });
  });

  /*
    Same class as the 409 above, one route over. The SMTP half of an account's
    settings answers with its own codes — `smtp_authentication_failed` is a
    wrong outgoing password, `smtp_connection_timeout` a host that never picked
    up — and none of the five was in the forwarding set. Brain turned each into
    a 502 `mail_service_invalid_response`, so a wrong password read as an
    outage of the setup surface, with "Try again" under it.
  */
  it.each([
    ["smtp_dns_failed", 422],
    ["smtp_tls_failed", 422],
    ["smtp_connection_failed", 422],
    ["smtp_authentication_failed", 422],
    ["smtp_connection_timeout", 408],
  ] as const)(
    "carries %s through the proxy with its status and code",
    async (code, status) => {
      const socketPath = await startServer(
        messageServiceFixture(),
        sendServiceFixture(),
        accountServiceRefusing(new MailAccountError(code)),
      );

      await expect(
        createBrainMailClient({ socketPath }).createAccount(
          createAccountInput(),
        ),
      ).rejects.toMatchObject({ status, code });
    },
  );

  /*
    The set in the client is a hand-kept copy of the service's vocabulary, and
    for a while the only thing binding the two was a grep of `http.ts` for
    `new MailHttpError(NNN, "code")` literals. Twenty-one sites relay
    `error.code` from a typed error class instead, and the grep could not see
    one of them — which is how five `smtp_*` codes shipped with no place in the
    forwarding set, the same way `mail_thread_mutation_unsupported` had.

    The vocabulary is declared once now, in `MAIL_SERVICE_ERROR_CODES`, and the
    compiler holds every throw site to it: `MailHttpError` accepts only a code
    from that set, so a code that can reach the wire — as a literal or relayed
    from an error class — is a code this test sees. A domain code has to be
    forwarded, because it exists to tell a surface something it can act on. The
    transport codes and the admission ledger's own codes are declared apart
    because collapsing them is the point: they only occur when Brain's own
    proxy sends something malformed, or on routes no surface calls.
  */
  it("proxies every relayed service error code", () => {
    expect(MAIL_SERVICE_ERROR_CODES.relayed).toContain(
      "mail_thread_mutation_unsupported",
    );
    expect(MAIL_SERVICE_ERROR_CODES.relayed).toContain(
      "smtp_authentication_failed",
    );
    expect(
      MAIL_SERVICE_ERROR_CODES.relayed.filter(
        (code) => !SAFE_SERVICE_ERROR_CODES.has(code),
      ),
    ).toEqual([]);
    // Forwarding one of these unchanged would hand the browser a code that
    // only Brain's own proxy can act on.
    expect(
      [
        ...MAIL_SERVICE_ERROR_CODES.transport,
        ...MAIL_SERVICE_ERROR_CODES.admission,
      ].filter((code) => SAFE_SERVICE_ERROR_CODES.has(code)),
    ).toEqual([]);
    // One code, one group. A code in two groups would let a relayed meaning
    // hide behind a transport name.
    const every = [
      ...MAIL_SERVICE_ERROR_CODES.relayed,
      ...MAIL_SERVICE_ERROR_CODES.transport,
      ...MAIL_SERVICE_ERROR_CODES.admission,
    ];
    expect(new Set(every).size).toBe(every.length);
  });

  /*
    Two hours of a real incident produced one log line, because only a status of
    500 or more was ever written down. The refusals are the half worth keeping:
    each one is a decision the service made about the owner's mail, and each one
    used to leave nothing behind. The account and the route travel with it —
    "mail_sync_unavailable" alone cannot tell an operator which of two accounts
    is unwell, or whether a list, a mutation or a sync raised it.
  */
  it("records a refused mutation with its account and its route", async () => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const messages = messageServiceFixture();
      vi.mocked(messages.updateThread).mockRejectedValue(
        new MailProviderSyncError("mail_provider_mutation_unsupported"),
      );
      const socketPath = await startServer(messages, sendServiceFixture());

      await requestJson(
        socketPath,
        "PATCH",
        `/v1/threads/${THREAD_ID}`,
        JSON.stringify({ accountId: ACCOUNT_ID, archive: true }),
      );

      expect(written.map((line) => JSON.parse(line))).toEqual([
        {
          event: "mail_request_failed",
          errorCode: "mail_thread_mutation_unsupported",
          phase: "thread_patch",
          accountId: ACCOUNT_ID,
        },
      ]);
      // The thread id is message data and has no allowlisted field to sit in.
      expect(written.join("")).not.toContain(THREAD_ID);
    } finally {
      stderr.mockRestore();
    }
  });

  /*
    The account in a record was read straight off the query string, and the
    projection's only guard was that it looked like an identifier at all: up
    to 128 characters of letters, digits and a little punctuation. A token
    pasted into `accountId` fits that and would have been written down as an
    account. The route refuses the request; the record has to refuse the field.
  */
  it("keeps an account id that does not look like one out of the record", async () => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const socketPath = await startServer(
        messageServiceFixture(),
        sendServiceFixture(),
      );
      const token = "ya29.a0AfB4XvL2".padEnd(128, "x");

      const refused = await requestJson(
        socketPath,
        "GET",
        `/v1/threads?accountId=${token}&limit=20`,
      );

      expect(refused.status).toBe(400);
      expect(written.map((line) => JSON.parse(line))).toEqual([
        {
          event: "mail_request_failed",
          errorCode: "mail_request_invalid",
          phase: "thread_list_get",
        },
      ]);
      expect(written.join("")).not.toContain(token);
    } finally {
      stderr.mockRestore();
    }
  });

  it("names the route of a read that found nothing", async () => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const messages = messageServiceFixture();
      vi.mocked(messages.getThread).mockResolvedValue(null);
      const socketPath = await startServer(messages, sendServiceFixture());

      await requestJson(
        socketPath,
        "GET",
        `/v1/threads/${THREAD_ID}?accountId=${ACCOUNT_ID}`,
      );

      expect(written.map((line) => JSON.parse(line))).toEqual([
        {
          event: "mail_request_failed",
          errorCode: "mail_thread_not_found",
          phase: "thread_get",
          accountId: ACCOUNT_ID,
        },
      ]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("rejects ambiguous queries and oversized normal bodies before services", async () => {
    const messages = messageServiceFixture();
    const send = sendServiceFixture();
    const socketPath = await startServer(messages, send);

    const duplicate = await requestJson(
      socketPath,
      "GET",
      `/v1/threads?accountId=${ACCOUNT_ID}&accountId=${ACCOUNT_ID}`,
    );
    const tooMany = await requestJson(
      socketPath,
      "POST",
      "/v1/sync",
      JSON.stringify({ accountId: ACCOUNT_ID, maxItems: 21 }),
    );
    const unknown = await requestJson(
      socketPath,
      "GET",
      `/v1/threads/${THREAD_ID}?accountId=${ACCOUNT_ID}&provider=gmail`,
    );
    const unknownMailbox = await requestJson(
      socketPath,
      "GET",
      `/v1/mailboxes/drafts/threads?accountId=${ACCOUNT_ID}`,
    );

    expect([
      duplicate.status,
      tooMany.status,
      unknown.status,
      unknownMailbox.status,
    ]).toEqual([400, 400, 400, 400]);
    expect(messages.listThreads).not.toHaveBeenCalled();
    expect(messages.sync).not.toHaveBeenCalled();
    expect(messages.getThread).not.toHaveBeenCalled();
  });

  it("maps a malformed opaque mailbox cursor to a public 400", async () => {
    const messages = messageServiceFixture();
    vi.mocked(messages.listMailboxThreads).mockRejectedValueOnce(
      new MailCacheError("mail_request_invalid"),
    );
    const socketPath = await startServer(messages, sendServiceFixture());

    await expect(
      requestJson(
        socketPath,
        "GET",
        `/v1/mailboxes/sent/threads?accountId=${ACCOUNT_ID}&cursor=e30`,
      ),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "mail_request_invalid" } },
    });
  });

  it("maps malformed search cursors to 400 and stale search cursors to 409", async () => {
    const messages = messageServiceFixture();
    vi.mocked(messages.searchThreads)
      .mockRejectedValueOnce(new MailCacheError("mail_request_invalid"))
      .mockRejectedValueOnce(new MailCacheError("mail_sync_stale"));
    const socketPath = await startServer(messages, sendServiceFixture());

    const malformed = await requestJson(
      socketPath,
      "POST",
      "/v1/search",
      JSON.stringify({
        accountId: ACCOUNT_ID,
        mailboxId: "inbox",
        query: "quarterly",
        cursor: "e30",
        limit: 20,
      }),
    );
    const stale = await requestJson(
      socketPath,
      "POST",
      "/v1/search",
      JSON.stringify({
        accountId: ACCOUNT_ID,
        mailboxId: "inbox",
        query: "quarterly",
        cursor: "eyJ2IjoxLCJmIjoiYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJvIjoxfQ",
        limit: 20,
      }),
    );

    expect(malformed).toMatchObject({
      status: 400,
      body: { error: { code: "mail_request_invalid" } },
    });
    expect(stale).toMatchObject({
      status: 409,
      body: { error: { code: "mail_sync_in_progress" } },
    });
  });

  it("projects cached search through the service codec and rejects terminal cursors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-mail-search-contract-"));
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { mode: 0o700 });
    const cache = new SqliteMailMessageCache({ cacheRoot, accountId: ACCOUNT_ID });
    await cache.initialize();
    try {
      const generation = cache.beginInitial("100");
      cache.putInitialPage(
        generation,
        [
          cachedSearchThreadFixture("search-a", 2_000),
          cachedSearchThreadFixture("search-b", 1_000),
        ],
        null,
        null,
      );
      cache.completeInitial(generation, 3_000);
      const service = new AccountMailMessageService({
        accountId: ACCOUNT_ID,
        cache,
        provider: unusedProviderFixture(),
        reauthErrorCode: "gmail_reauth_required",
      });
      const socketPath = await startServer(service, sendServiceFixture());
      const client = createBrainMailClient({ socketPath });

      const first = await client.searchThreads({
        accountId: ACCOUNT_ID,
        mailboxId: "inbox",
        query: "quarterly",
        limit: 1,
      });
      expect(first).toMatchObject({
        mailboxId: "inbox",
        items: [{ threadId: "search-a" }],
        availability: {
          status: "available",
          lastSuccessfulAt: 3_000,
          windowTruncated: false,
        },
        indexStatus: "ready",
      });
      expect(Object.keys(first.availability).sort()).toEqual([
        "lastSuccessfulAt",
        "status",
        "windowTruncated",
      ]);
      expect(JSON.stringify(first)).not.toMatch(/activeGeneration|observedHistoryId/);
      expect(first.nextCursor).not.toBeNull();

      const terminalOffsetCursor = Buffer.from(
        JSON.stringify({ v: 1, f: "a".repeat(43), o: 500 }),
        "utf8",
      ).toString("base64url");
      await expect(
        client.searchThreads({
          accountId: ACCOUNT_ID,
          mailboxId: "inbox",
          query: "quarterly",
          cursor: terminalOffsetCursor,
          limit: 1,
        }),
      ).rejects.toMatchObject({ status: 400, code: "mail_request_invalid" });
      await expect(
        client.searchThreads({
          accountId: ACCOUNT_ID,
          mailboxId: "inbox",
          query: "project",
          cursor: first.nextCursor,
          limit: 1,
        }),
      ).rejects.toMatchObject({ status: 409, code: "mail_sync_in_progress" });
    } finally {
      cache.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps message routes fail-closed while their services are absent", async () => {
    const socketPath = await startServer();
    await expect(
      requestJson(
        socketPath,
        "GET",
        `/v1/threads?accountId=${ACCOUNT_ID}`,
      ),
    ).resolves.toMatchObject({
      status: 503,
      body: { error: { code: "mail_sync_unavailable" } },
    });
    await expect(
      requestJson(socketPath, "POST", "/v1/send", JSON.stringify(sendInput())),
    ).resolves.toMatchObject({
      status: 503,
      body: { error: { code: "mail_send_service_unavailable" } },
    });
  });
});

function messageServiceFixture(): MailMessageService & Record<string, ReturnType<typeof vi.fn>> {
  const thread = threadFixture();
  return {
    readBackgroundSyncHealth: vi.fn(async () => ({
      lastSuccessfulAt: null,
      lastErrorCode: null,
    })),
    listThreads: vi.fn(async () => ({
      apiVersion: 1,
      items: [thread],
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 1 },
    })),
    listMailboxThreads: vi.fn(async () => ({
      apiVersion: 1,
      mailboxId: "sent",
      items: [thread],
      nextCursor: null,
      availability: {
        status: "available",
        lastSuccessfulAt: 1,
        windowTruncated: false,
      },
    })),
    searchThreads: vi.fn(async () => ({
      apiVersion: 1,
      mailboxId: "inbox",
      scope: "headers_and_previews",
      items: [thread],
      nextCursor: null,
      availability: {
        status: "available",
        lastSuccessfulAt: 1,
        windowTruncated: false,
      },
      indexStatus: "ready",
      resultsTruncated: false,
    })),
    getThread: vi.fn(async () => ({ apiVersion: 1, thread, messages: [] })),
    getMailboxThread: vi.fn(async () => ({
      apiVersion: 1,
      thread,
      messages: [],
    })),
    sync: vi.fn(async () => ({
      apiVersion: 1,
      status: "idle",
      changedCount: 1,
      hasMore: false,
    })),
    syncAccount: vi.fn(async () => ({
      apiVersion: 1,
      status: "idle",
      changedCount: 1,
      hasMore: false,
    })),
    updateThread: vi.fn(async () => ({ apiVersion: 1, thread })),
  } as MailMessageService & Record<string, ReturnType<typeof vi.fn>>;
}

function sendServiceFixture(): MailSendService & Record<string, ReturnType<typeof vi.fn>> {
  return {
    send: vi.fn(async () => ({
      apiVersion: 1,
      operationId: OPERATION_ID,
      created: true,
      status: "queued",
    })),
    status: vi.fn(async () => ({
      apiVersion: 1,
      operationId: OPERATION_ID,
      status: "sent",
    })),
  } as MailSendService & Record<string, ReturnType<typeof vi.fn>>;
}

/** A v2 account service whose every mutation answers with one refusal. */
function accountServiceRefusing(error: MailAccountError): MailAccountServiceV2 {
  return {
    localSchemaVersion: 2,
    accountCount: async () => 0,
    list: async () => ({ apiVersion: 2, accounts: [] }),
    listCapabilities: async () => ({ apiVersion: 3, accounts: [] }),
    add: async () => {
      throw error;
    },
    update: async () => {
      throw error;
    },
    remove: async () => {
      throw error;
    },
    status: async () => ({ apiVersion: 1, configured: false, account: null }),
    connect: async () => ({ apiVersion: 1, configured: false, account: null }),
    disconnect: async () => ({ apiVersion: 1, configured: false, account: null }),
  };
}

function createAccountInput() {
  return {
    providerKind: "imap",
    emailAddress: "person@example.test",
    displayName: null,
    imap: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit",
      username: "person@example.test",
      password: "test-password",
    },
    smtp: {
      hostname: "smtp.example.test",
      port: 465,
      tls: "implicit",
      username: "person@example.test",
    },
  } as const;
}

function threadFixture() {
  return {
    accountId: ACCOUNT_ID,
    threadId: THREAD_ID,
    subject: "Hello",
    participants: [{ name: "Person", address: "person@example.test" }],
    snippet: "Preview",
    lastMessageAt: 1,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
  } as const;
}

function cachedSearchThreadFixture(
  threadId: string,
  sentAt: number,
): CachedProviderThread {
  const message: CachedProviderMessage = Object.freeze({
    accountId: ACCOUNT_ID,
    messageId: `message-${threadId}`,
    threadId,
    from: Object.freeze({ name: "Sender", address: "sender@example.test" }),
    replyTo: Object.freeze([]),
    to: Object.freeze([{ name: null, address: "reader@example.test" }]),
    cc: Object.freeze([]),
    subject: `Quarterly project ${threadId}`,
    sentAt,
    unread: true,
    inInbox: true,
    snippet: `Cached preview ${threadId}`,
    textBody: `Body ${threadId}`,
    htmlBody: null,
    hasAttachments: false,
    rfcMessageId: `<${threadId}@example.test>`,
    references: Object.freeze([]),
    listMessage: false,
    category: "people",
    sizeEstimate: null,
  });
  const thread: MailThreadListItem = Object.freeze({
    accountId: ACCOUNT_ID,
    threadId,
    subject: message.subject,
    participants: Object.freeze([message.from!]),
    snippet: message.snippet,
    lastMessageAt: sentAt,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
  });
  return Object.freeze({
    thread,
    messages: Object.freeze([message]),
    inInbox: true,
    mailboxes: Object.freeze(["all", "inbox"] as const),
  });
}

function unusedProviderFixture(): MailProviderSyncPort {
  return {
    getSyncAnchor: vi.fn().mockResolvedValue("100"),
    listInitialThreads: vi.fn().mockResolvedValue({ threads: [], nextPageToken: null }),
    listMailboxThreads: vi.fn().mockResolvedValue({
      threads: [],
      listedCount: 0,
      nextPageToken: null,
    }),
    listChanges: vi.fn().mockResolvedValue({
      changedThreadIds: [],
      nextPageToken: null,
      resultingHistoryId: "100",
    }),
    getThread: vi.fn().mockResolvedValue(null),
    setThreadRead: vi.fn().mockResolvedValue(undefined),
    archiveThread: vi.fn().mockResolvedValue(undefined),
    unarchiveThread: vi.fn().mockResolvedValue(undefined),
    trashThread: vi.fn().mockResolvedValue(undefined),
    restoreThread: vi.fn().mockResolvedValue(undefined),
    setThreadSpam: vi.fn().mockResolvedValue(undefined),
    setThreadStarred: vi.fn().mockResolvedValue(undefined),
  };
}

function sendInput() {
  return {
    accountId: ACCOUNT_ID,
    idempotencyKey: "12345678-1234-4123-8123-123456789abc",
    mode: "compose",
    to: ["person@example.test"],
    cc: [],
    bcc: [],
    subject: "Hello",
    text: "Body",
    replyToMessageId: null,
  } as const;
}

async function startServer(
  messages?: MailMessageService,
  send?: MailSendService,
  accounts?: Parameters<typeof createMailServiceHttpServer>[0]["accounts"],
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-http-messages-"));
  const socketPath = path.join(root, "mail.sock");
  const server = createMailServiceHttpServer({
    build: { commit: "dev", builtAt: "dev" },
    messages,
    send,
    accounts,
  });
  running.push({ server, root });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return socketPath;
}

function requestJson(
  socketPath: string,
  method: string,
  requestPath: string,
  body?: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method,
        path: requestPath,
        headers: {
          Host: "brain-mail",
          ...extraHeaders,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : null,
          });
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}
