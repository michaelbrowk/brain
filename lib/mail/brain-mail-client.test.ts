import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrainMailClientError,
  createBrainMailClient,
  readMailChanges,
  type MailAccountConnectInput,
  type MailAccountStatus,
} from "./brain-mail-client";
import type { MailSendInput } from "./message-types";
import {
  MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER,
  MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE,
} from "./service/account-types";

const connectedStatus = (): MailAccountStatus => ({
  apiVersion: 1,
  configured: true,
  account: {
    accountId: "account-a0123456789abcdef0123456789abcdef",
    emailAddress: "person@example.test",
    imap: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit",
      username: "person@example.test",
    },
    connectedAt: CONNECTED_AT,
  },
});

const connectInput: MailAccountConnectInput = {
  emailAddress: "person@example.test",
  imap: {
    hostname: "imap.example.test",
    port: 993,
    tls: "implicit",
    username: "person@example.test",
    password: "SECRET only sent to the service",
  },
};

const CONNECTED_AT = Date.now();

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Brain Mail Unix-socket client", () => {
  it("uses the exact account contract and returns only redacted state", async () => {
    const requests: Array<{ method: string; body: string }> = [];
    const { socketPath } = await startServer(async (request, response) => {
      const body = await readBody(request);
      requests.push({ method: request.method ?? "", body });
      if (request.method === "DELETE") {
        writeJson(response, 200, {
          apiVersion: 1,
          configured: false,
          account: null,
        });
        return;
      }
      writeJson(response, 200, connectedStatus());
    });
    const client = createBrainMailClient({ socketPath });

    const connected = await client.connect(connectInput);
    expect(connected).toEqual(connectedStatus());
    expect(JSON.stringify(connected)).not.toContain("SECRET");
    expect(JSON.parse(requests[0].body)).toEqual(connectInput);
    expect((await client.status()).configured).toBe(true);
    expect(await client.disconnect()).toEqual({
      apiVersion: 1,
      configured: false,
      account: null,
    });
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "DELETE",
    ]);
  });

  it("bridges exact v2 list, create, patch, and scoped delete contracts", async () => {
    const requests: Array<{ method: string; path: string; body: string }> = [];
    const account = accountV2Fixture();
    const { socketPath } = await startServer(async (request, response) => {
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body,
      });
      writeJson(
        response,
        request.method === "POST" ? 201 : 200,
        request.method === "GET"
          ? { apiVersion: 2, accounts: [account] }
          : { apiVersion: 2, account },
      );
    });
    const client = createBrainMailClient({ socketPath });

    await expect(client.listAccounts()).resolves.toEqual({
      apiVersion: 2,
      accounts: [account],
    });
    await client.createAccount({
      ...connectInput,
      providerKind: "imap",
      displayName: "Personal",
    });
    await client.updateAccount(account.accountId, { displayName: "Private" });
    await client.deleteAccount(account.accountId);

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v2/accounts",
      "POST /v2/accounts",
      `PATCH /v2/accounts/${account.accountId}`,
      `DELETE /v2/accounts/${account.accountId}`,
    ]);
    expect(JSON.parse(requests[1].body)).toMatchObject({
      providerKind: "imap",
      displayName: "Personal",
      imap: { password: "SECRET only sent to the service" },
    });
    expect(JSON.parse(requests[2].body)).toEqual({ displayName: "Private" });
    expect(requests[3].body).toBe("");
  });

  it("sends SMTP metadata without a second secret and accepts only redacted send capabilities", async () => {
    const requests: Array<{ method: string; path: string; body: string }> = [];
    const smtp = {
      hostname: "smtp.example.test",
      port: 465,
      tls: "implicit" as const,
      username: "smtp-person@example.test",
    };
    const account = { ...accountV2Fixture(), smtp };
    const { socketPath } = await startServer(async (request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: await readBody(request),
      });
      if (request.method === "GET") {
        writeJson(response, 200, {
          apiVersion: 3,
          accounts: [
            {
              ...account,
              capabilities: {
                ...imapCapabilitiesFixture(),
                compose: true,
                send: true,
                reply: true,
              },
            },
          ],
        });
        return;
      }
      writeJson(response, 201, { apiVersion: 2, account });
    });
    const client = createBrainMailClient({ socketPath });

    const created = await client.createAccount({
      ...connectInput,
      providerKind: "imap",
      displayName: "Custom domain",
      smtp,
    });
    expect(created.account.providerKind).toBe("imap");
    if (created.account.providerKind !== "imap") {
      throw new Error("expected IMAP account");
    }
    expect(created.account.smtp).toEqual(smtp);
    expect(JSON.stringify(created)).not.toContain("SECRET");
    expect(JSON.parse(requests[0].body)).toEqual({
      ...connectInput,
      providerKind: "imap",
      displayName: "Custom domain",
      smtp,
    });
    await expect(client.listAccountCapabilities()).resolves.toMatchObject({
      apiVersion: 3,
      accounts: [
        {
          smtp,
          capabilities: { compose: true, send: true, reply: true },
        },
      ],
    });
  });

  it("accepts a configured SMTP account as temporarily receive-only", async () => {
    const smtp = {
      hostname: "smtp.example.test",
      port: 587,
      tls: "starttls" as const,
      username: "person@example.test",
    };
    const account = { ...accountV2Fixture(), smtp };
    const { socketPath } = await startServer((_request, response) => {
      writeJson(response, 200, {
        apiVersion: 3,
        accounts: [
          { ...account, capabilities: imapCapabilitiesFixture() },
        ],
      });
    });

    await expect(
      createBrainMailClient({ socketPath }).listAccountCapabilities(),
    ).resolves.toMatchObject({
      accounts: [
        {
          smtp,
          capabilities: { compose: false, send: false, reply: false },
        },
      ],
    });
  });

  it("negotiates and validates the exact provider capability contract", async () => {
    let requestedContract: string | undefined;
    const account = accountV2Fixture();
    const { socketPath } = await startServer((request, response) => {
      requestedContract = request.headers[
        MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER
      ] as string | undefined;
      writeJson(response, 200, {
        apiVersion: 3,
        accounts: [
          {
            ...account,
            capabilities: imapCapabilitiesFixture(),
          },
        ],
      });
    });

    await expect(
      createBrainMailClient({ socketPath }).listAccountCapabilities(),
    ).resolves.toEqual({
      apiVersion: 3,
      accounts: [
        {
          ...account,
          capabilities: imapCapabilitiesFixture(),
        },
      ],
    });
    expect(requestedContract).toBe(MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE);
  });

  it("derives conservative capabilities from an older v2 service", async () => {
    const account = accountV2Fixture();
    const { socketPath } = await startServer((_request, response) => {
      writeJson(response, 200, { apiVersion: 2, accounts: [account] });
    });

    await expect(
      createBrainMailClient({ socketPath }).listAccountCapabilities(),
    ).resolves.toEqual({
      apiVersion: 3,
      accounts: [
        {
          ...account,
          capabilities: imapCapabilitiesFixture(),
        },
      ],
    });
  });

  it("reads which transport SMTP leaves by from the service's health, and nothing else of it", async () => {
    const health = {
      apiVersion: 1,
      build: { commit: "dev", builtAt: "dev" },
      status: "ok",
      sendReadiness: "ready",
    };
    let answer: unknown = health;
    const requests: string[] = [];
    const { socketPath } = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      writeJson(response, 200, answer);
    });
    const client = createBrainMailClient({ socketPath });

    for (const sendTransport of ["direct", "authenticated_byte_relay"] as const) {
      answer = { ...health, sendTransport };
      await expect(client.readSendTransport()).resolves.toBe(sendTransport);
    }
    expect(requests).toEqual(["GET /v1/health", "GET /v1/health"]);
    // A receive-only service, an older one, and a later one that says more.
    for (const older of [
      health,
      { ...health, sendTransport: "carrier pigeon" },
      { ...health, sendTransport: "direct", apiVersion: 2 },
    ]) {
      answer = older;
      await expect(client.readSendTransport()).resolves.toBeNull();
    }
    answer = { ...health, sendTransport: "direct", somethingLater: true };
    await expect(client.readSendTransport()).resolves.toBe("direct");
    // Not a health answer at all.
    for (const broken of [[], "direct", null]) {
      answer = broken;
      await expect(client.readSendTransport()).rejects.toMatchObject({
        code: "mail_service_invalid_response",
      });
    }
  });

  it("rejects malformed or inflated provider capabilities", async () => {
    const account = accountV2Fixture();
    for (const capabilities of [
      { ...imapCapabilitiesFixture(), compose: true },
      { ...imapCapabilitiesFixture(), secret: "SECRET leak" },
      { ...imapCapabilitiesFixture(), mailboxes: ["inbox", "sent"] },
    ]) {
      const { socketPath } = await startServer((_request, response) => {
        writeJson(response, 200, {
          apiVersion: 3,
          accounts: [{ ...account, capabilities }],
        });
      });

      await expect(
        createBrainMailClient({ socketPath }).listAccountCapabilities(),
      ).rejects.toMatchObject({
        status: 502,
        code: "mail_service_invalid_response",
      });
    }
  });

  it("rejects extended or ambiguous v2 success payloads", async () => {
    for (const payload of [
      {
        apiVersion: 2,
        accounts: [{ ...accountV2Fixture(), password: "SECRET leak" }],
      },
      {
        apiVersion: 2,
        accounts: [
          accountV2Fixture(),
          { ...accountV2Fixture(), displayName: "Duplicate id" },
        ],
      },
      {
        apiVersion: 2,
        accounts: [{ ...accountV2Fixture(), providerKind: "gmail" }],
      },
    ]) {
      const { socketPath } = await startServer((_request, response) => {
        writeJson(response, 200, payload);
      });
      await expect(
        createBrainMailClient({ socketPath }).listAccounts(),
      ).rejects.toMatchObject({
        status: 502,
        code: "mail_service_invalid_response",
      });
    }
  });

  it("rejects a success payload that adds a password field", async () => {
    const { socketPath } = await startServer((_request, response) => {
      const status = connectedStatus();
      writeJson(response, 200, {
        ...status,
        account: { ...status.account, password: "SECRET response leak" },
      });
    });

    await expect(createBrainMailClient({ socketPath }).status()).rejects.toMatchObject({
      status: 502,
      code: "mail_service_invalid_response",
      message: "mail_service_invalid_response",
    });
  });

  it("fails closed on malformed error envelopes without exposing provider text", async () => {
    const { socketPath } = await startServer((_request, response) => {
      writeJson(response, 422, {
        apiVersion: 1,
        error: {
          code: "imap_authentication_failed",
          message: "SECRET provider diagnostic",
        },
      });
    });

    let caught: unknown;
    try {
      await createBrainMailClient({ socketPath }).connect(connectInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrainMailClientError);
    expect(caught).toMatchObject({
      status: 502,
      code: "mail_service_invalid_response",
    });
    expect(String(caught)).not.toContain("SECRET");
  });

  it("rejects oversized, chunked, and truncated service responses", async () => {
    for (const responseKind of ["oversized", "chunked", "truncated"] as const) {
      const { socketPath } = await startServer((_request, response) => {
        if (responseKind === "oversized") {
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": String(32 * 1024 + 1),
          });
          response.end("{}");
          return;
        }
        if (responseKind === "chunked") {
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Transfer-Encoding": "chunked",
          });
          response.end("{}");
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": "20",
        });
        response.write("{}");
        setImmediate(() => response.destroy());
      });

      await expect(
        createBrainMailClient({ socketPath, requestTimeoutMs: 100 }).status(),
      ).rejects.toMatchObject({
        status: 502,
        code: "mail_service_invalid_response",
      });
    }
  });

  it("enforces an absolute deadline even while the service trickles bytes", async () => {
    const { socketPath } = await startServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": "100",
      });
      response.write("{");
      const interval = setInterval(() => response.write(" "), 5);
      response.once("close", () => clearInterval(interval));
    });

    await expect(
      createBrainMailClient({ socketPath, requestTimeoutMs: 35 }).status(),
    ).rejects.toMatchObject({
      status: 504,
      code: "mail_service_timeout",
    });
  });

  it("uses the additive exact system-mailbox list contract", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const observed: string[] = [];
    const { socketPath } = await startServer((request, response) => {
      observed.push(request.url ?? "");
      writeJson(response, 200, {
        apiVersion: 1,
        mailboxId: "spam",
        items: [],
        nextCursor: null,
        availability: {
          status: "unavailable",
          reason: "mailbox_syncing",
          lastSuccessfulAt: null,
          windowTruncated: null,
        },
      });
    });

    await expect(
      createBrainMailClient({ socketPath }).listMailboxThreads(
        accountId,
        "spam",
        { cursor: "cursor_1", limit: 20 },
      ),
    ).resolves.toMatchObject({
      mailboxId: "spam",
      availability: { status: "unavailable", reason: "mailbox_syncing" },
    });
    expect(observed).toEqual([
      `/v1/mailboxes/spam/threads?accountId=${accountId}&limit=20&cursor=cursor_1`,
    ]);
    await expect(
      createBrainMailClient({ socketPath }).listMailboxThreads(
        accountId,
        "drafts" as "spam",
      ),
    ).rejects.toMatchObject({ status: 400, code: "mail_request_invalid" });
  });

  it("rejects a mailbox response bound to another account or mailbox", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const otherAccountId = "account-a11111111111111111111111111111111";
    for (const payload of [
      {
        apiVersion: 1,
        mailboxId: "spam",
        items: [],
        nextCursor: null,
        availability: {
          status: "available",
          lastSuccessfulAt: 1,
          windowTruncated: false,
        },
      },
      {
        apiVersion: 1,
        mailboxId: "sent",
        items: [mailThreadFixture(otherAccountId)],
        nextCursor: null,
        availability: {
          status: "available",
          lastSuccessfulAt: 1,
          windowTruncated: false,
        },
      },
    ]) {
      const { socketPath } = await startServer((_request, response) => {
        writeJson(response, 200, payload);
      });
      await expect(
        createBrainMailClient({ socketPath }).listMailboxThreads(
          accountId,
          "sent",
        ),
      ).rejects.toMatchObject({
        status: 502,
        code: "mail_service_invalid_response",
      });
    }
  });

  it("sends normalized local search only in a POST body and validates its bindings", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const observed: Array<{ method: string; path: string; body: unknown }> = [];
    const { socketPath } = await startServer(async (request, response) => {
      observed.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: JSON.parse(await readBody(request)) as unknown,
      });
      writeJson(response, 200, {
        apiVersion: 1,
        mailboxId: "inbox",
        scope: "headers_and_previews",
        items: [mailThreadFixture(accountId)],
        nextCursor: null,
        availability: {
          status: "available",
          lastSuccessfulAt: 1,
          windowTruncated: false,
        },
        indexStatus: "ready",
        resultsTruncated: false,
      });
    });

    await expect(
      createBrainMailClient({ socketPath }).searchThreads({
        accountId,
        mailboxId: "inbox",
        query: "  Quarterly LAUNCH!!! ",
        limit: 20,
      }),
    ).resolves.toMatchObject({
      mailboxId: "inbox",
      scope: "headers_and_previews",
      items: [{ accountId }],
    });
    expect(observed).toEqual([
      {
        method: "POST",
        path: "/v1/search",
        body: {
          accountId,
          mailboxId: "inbox",
          query: "quarterly launch",
          cursor: null,
          limit: 20,
        },
      },
    ]);
  });

  it("rejects a search response that hides a truncated mailbox window", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const { socketPath } = await startServer((_request, response) => {
      writeJson(response, 200, {
        apiVersion: 1,
        mailboxId: "inbox",
        scope: "headers_and_previews",
        items: [],
        nextCursor: null,
        availability: {
          status: "available",
          lastSuccessfulAt: 1,
          windowTruncated: true,
        },
        indexStatus: "ready",
        resultsTruncated: false,
      });
    });
    await expect(
      createBrainMailClient({ socketPath }).searchThreads({
        accountId,
        mailboxId: "inbox",
        query: "private",
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "mail_service_invalid_response",
    });
  });

  it("speaks the new-senders routes with exact requests and exact answers", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const decisionId = "decision-a0123456789abcdef0123456789abcdef";
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const { socketPath } = await startServer(async (request, response) => {
      const body = await readBody(request);
      seen.push({ method: request.method ?? "", url: request.url ?? "", body });
      if (request.url === "/v1/senders/state") {
        const enabled = request.method === "PUT" ? JSON.parse(body).enabled : true;
        writeJson(response, 200, {
          apiVersion: 1,
          enabled,
          enabledAt: enabled ? 5 : null,
          backfillComplete: enabled,
          domainScopeRefused: ["gmail.com"],
        });
        return;
      }
      if (request.url === "/v1/senders/decisions") {
        writeJson(response, 200, {
          apiVersion: 1,
          decisionId,
          archived: [{ accountId, threadId: "thread_1" }],
          pending: false,
        });
        return;
      }
      if (request.url?.startsWith(`/v1/senders/decisions/${decisionId}`)) {
        writeJson(response, 200, {
          apiVersion: 1,
          restored: request.url.endsWith("restore=false")
            ? []
            : [{ accountId, threadId: "thread_1" }],
          pending: false,
        });
        return;
      }
      writeJson(response, 200, {
        apiVersion: 1,
        blocked: [
          { decisionId, key: "growth.test", scope: "domain", decidedAt: 9, archivedCount: 1 },
        ],
      });
    });
    const client = createBrainMailClient({ socketPath });

    await expect(client.getSenderScreenState()).resolves.toEqual({
      apiVersion: 1,
      enabled: true,
      enabledAt: 5,
      backfillComplete: true,
      domainScopeRefused: ["gmail.com"],
    });
    await expect(client.setSenderScreenEnabled(false)).resolves.toMatchObject({
      enabled: false,
      enabledAt: null,
    });
    await expect(
      client.decideSender({ address: "news@growth.test", scope: "domain", decision: "block" }),
    ).resolves.toMatchObject({ decisionId, archived: [{ accountId, threadId: "thread_1" }] });
    await expect(client.undoSenderDecision(decisionId, { restore: true })).resolves.toMatchObject({
      restored: [{ accountId, threadId: "thread_1" }],
    });
    await expect(client.undoSenderDecision(decisionId, { restore: false })).resolves.toMatchObject({
      restored: [],
    });
    await expect(client.listBlockedSenders()).resolves.toMatchObject({
      blocked: [{ key: "growth.test", scope: "domain" }],
    });

    expect(seen).toEqual([
      { method: "GET", url: "/v1/senders/state", body: "" },
      { method: "PUT", url: "/v1/senders/state", body: '{"enabled":false}' },
      {
        method: "POST",
        url: "/v1/senders/decisions",
        body: '{"address":"news@growth.test","scope":"domain","decision":"block"}',
      },
      { method: "DELETE", url: `/v1/senders/decisions/${decisionId}`, body: "" },
      { method: "DELETE", url: `/v1/senders/decisions/${decisionId}?restore=false`, body: "" },
      { method: "GET", url: "/v1/senders/blocked", body: "" },
    ]);
  });

  it("reads a block or an undo that names two hundred of the longest thread ids", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const decisionId = "decision-a0123456789abcdef0123456789abcdef";
    const refs = Array.from({ length: 200 }, (_, index) => ({
      accountId,
      threadId: `${index}`.padStart(255, "t"),
    }));
    const { socketPath } = await startServer((request, response) => {
      writeJson(
        response,
        200,
        request.method === "POST"
          ? { apiVersion: 1, decisionId, archived: refs, pending: true }
          : { apiVersion: 1, restored: refs, pending: true },
      );
    });
    const client = createBrainMailClient({ socketPath });

    await expect(
      client.decideSender({ address: "a@b.test", scope: "address", decision: "block" }),
    ).resolves.toMatchObject({ pending: true });
    await expect(
      client.undoSenderDecision(decisionId, { restore: true }),
    ).resolves.toMatchObject({ pending: true });
  });

  it("refuses a malformed new-senders request before the socket and relays the screen's refusals", async () => {
    let requests = 0;
    const { socketPath } = await startServer((_request, response) => {
      requests += 1;
      writeJson(response, 404, {
        apiVersion: 1,
        error: { code: "mail_sender_decision_not_found" },
      });
    });
    const client = createBrainMailClient({ socketPath });

    await expect(
      client.decideSender({
        address: "news@growth.test",
        scope: "everyone",
        decision: "block",
      } as never),
    ).rejects.toMatchObject({ status: 400, code: "mail_request_invalid" });
    await expect(
      client.undoSenderDecision("decision-1", { restore: true }),
    ).rejects.toMatchObject({ status: 400, code: "mail_request_invalid" });
    expect(requests).toBe(0);

    await expect(
      client.undoSenderDecision("decision-a0123456789abcdef0123456789abcdef", {
        restore: true,
      }),
    ).rejects.toMatchObject({ status: 404, code: "mail_sender_decision_not_found" });
  });

  it("opts into star state while remaining compatible with an old mail service", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    let requestedContract: string | undefined;
    const legacyThread = Object.fromEntries(
      Object.entries(mailThreadFixture(accountId)).filter(
        ([key]) => key !== "starred",
      ),
    );
    const { socketPath } = await startServer((request, response) => {
      requestedContract = request.headers["x-brain-mail-thread-state"] as
        | string
        | undefined;
      writeJson(response, 200, {
        apiVersion: 1,
        items: [legacyThread],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 1 },
      });
    });

    await expect(
      createBrainMailClient({ socketPath }).listThreads(accountId),
    ).resolves.toMatchObject({ items: [{ starred: false, newSender: false }] });
    expect(requestedContract).toBe("5");
  });

  it("serializes view and sort only when non-default and reads the tier-3 fields", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const observed: string[] = [];
    const { socketPath } = await startServer((request, response) => {
      observed.push(request.url ?? "");
      if ((request.url ?? "").startsWith("/v1/mailboxes/")) {
        writeJson(response, 200, {
          apiVersion: 1,
          mailboxId: "sent",
          items: [],
          nextCursor: null,
          availability: {
            status: "available",
            lastSuccessfulAt: 1,
            windowTruncated: false,
          },
        });
        return;
      }
      writeJson(response, 200, {
        apiVersion: 1,
        items: [
          { ...mailThreadFixture(accountId), listMessage: true, sizeBytes: 4_096 },
        ],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 1 },
      });
    });
    const client = createBrainMailClient({ socketPath });

    await expect(
      client.listThreads(accountId, { limit: 20, view: "lists", sort: "size" }),
    ).resolves.toMatchObject({
      items: [{ listMessage: true, sizeBytes: 4_096 }],
    });
    await client.listThreads(accountId, { limit: 20, sort: "date" });
    await client.listMailboxThreads(accountId, "sent", {
      limit: 20,
      view: "people",
      sort: "sender",
    });
    expect(observed).toEqual([
      `/v1/threads?accountId=${accountId}&limit=20&view=lists&sort=size`,
      `/v1/threads?accountId=${accountId}&limit=20`,
      `/v1/mailboxes/sent/threads?accountId=${accountId}&limit=20&view=people&sort=sender`,
    ]);

    for (const options of [
      { view: "starred" },
      { sort: "newest" },
      { view: "" },
    ]) {
      await expect(
        client.listThreads(accountId, options),
      ).rejects.toMatchObject({ status: 400, code: "mail_request_invalid" });
      await expect(
        client.listMailboxThreads(accountId, "sent", options),
      ).rejects.toMatchObject({ status: 400, code: "mail_request_invalid" });
    }
  });

  it("rejects an Inbox page carrying exactly one of the two view fields", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    for (const partial of [
      { ...mailThreadFixture(accountId), listMessage: true },
      { ...mailThreadFixture(accountId), sizeBytes: 4_096 },
    ]) {
      const { socketPath } = await startServer((_request, response) => {
        writeJson(response, 200, {
          apiVersion: 1,
          items: [partial],
          nextCursor: null,
          sync: { status: "idle", lastSuccessfulAt: 1 },
        });
      });
      await expect(
        createBrainMailClient({ socketPath }).listThreads(accountId),
      ).rejects.toMatchObject({
        status: 502,
        code: "mail_service_invalid_response",
      });
    }
  });

  it("rejects a legacy Inbox page containing another account", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const otherAccountId = "account-affffffffffffffffffffffffffffffff";
    const { socketPath } = await startServer((_request, response) => {
      writeJson(response, 200, {
        apiVersion: 1,
        items: [mailThreadFixture(otherAccountId)],
        nextCursor: null,
        sync: { status: "idle", lastSuccessfulAt: 1 },
      });
    });

    await expect(
      createBrainMailClient({ socketPath }).listThreads(accountId),
    ).rejects.toMatchObject({
      status: 502,
      code: "mail_service_invalid_response",
    });
  });

  it("rejects a mailbox detail response for another thread", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const { socketPath } = await startServer((_request, response) => {
      writeJson(response, 200, {
        apiVersion: 1,
        thread: { ...mailThreadFixture(accountId), threadId: "thread_other" },
        messages: [],
      });
    });

    await expect(
      createBrainMailClient({ socketPath }).getMailboxThread(
        accountId,
        "sent",
        "thread_1",
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "mail_service_invalid_response",
    });
  });

  it("sends every exact system action through the existing thread PATCH", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const requests: Array<{ path: string; body: unknown }> = [];
    const { socketPath } = await startServer(async (request, response) => {
      requests.push({
        path: request.url ?? "",
        body: JSON.parse(await readBody(request)) as unknown,
      });
      writeJson(response, 200, {
        apiVersion: 1,
        thread: mailThreadFixture(accountId),
      });
    });
    const client = createBrainMailClient({ socketPath });
    const mutations = [
      { accountId, trash: true },
      { accountId, restore: true },
      { accountId, spam: true },
      { accountId, spam: false },
      { accountId, starred: true },
      { accountId, starred: false },
    ] as const;

    for (const mutation of mutations) {
      await expect(client.updateThread("thread_1", mutation)).resolves.toMatchObject({
        thread: { accountId, threadId: "thread_1" },
      });
    }

    expect(requests).toEqual(
      mutations.map((mutation) => ({
        path: "/v1/threads/thread_1",
        body: mutation,
      })),
    );
  });

  it("archives a batch with one POST and reads the answer thread by thread", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    let answer: unknown = null;
    const { socketPath } = await startServer(async (request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: JSON.parse(await readBody(request)) as unknown,
      });
      writeJson(response, 200, answer);
    });
    const client = createBrainMailClient({ socketPath });
    const input = {
      accountId,
      threadIds: ["thread_1", "thread_2", "thread_3"],
      archive: true,
      read: true,
    } as const;
    const results = [
      {
        threadId: "thread_1",
        status: "done",
        thread: mailThreadFixture(accountId),
        markedRead: true,
      },
      { threadId: "thread_2", status: "stale" },
      { threadId: "thread_3", status: "failed", errorCode: "mail_sync_unavailable" },
    ];
    answer = { apiVersion: 1, results };

    await expect(client.archiveThreads(input)).resolves.toMatchObject({ apiVersion: 1, results });
    expect(requests).toEqual([{ method: "POST", path: "/v1/threads/batch", body: input }]);

    // An answer for other threads, in another order, or for another account
    // is not the answer to this batch.
    for (const garbled of [
      { apiVersion: 1, results: results.slice(1) },
      { apiVersion: 1, results: [results[1], results[0], results[2]] },
      {
        apiVersion: 1,
        results: [
          { ...results[0], thread: mailThreadFixture("account-a1111111111111111111111111111111") },
          results[1],
          results[2],
        ],
      },
      { apiVersion: 1, results: [{ ...results[0], markedRead: "yes" }, results[1], results[2]] },
    ]) {
      answer = garbled;
      await expect(client.archiveThreads(input)).rejects.toMatchObject({
        status: 502,
        code: "mail_service_invalid_response",
      });
    }
    // A batch that is not archive-with-optional-read never reaches the socket.
    const sent = requests.length;
    await expect(
      client.archiveThreads({ ...input, threadIds: [] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(sent);
  });

  it("bridges exact draft CRUD and atomic send contracts over the Unix socket", async () => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const draftId = "draft-00000000-0000-4000-8000-000000000001";
    const mutationId =
      "draft-mutation-00000000-0000-4000-8000-000000000001";
    const operationId = "send-00000000-0000-4000-8000-000000000001";
    const draft = mailDraftFixture(accountId, draftId);
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const { socketPath } = await startServer(async (request, response) => {
      const raw = await readBody(request);
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: raw === "" ? null : JSON.parse(raw) as unknown,
      });
      const pathname = new URL(request.url ?? "", "http://brain-mail").pathname;
      if (pathname.endsWith("/send")) {
        writeJson(response, 202, {
          apiVersion: 1,
          replayed: false,
          appliedRevision: 1,
          operationId,
          created: true,
          status: "queued",
        });
        return;
      }
      if (request.method === "POST") {
        writeJson(response, 201, { apiVersion: 1, created: true, draft });
        return;
      }
      if (request.method === "GET" && pathname === "/v1/drafts") {
        writeJson(response, 200, {
          apiVersion: 1,
          drafts: [mailDraftSummaryFixture(accountId, draftId)],
        });
        return;
      }
      if (request.method === "GET") {
        writeJson(response, 200, draft);
        return;
      }
      if (request.method === "PATCH") {
        writeJson(response, 200, {
          apiVersion: 1,
          replayed: false,
          appliedRevision: 1,
          operationId: null,
        });
        return;
      }
      writeJson(response, 200, {
        apiVersion: 1,
        deleted: true,
        replayed: false,
      });
    });
    const client = createBrainMailClient({ socketPath });
    const create = {
      accountId,
      draftId,
      intent: { kind: "compose" as const },
      to: "friend@example.test",
      cc: "",
      bcc: "",
      subject: "Hello",
      text: "Body",
    };
    const patch = {
      accountId,
      draftId,
      mutationId,
      expectedRevision: 0,
      kind: "patch" as const,
      patch: { subject: "Edited" },
    };
    const deletion = {
      accountId,
      draftId,
      mutationId,
      expectedRevision: 1,
    };
    const send = {
      accountId,
      draftId,
      mutationId,
      expectedRevision: 0,
      kind: "send" as const,
      sendIdempotencyKey: "draft-send-key-0001",
      sendOperationId: operationId,
    };

    await expect(client.createDraft(create)).resolves.toMatchObject({ created: true });
    await expect(client.listDrafts(accountId)).resolves.toMatchObject({
      drafts: [{ accountId, draftId }],
    });
    await expect(client.getDraft(accountId, draftId)).resolves.toMatchObject({
      accountId,
      draftId,
    });
    await expect(client.updateDraft(draftId, patch)).resolves.toMatchObject({
      operationId: null,
    });
    await expect(client.deleteDraft(draftId, deletion)).resolves.toEqual({
      apiVersion: 1,
      deleted: true,
      replayed: false,
    });
    await expect(client.sendDraft(draftId, send)).resolves.toMatchObject({
      operationId,
      status: "queued",
    });

    expect(requests).toEqual([
      { method: "POST", path: "/v1/drafts", body: create },
      {
        method: "GET",
        path: `/v1/drafts?accountId=${accountId}`,
        body: null,
      },
      {
        method: "GET",
        path: `/v1/drafts/${draftId}?accountId=${accountId}`,
        body: null,
      },
      { method: "PATCH", path: `/v1/drafts/${draftId}`, body: patch },
      { method: "DELETE", path: `/v1/drafts/${draftId}`, body: deletion },
      { method: "POST", path: `/v1/drafts/${draftId}/send`, body: send },
    ]);
  });

  it.each([
    ["another account", "account-affffffffffffffffffffffffffffffff", "thread_1"],
    ["another thread", "account-a0123456789abcdef0123456789abcdef", "thread_other"],
  ])("rejects a mutation response bound to %s", async (_name, responseAccountId, responseThreadId) => {
    const accountId = "account-a0123456789abcdef0123456789abcdef";
    const { socketPath } = await startServer((_request, response) => {
      writeJson(response, 200, {
        apiVersion: 1,
        thread: {
          ...mailThreadFixture(responseAccountId),
          threadId: responseThreadId,
        },
      });
    });

    await expect(
      createBrainMailClient({ socketPath }).updateThread("thread_1", {
        accountId,
        trash: true,
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "mail_service_invalid_response",
    });
  });

  it("aborts a pending socket request and returns only a stable code", async () => {
    const { socketPath } = await startServer(() => undefined);
    const controller = new AbortController();
    const pending = createBrainMailClient({ socketPath }).status(controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      status: 408,
      code: "mail_request_cancelled",
    });
  });

  it("maps the service's generic request deadline to the public timeout code", async () => {
    const { socketPath } = await startServer((_request, response) => {
      writeJson(response, 408, {
        apiVersion: 1,
        error: { code: "request_deadline_exceeded" },
      });
    });

    await expect(createBrainMailClient({ socketPath }).status()).rejects.toMatchObject({
      status: 504,
      code: "mail_service_timeout",
    });
  });

  it("streams a successful attachment before the service finishes its body", async () => {
    const release = deferred<void>();
    const firstWritten = deferred<void>();
    const { socketPath } = await startServer(async (_request, response) => {
      response.writeHead(200, attachmentHeaders(11));
      response.write("first", () => firstWritten.resolve());
      await release.promise;
      response.end("second");
    });
    const client = createBrainMailClient({ socketPath });
    const payload = await client.downloadAttachment(
      `account-a${"1".repeat(32)}`,
      `attachment-a${"2".repeat(32)}`,
    );
    const reader = payload.body.getReader();

    await firstWritten.promise;
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value!)).toEqual(Buffer.from("first"));
    release.resolve();
    const second = await reader.read();
    expect(Buffer.from(second.value!)).toEqual(Buffer.from("second"));
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("fails a streamed attachment whose body is shorter than Content-Length", async () => {
    const { socketPath } = await startServer((_request, response) => {
      response.writeHead(200, attachmentHeaders(10));
      response.end("short");
    });
    const payload = await createBrainMailClient({ socketPath }).downloadAttachment(
      `account-a${"1".repeat(32)}`,
      `attachment-a${"2".repeat(32)}`,
    );

    await expect(new Response(payload.body).arrayBuffer()).rejects.toMatchObject({
      code: "mail_service_invalid_response",
    });
  });

  it("destroys the UDS response when the attachment consumer cancels", async () => {
    const closed = deferred<void>();
    const { socketPath } = await startServer((_request, response) => {
      response.once("close", () => closed.resolve());
      response.writeHead(200, attachmentHeaders(100));
      response.write(Buffer.alloc(10, 0x61));
    });
    const payload = await createBrainMailClient({ socketPath }).downloadAttachment(
      `account-a${"1".repeat(32)}`,
      `attachment-a${"2".repeat(32)}`,
    );
    const reader = payload.body.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel();

    await expect(closed.promise).resolves.toBeUndefined();
  });

  it("closes the UDS request before a successful attachment arrives after setup timeout", async () => {
    const started = deferred<void>();
    const sendHeaders = deferred<void>();
    const closed = deferred<void>();
    const { socketPath } = await startServer(async (_request, response) => {
      response.once("close", () => closed.resolve());
      started.resolve();
      await sendHeaders.promise;
      response.writeHead(200, attachmentHeaders(4));
      response.end("late");
    });
    const pending = createBrainMailClient({
      socketPath,
      requestTimeoutMs: 20,
    }).downloadAttachment(
      `account-a${"1".repeat(32)}`,
      `attachment-a${"2".repeat(32)}`,
    );
    await started.promise;

    await expect(pending).rejects.toMatchObject({
      status: 504,
      code: "mail_service_timeout",
    });
    await expect(closed.promise).resolves.toBeUndefined();
    sendHeaders.resolve();
  });

  /*
    The Next process used to log nothing at all, so a request that never reached
    the socket, or one whose answer this client refused to read, left no trace
    on either side of it. Two hours of a real incident produced a single line,
    and none of it was here.
  */
  it("records the failures the service never got to see, and not the ones it did", async () => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const { socketPath } = await startServer((request, response) => {
        if (request.url?.startsWith("/v1/threads/refused")) {
          writeJson(response, 409, {
            apiVersion: 1,
            error: { code: "mail_thread_mutation_unsupported" },
          });
          return;
        }
        writeJson(response, 200, { apiVersion: 1, thread: "not a thread" });
      });
      const client = createBrainMailClient({ socketPath });
      const mutation = {
        accountId: "account-a0123456789abcdef0123456789abcdef",
        archive: true,
      } as const;

      // The service answered for itself and already logged it. One line, not two.
      await expect(
        client.updateThread("refused", mutation),
      ).rejects.toMatchObject({
        status: 409,
        code: "mail_thread_mutation_unsupported",
      });
      expect(written).toEqual([]);

      await expect(client.updateThread("garbled", mutation)).rejects.toMatchObject(
        { status: 502, code: "mail_service_invalid_response" },
      );
      expect(written.map((line) => JSON.parse(line))).toEqual([
        {
          event: "mail_proxy_request_failed",
          errorCode: "mail_service_invalid_response",
          phase: "thread_patch",
        },
      ]);
      expect(written.join("")).not.toContain("garbled");
    } finally {
      stderr.mockRestore();
    }
  });

  it("says whether the request had gone out when the socket died", async () => {
    // `mail_service_unavailable` is one code for two different worlds, and a
    // caller sending mail in the owner's name has to tell them apart: a
    // socket that never connected told the service nothing, one that died
    // after the body was written may have handed it the message.
    const { socketPath } = await startServer(async (request, response) => {
      await readBody(request);
      request.socket.destroy();
      response.destroy();
    });
    const died = createBrainMailClient({ socketPath });

    await expect(died.status()).rejects.toMatchObject({
      code: "mail_service_unavailable",
      requestSent: true,
    });

    const absent = createBrainMailClient({
      socketPath: path.join(path.dirname(socketPath), "nothing-here.sock"),
    });
    await expect(absent.status()).rejects.toMatchObject({
      code: "mail_service_unavailable",
      requestSent: false,
    });
  });

  /** `requestSent` answers "did the service hear us". `enqueued` answers the
   *  question after it: the service heard us, made the message durable, and
   *  then failed. Only the service knows that, so the client carries what it
   *  says rather than reading it off a status code. */
  it("carries the service's own enqueued flag onto the error", async () => {
    const bodies: unknown[] = [
      {
        apiVersion: 1,
        error: { code: "mail_send_service_unavailable", enqueued: true },
      },
      { apiVersion: 1, error: { code: "mail_send_service_unavailable" } },
      {
        apiVersion: 1,
        error: { code: "mail_send_service_unavailable", enqueued: "yes" },
      },
    ];
    const { socketPath } = await startServer((_request, response) => {
      writeJson(response, 503, bodies.shift());
    });
    const client = createBrainMailClient({ socketPath });

    await expect(client.sendMessage(sendInput())).rejects.toMatchObject({
      code: "mail_send_service_unavailable",
      enqueued: true,
    });
    await expect(client.sendMessage(sendInput())).rejects.toMatchObject({
      code: "mail_send_service_unavailable",
      enqueued: false,
    });
    // Anything but the flag itself is a body this client does not understand.
    await expect(client.sendMessage(sendInput())).rejects.toMatchObject({
      code: "mail_service_invalid_response",
    });
  });

  /** The figures a refusal names are the whole point of naming them: an agent
   *  told only `mail_send_request_invalid` cannot tell whether a smaller file
   *  would go through. The line is admitted as one short run of printable
   *  ASCII, so a service that sent a control character or a page of prose is
   *  one this client does not understand. */
  it("carries a refusal's detail onto the error, within limits", async () => {
    const named =
      "finished message of 15000000 bytes exceeds the 14680064 byte ceiling";
    const bodies: unknown[] = [
      {
        apiVersion: 1,
        error: { code: "mail_send_request_invalid", detail: named },
      },
      { apiVersion: 1, error: { code: "mail_send_request_invalid" } },
      {
        apiVersion: 1,
        error: { code: "mail_send_request_invalid", detail: "a\nb" },
      },
      {
        apiVersion: 1,
        error: { code: "mail_send_request_invalid", detail: "x".repeat(201) },
      },
    ];
    const { socketPath } = await startServer((_request, response) => {
      writeJson(response, 400, bodies.shift());
    });
    const client = createBrainMailClient({ socketPath });

    await expect(client.sendMessage(sendInput())).rejects.toMatchObject({
      code: "mail_send_request_invalid",
      detail: named,
    });
    await expect(client.sendMessage(sendInput())).rejects.toMatchObject({
      code: "mail_send_request_invalid",
      detail: null,
    });
    for (let index = 0; index < 2; index += 1) {
      await expect(client.sendMessage(sendInput())).rejects.toMatchObject({
        code: "mail_service_invalid_response",
      });
    }
  });
});

describe("Brain Mail change feed read", () => {
  const ACCOUNT = "account-a0123456789abcdef0123456789abcdef";

  it("asks from the cursor for up to the wait and hands back a checked answer", async () => {
    const paths: string[] = [];
    const answer = {
      apiVersion: 1,
      cursor: 42,
      changes: [
        { accountId: ACCOUNT, mailboxIds: ["inbox", "all"], kind: "sync" },
        { accountId: ACCOUNT, mailboxIds: [], kind: "content_ready", messageId: "message-1" },
      ],
    };
    const { socketPath } = await startServer((request, response) => {
      paths.push(request.url ?? "");
      writeJson(response, 200, answer);
    });

    await expect(
      readMailChanges({ cursor: 41, waitMs: 25_000 }, undefined, { socketPath }),
    ).resolves.toEqual(answer);
    await readMailChanges({ cursor: null, waitMs: 25_000 }, undefined, { socketPath });
    expect(paths).toEqual(["/v1/changes?cursor=41&wait=25000", "/v1/changes?wait=25000"]);
  });

  it("holds a read past the ordinary request timeout while the service waits", async () => {
    const { socketPath } = await startServer((_request, response) => {
      setTimeout(
        () => writeJson(response, 200, { apiVersion: 1, cursor: 7, changes: [], reset: true }),
        150,
      );
    });

    // The answer comes after the ordinary timeout and inside the wait.
    await expect(
      readMailChanges({ cursor: 3, waitMs: 200 }, undefined, {
        socketPath,
        requestTimeoutMs: 50,
      }),
    ).resolves.toEqual({ apiVersion: 1, cursor: 7, changes: [], reset: true });
  });

  it("refuses an answer it cannot read and names a busy refusal", async () => {
    const answers: Array<[number, unknown]> = [
      [200, { apiVersion: 1, cursor: -1, changes: [] }],
      [200, { apiVersion: 1, cursor: 1, changes: [{ accountId: ACCOUNT, mailboxIds: [], kind: "moved" }] }],
      [200, { apiVersion: 1, cursor: 1, changes: [{ accountId: ACCOUNT, mailboxIds: ["drafts"], kind: "sync" }] }],
      [200, { apiVersion: 1, cursor: 1, changes: [{ accountId: ACCOUNT, mailboxIds: [], kind: "content_ready" }] }],
      // A message id is a path segment on the way to the reader: only the
      // provider's safe alphabet, and only on a ready body.
      [
        200,
        {
          apiVersion: 1,
          cursor: 1,
          changes: [{ accountId: ACCOUNT, mailboxIds: [], kind: "content_ready", messageId: "../x" }],
        },
      ],
      [
        200,
        {
          apiVersion: 1,
          cursor: 1,
          changes: [{ accountId: ACCOUNT, mailboxIds: [], kind: "content_ready", messageId: "m".repeat(256) }],
        },
      ],
      [
        200,
        {
          apiVersion: 1,
          cursor: 1,
          changes: [{ accountId: ACCOUNT, mailboxIds: ["inbox"], kind: "sync", messageId: "message-1" }],
        },
      ],
      [200, { apiVersion: 1, cursor: 1, changes: [], reset: false }],
      [200, { apiVersion: 1, cursor: 1, changes: [], subject: "leak" }],
      [409, { apiVersion: 1, error: { code: "mail_changes_busy" } }],
    ];
    const { socketPath } = await startServer((_request, response) => {
      const [status, body] = answers.shift()!;
      writeJson(response, status, body);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    for (let index = 0; index < 9; index += 1) {
      await expect(
        readMailChanges({ cursor: 0, waitMs: 0 }, undefined, { socketPath }),
      ).rejects.toMatchObject({ code: "mail_service_invalid_response" });
    }
    await expect(
      readMailChanges({ cursor: 0, waitMs: 0 }, undefined, { socketPath }),
    ).rejects.toMatchObject({ status: 409, code: "mail_changes_busy" });
  });
});

function sendInput(): MailSendInput {
  return {
    accountId: "account-a0123456789abcdef0123456789abcdef",
    idempotencyKey: "compose-action-01",
    mode: "compose",
    to: ["friend@example.net"],
    cc: [],
    bcc: [],
    subject: "Hello",
    text: "Body",
    replyToMessageId: null,
    attachments: [],
    origin: "mcp",
    agentLine: false,
  };
}

function attachmentHeaders(bytes: number): Record<string, string> {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(bytes),
    "Content-Disposition":
      `attachment; filename="file.bin"; filename*=UTF-8''file.bin`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy":
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    Connection: "close",
  };
}

async function startServer(
  handler: RequestListener,
): Promise<{ socketPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-client-"));
  const socketPath = path.join(root, "mail.sock");
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  cleanups.push(async () => {
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  });
  return { socketPath };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function accountV2Fixture() {
  return {
    accountId: "account-a0123456789abcdef0123456789abcdef",
    emailAddress: "person@example.test",
    displayName: "Personal",
    status: "connected" as const,
    connectedAt: CONNECTED_AT,
    createdAt: CONNECTED_AT,
    updatedAt: CONNECTED_AT,
    providerKind: "imap" as const,
    imap: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit" as const,
      username: "person@example.test",
    },
  };
}

function imapCapabilitiesFixture() {
  return {
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
}

function mailDraftFixture(accountId: string, draftId: string) {
  return {
    apiVersion: 1 as const,
    accountId,
    draftId,
    revision: 0,
    state: "editing" as const,
    intent: { kind: "compose" as const },
    to: "friend@example.test",
    cc: "",
    bcc: "",
    subject: "Hello",
    text: "Body",
    attachments: [],
    sendOperationId: null,
    sendErrorCode: null,
    createdAt: 100,
    updatedAt: 100,
    sentAt: null,
  };
}

function mailDraftSummaryFixture(accountId: string, draftId: string) {
  const draft = mailDraftFixture(accountId, draftId);
  return {
    apiVersion: draft.apiVersion,
    accountId: draft.accountId,
    draftId: draft.draftId,
    revision: draft.revision,
    state: draft.state,
    intent: draft.intent,
    subject: draft.subject,
    sendOperationId: draft.sendOperationId,
    sendErrorCode: draft.sendErrorCode,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    sentAt: draft.sentAt,
  };
}

function mailThreadFixture(accountId: string) {
  return {
    accountId,
    threadId: "thread_1",
    subject: "Hello",
    participants: [{ name: null, address: "person@example.test" }],
    snippet: "Preview",
    lastMessageAt: 1,
    messageCount: 1,
    unread: false,
    starred: false,
    hasAttachments: false,
  };
}
