import { request as httpRequest, type Server } from "node:http";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailSystemAdmissionPort } from "../ports";
import {
  MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER,
  MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE,
  MailAccountError,
} from "./account-types";
import type {
  MailAccountService,
  MailAccountServiceV2,
} from "./accounts";
import { createMailServiceHttpServer } from "./http";
import { MAIL_SERVICE_HTTP_LIMITS } from "./limits";

interface TestServer {
  readonly server: Server;
  readonly root: string;
  readonly socketPath: string;
}

const running: TestServer[] = [];

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
  vi.restoreAllMocks();
});

describe("brain-mail HTTP-over-UDS shell", () => {
  it("pins every header, body, deadline, keepalive, and request-count limit", () => {
    const server = createMailServiceHttpServer({
      build: { commit: "dev", builtAt: "dev" },
    });

    expect(MAIL_SERVICE_HTTP_LIMITS).toEqual({
      maxHeaderBytes: 8 * 1024,
      maxHeaders: 32,
      maxBodyBytes: 16 * 1024,
      maxSendBodyBytes: 1_200_000,
      maxDraftBodyBytes: 8 * 1024 * 1024,
      headersTimeoutMs: 2_000,
      requestDeadlineMs: 5_000,
      accountConnectDeadlineMs: 10_000,
      providerOperationDeadlineMs: 10_000,
      attachmentIdleTimeoutMs: 30_000,
      attachmentAbsoluteTimeoutMs: 5 * 60_000,
      keepAliveTimeoutMs: 2_000,
      maxRequestsPerSocket: 32,
      maxConnections: 16,
      maxActiveReservations: 256,
      connectionsCheckingIntervalMs: 250,
    });
    expect(server.maxHeadersCount).toBe(33);
    expect(server.headersTimeout).toBe(2_000);
    expect(server.requestTimeout).toBe(10_000);
    expect(server.keepAliveTimeout).toBe(2_000);
    expect(server.maxRequestsPerSocket).toBe(32);
    expect(server.maxConnections).toBe(16);
  });

  it("returns exact pre-database health and admission usage", async () => {
    const instance = await startServer();
    const health = await requestJson(instance.socketPath, "GET", "/v1/health");
    expect(health).toMatchObject({
      status: 200,
      body: {
        apiVersion: 1,
        build: { commit: "dev", builtAt: "dev" },
        status: "ok",
        localSchemaVersion: null,
        cacheSchemaVersion: null,
        receiveReadiness: "not_configured",
        sendReadiness: "not_configured",
        activeAccounts: 0,
        queuedSubmissions: 0,
        lastSuccessfulSyncAgeMs: null,
        cachePressure: "normal",
        lastErrorCode: null,
      },
    });
    const admission = await requestJson(
      instance.socketPath,
      "GET",
      "/v1/admission",
    );
    expect(admission.status).toBe(200);
    expect(admission.body).toMatchObject({
      apiVersion: 1,
      usage: { concurrentSmtpSubmissions: 0, temporaryBytes: 0 },
    });
  });

  it("dispatches exact Gmail OAuth redirects without echoing query or cookie", async () => {
    const cookie = "__Host-brain-gmail-oauth=" + "A".repeat(64);
    const gmailOAuth: NonNullable<
      Parameters<typeof createMailServiceHttpServer>[0]["gmailOAuth"]
    > = {
      start: vi.fn(async () => ({
        status: 303 as const,
        location: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque",
        setCookie: `${cookie}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      })),
      callback: vi.fn(async () => ({
        status: 303 as const,
        location: "https://brain.test/mail?gmail=connected",
        setCookie:
          "__Host-brain-gmail-oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      })),
    };
    const instance = await startServer(undefined, undefined, gmailOAuth);
    const accountId = "account-a11111111111111111111111111111111";
    const start = await rawRequest(
      instance.socketPath,
      `POST /v1/oauth/gmail/start?accountId=${accountId} HTTP/1.1\r\n` +
        "Host: brain-mail\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    expect(start).toContain("HTTP/1.1 303 See Other");
    expect(start).toContain("Location: https://accounts.google.com/");
    expect(start).toContain("Cache-Control: no-store");
    expect(gmailOAuth.start).toHaveBeenCalledWith(accountId);

    const callback = await rawRequest(
      instance.socketPath,
      "GET /v1/oauth/gmail/callback?code=CALLBACK_CODE_SECRET&state=CALLBACK_STATE_SECRET HTTP/1.1\r\n" +
        `Host: brain-mail\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`,
    );
    expect(callback).toContain("HTTP/1.1 303 See Other");
    expect(callback).toContain("Location: https://brain.test/mail?gmail=connected");
    expect(callback).not.toContain("CALLBACK_CODE_SECRET");
    expect(callback).not.toContain("CALLBACK_STATE_SECRET");
    expect(gmailOAuth.callback).toHaveBeenCalledWith(
      "?code=CALLBACK_CODE_SECRET&state=CALLBACK_STATE_SECRET",
      cookie,
      expect.any(AbortSignal),
    );
  });

  it("keeps health available and OAuth fail-closed when Google is disabled", async () => {
    const instance = await startServer();
    await expect(
      requestJson(instance.socketPath, "GET", "/v1/health"),
    ).resolves.toMatchObject({ status: 200, body: { status: "ok" } });
    await expect(
      requestJson(instance.socketPath, "POST", "/v1/oauth/gmail/start"),
    ).resolves.toMatchObject({
      status: 503,
      body: { error: { code: "gmail_oauth_unavailable" } },
    });
  });

  it("never copies OAuth query, cookie, or token details into service logs", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((value: unknown) => {
      writes.push(String(value));
      return true;
    }) as typeof process.stderr.write);
    const gmailOAuth: NonNullable<
      Parameters<typeof createMailServiceHttpServer>[0]["gmailOAuth"]
    > = {
      start: vi.fn(),
      callback: vi.fn(async () => {
        throw new Error("ACCESS_TOKEN_SECRET REFRESH_TOKEN_SECRET");
      }),
    };
    const instance = await startServer(undefined, undefined, gmailOAuth);
    const cookie = "__Host-brain-gmail-oauth=" + "C".repeat(64);
    const response = await rawRequest(
      instance.socketPath,
      "GET /v1/oauth/gmail/callback?code=CODE_SECRET&state=STATE_SECRET HTTP/1.1\r\n" +
        `Host: brain-mail\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`,
    );
    const observable = `${response}\n${writes.join("\n")}`;
    for (const secret of [
      "CODE_SECRET",
      "STATE_SECRET",
      cookie,
      "ACCESS_TOKEN_SECRET",
      "REFRESH_TOKEN_SECRET",
    ]) {
      expect(observable).not.toContain(secret);
    }
    expect(writes.join("\n")).toContain('"errorCode":"internal_error"');
  });

  it("exposes redacted account status, connect, and idempotent local disconnect", async () => {
    const connected = accountStatusFixture();
    const accounts: MailAccountService = {
      status: vi.fn(async () => connected),
      connect: vi.fn(async () => connected),
      disconnect: vi.fn(async () => ({
        apiVersion: 1 as const,
        configured: false,
        account: null,
      })),
    };
    const instance = await startServer(undefined, accounts);
    const payload = JSON.stringify({
      emailAddress: "person@example.test",
      imap: {
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit",
        username: "person@example.test",
        password: "SECRET test password",
      },
    });

    const connect = await requestJson(
      instance.socketPath,
      "POST",
      "/v1/account",
      payload,
    );
    expect(connect).toMatchObject({ status: 200, body: connected });
    expect(connect.rawBody).not.toContain("SECRET");
    expect(await requestJson(instance.socketPath, "GET", "/v1/account")).toMatchObject({
      status: 200,
      body: connected,
    });
    expect(
      await requestJson(instance.socketPath, "DELETE", "/v1/account"),
    ).toMatchObject({
      status: 200,
      body: { apiVersion: 1, configured: false, account: null },
    });
  });

  it("exposes exact v2 multi-account CRUD and schema-aware health", async () => {
    const first = accountResultV2Fixture(1).account;
    const second = accountResultV2Fixture(2).account;
    const accounts: MailAccountServiceV2 = {
      localSchemaVersion: 2,
      accountCount: vi.fn(async () => 2),
      list: vi.fn(async () => ({
        apiVersion: 2 as const,
        accounts: [first, second],
      })),
      listCapabilities: vi.fn(async () => ({
        apiVersion: 3 as const,
        accounts: [first, second].map((account) => ({
          ...account,
          capabilities: imapCapabilitiesFixture(),
        })),
      })),
      add: vi.fn(async () => accountResultV2Fixture(3)),
      update: vi.fn(async () => ({
        apiVersion: 2 as const,
        account: { ...first, displayName: "Personal" },
      })),
      remove: vi.fn(async () => ({ apiVersion: 2 as const, account: second })),
      status: vi.fn(async () => accountStatusFixture()),
      connect: vi.fn(async () => accountStatusFixture()),
      disconnect: vi.fn(async () => ({
        apiVersion: 1 as const,
        configured: false,
        account: null,
      })),
    };
    const instance = await startServer(undefined, accounts);

    await expect(
      requestJson(instance.socketPath, "GET", "/v2/accounts"),
    ).resolves.toMatchObject({
      status: 200,
      body: { apiVersion: 2, accounts: [first, second] },
    });
    await expect(
      requestJson(instance.socketPath, "GET", "/v2/accounts", undefined, {
        [MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER]:
          MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        apiVersion: 3,
        accounts: [
          { ...first, capabilities: imapCapabilitiesFixture() },
          { ...second, capabilities: imapCapabilitiesFixture() },
        ],
      },
    });
    await expect(
      requestJson(
        instance.socketPath,
        "POST",
        "/v2/accounts",
        JSON.stringify({
          providerKind: "imap",
          emailAddress: "person-3@example.test",
          displayName: null,
          imap: {
            hostname: "imap.example.test",
            port: 993,
            tls: "implicit",
            username: "person-3@example.test",
            password: "test-password-3",
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 201, body: accountResultV2Fixture(3) });
    await expect(
      requestJson(
        instance.socketPath,
        "PATCH",
        `/v2/accounts/${first.accountId}`,
        JSON.stringify({ displayName: "Personal" }),
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: { apiVersion: 2, account: { displayName: "Personal" } },
    });
    await expect(
      requestJson(
        instance.socketPath,
        "DELETE",
        `/v2/accounts/${second.accountId}`,
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: { apiVersion: 2, account: { accountId: second.accountId } },
    });
    await expect(
      requestJson(instance.socketPath, "GET", "/v1/health"),
    ).resolves.toMatchObject({
      status: 200,
      body: { localSchemaVersion: 2, activeAccounts: 2 },
    });
    expect(JSON.stringify(await accounts.list())).not.toContain("password");
  });

  it("maps v2 account conflicts without exposing state details", async () => {
    const accounts = accountServiceV2ErrorFixture(
      new MailAccountError("account_limit_reached"),
    );
    const instance = await startServer(undefined, accounts);
    const response = await requestJson(
      instance.socketPath,
      "POST",
      "/v2/accounts",
      JSON.stringify({
        providerKind: "imap",
        emailAddress: "person@example.test",
        imap: {
          hostname: "imap.example.test",
          port: 993,
          tls: "implicit",
          username: "person@example.test",
          password: "test-password",
        },
      }),
    );
    expect(response).toMatchObject({
      status: 409,
      body: { error: { code: "account_limit_reached" } },
    });

    const invalid = await requestJson(
      instance.socketPath,
      "PATCH",
      "/v2/accounts/account-a11111111111111111111111111111111",
      JSON.stringify({ displayName: "Personal", extra: true }),
    );
    expect(invalid).toMatchObject({
      status: 400,
      body: { error: { code: "account_request_invalid" } },
    });
  });

  it("returns a safe conflict for stale v1 mutations with multiple accounts", async () => {
    const accounts: MailAccountService = {
      status: async () => accountStatusFixture(),
      connect: async () => {
        throw new MailAccountError("account_selection_required");
      },
      disconnect: async () => {
        throw new MailAccountError("account_selection_required");
      },
    };
    const instance = await startServer(undefined, accounts);
    const post = await requestJson(
      instance.socketPath,
      "POST",
      "/v1/account",
      JSON.stringify({
        emailAddress: "person@example.test",
        imap: {
          hostname: "imap.example.test",
          port: 993,
          tls: "implicit",
          username: "person@example.test",
          password: "test-password",
        },
      }),
    );
    const deletion = await requestJson(
      instance.socketPath,
      "DELETE",
      "/v1/account",
    );
    for (const response of [post, deletion]) {
      expect(response).toMatchObject({
        status: 409,
        body: { error: { code: "account_selection_required" } },
      });
    }
  });

  it("keeps TLS distinct and hides wrapping-key and raw provider errors", async () => {
    for (const testCase of [
      {
        error: new MailAccountError("imap_tls_failed"),
        status: 422,
        code: "imap_tls_failed",
      },
      {
        error: new MailAccountError("credential_key_invalid"),
        status: 503,
        code: "account_unavailable",
      },
    ]) {
      const accounts: MailAccountService = {
        status: async () => ({ apiVersion: 1, configured: false, account: null }),
        connect: async () => {
          throw testCase.error;
        },
        disconnect: async () => ({ apiVersion: 1, configured: false, account: null }),
      };
      const instance = await startServer(undefined, accounts);
      const response = await requestJson(
        instance.socketPath,
        "POST",
        "/v1/account",
        JSON.stringify({
          emailAddress: "person@example.test",
          imap: {
            hostname: "imap.example.test",
            port: 993,
            tls: "implicit",
            username: "person@example.test",
            password: "test-only-password",
          },
        }),
      );
      expect(response).toMatchObject({
        status: testCase.status,
        body: { apiVersion: 1, error: { code: testCase.code } },
      });
      expect(response.rawBody).not.toContain("credential_key_invalid");
    }
  });

  it("aborts connect without a late effect after a full-body client disconnect", async () => {
    const effects: string[] = [];
    let observedSignal: AbortSignal | undefined;
    const accounts: MailAccountService = {
      status: async () => ({ apiVersion: 1, configured: false, account: null }),
      connect: vi.fn(async (_input, context) => {
        observedSignal = context.signal;
        await new Promise<void>((_resolve, reject) => {
          const abort = () =>
            reject(new MailAccountError("imap_connection_timeout"));
          if (context.signal.aborted) {
            abort();
            return;
          }
          context.signal.addEventListener("abort", abort, { once: true });
        });
        effects.push("saved");
        return accountStatusFixture();
      }),
      disconnect: async () => ({ apiVersion: 1, configured: false, account: null }),
    };
    const instance = await startServer(undefined, accounts);
    const body = JSON.stringify({
      emailAddress: "person@example.test",
      imap: {
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit",
        username: "person@example.test",
        password: "test-only-password",
      },
    });
    const socket = createConnection({
      path: instance.socketPath,
      allowHalfOpen: false,
    });
    await waitForConnect(socket);
    socket.write(
      "POST /v1/account HTTP/1.1\r\n" +
        "Host: brain-mail\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n\r\n" +
        body,
    );
    try {
      await vi.waitFor(() => expect(observedSignal).toBeDefined());
      socket.destroy();
      await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
      expect(effects).toEqual([]);
    } finally {
      socket.destroy();
    }
  });

  it("atomically rejects one of two HTTP reservations at the global ceiling", async () => {
    const instance = await startServer();
    const reserve = (operationId: string) =>
      requestJson(
        instance.socketPath,
        "POST",
        "/v1/admission/reservations",
        JSON.stringify({
          operationId,
          delta: { concurrentSmtpSubmissions: 1 },
        }),
      );
    const results = await Promise.all([reserve("smtp-a"), reserve("smtp-b")]);

    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const winner = results.find((result) => result.status === 201);
    expect(winner?.body).toMatchObject({
      apiVersion: 1,
      reservationId: expect.stringMatching(/^reservation-r[0-9a-f]{32}$/),
    });
    expect(results.find((result) => result.status === 409)?.body).toEqual({
      apiVersion: 1,
      error: { code: "capacity_exceeded" },
    });

    const reservationId = (winner?.body as { reservationId: string }).reservationId;
    expect(
      await requestJson(
        instance.socketPath,
        "DELETE",
        `/v1/admission/reservations/${reservationId}`,
      ),
    ).toMatchObject({ status: 204, rawBody: "" });
    expect(
      await requestJson(instance.socketPath, "GET", "/v1/admission"),
    ).toMatchObject({
      status: 200,
      body: { usage: { concurrentSmtpSubmissions: 0 } },
    });
  });

  it("accepts the exact body limit and rejects one byte more", async () => {
    const instance = await startServer();
    const base = JSON.stringify({
      operationId: "body-limit",
      delta: { temporaryBytes: 1 },
    });
    const exact = `${base}${" ".repeat(MAIL_SERVICE_HTTP_LIMITS.maxBodyBytes - base.length)}`;
    expect(Buffer.byteLength(exact)).toBe(MAIL_SERVICE_HTTP_LIMITS.maxBodyBytes);
    expect(
      await requestJson(
        instance.socketPath,
        "POST",
        "/v1/admission/reservations",
        exact,
      ),
    ).toMatchObject({ status: 201 });

    const response = await rawRequest(
      instance.socketPath,
      "POST /v1/admission/reservations HTTP/1.1\r\n" +
        "Host: brain-mail\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${MAIL_SERVICE_HTTP_LIMITS.maxBodyBytes + 1}\r\n` +
        "Connection: close\r\n\r\n",
    );
    expect(response).toContain("HTTP/1.1 413 Payload Too Large");
    expect(response).toContain('"code":"request_body_too_large"');
  });

  it("enforces the header byte ceiling and exact header-count boundary", async () => {
    const instance = await startServer();
    const oversizedBytes = await rawRequest(
      instance.socketPath,
      "GET /v1/health HTTP/1.1\r\n" +
        "Host: brain-mail\r\n" +
        `X-Fill: ${"a".repeat(MAIL_SERVICE_HTTP_LIMITS.maxHeaderBytes)}\r\n` +
        "Connection: close\r\n\r\n",
    );
    expect(oversizedBytes).toContain(
      "HTTP/1.1 431 Request Header Fields Too Large",
    );
    expect(oversizedBytes).toContain('"code":"headers_too_large"');

    const exactCount = await rawRequest(
      instance.socketPath,
      createHeaderCountRequest(MAIL_SERVICE_HTTP_LIMITS.maxHeaders),
    );
    expect(exactCount).toContain("HTTP/1.1 200 OK");

    const oversizedCount = await rawRequest(
      instance.socketPath,
      createHeaderCountRequest(MAIL_SERVICE_HTTP_LIMITS.maxHeaders + 1),
    );
    expect(oversizedCount).toContain(
      "HTTP/1.1 431 Request Header Fields Too Large",
    );
    expect(oversizedCount).toContain('"code":"headers_too_large"');
  });

  it("enforces header and keep-alive deadlines on live sockets", async () => {
    const headerInstance = await startServer();
    const keepAliveInstance = await startServer();
    const started = performance.now();
    const [headerResponse, keepAliveResponse] = await Promise.all([
      rawRequest(
        headerInstance.socketPath,
        "GET /v1/health HTTP/1.1\r\nHost: brain-mail\r\nX-Held:",
      ),
      rawRequest(
        keepAliveInstance.socketPath,
        "GET /v1/health HTTP/1.1\r\nHost: brain-mail\r\n\r\n",
      ),
    ]);
    const elapsed = performance.now() - started;

    expect(headerResponse).toContain("HTTP/1.1 408 Request Timeout");
    expect(headerResponse).toContain('"code":"headers_deadline_exceeded"');
    expect(keepAliveResponse).toContain("HTTP/1.1 200 OK");
    expect(elapsed).toBeGreaterThanOrEqual(
      MAIL_SERVICE_HTTP_LIMITS.keepAliveTimeoutMs - 500,
    );
    expect(elapsed).toBeLessThan(
      MAIL_SERVICE_HTTP_LIMITS.keepAliveTimeoutMs + 2_000,
    );
  }, 8_000);

  it("closes a socket after the exact request-count limit", async () => {
    const instance = await startServer();
    const request = "GET /v1/health HTTP/1.1\r\nHost: brain-mail\r\n\r\n";
    const response = await rawRequest(
      instance.socketPath,
      request.repeat(MAIL_SERVICE_HTTP_LIMITS.maxRequestsPerSocket + 1),
    );

    expect(countOccurrences(response, "HTTP/1.1 200 OK")).toBe(
      MAIL_SERVICE_HTTP_LIMITS.maxRequestsPerSocket,
    );
    expect(countOccurrences(response, "HTTP/1.1 503 Service Unavailable")).toBe(1);
  });

  it("drops a connection beyond the exact concurrent-connection limit", async () => {
    const instance = await startServer();
    const held = Array.from(
      { length: MAIL_SERVICE_HTTP_LIMITS.maxConnections },
      () => createConnection(instance.socketPath),
    );
    try {
      await Promise.all(held.map(waitForConnect));
      await waitForConnectionCount(
        instance.server,
        MAIL_SERVICE_HTTP_LIMITS.maxConnections,
      );

      const overflow = createConnection(instance.socketPath);
      const chunks: Buffer[] = [];
      overflow.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      overflow.on("error", () => undefined);
      await withTimeout(
        new Promise<void>((resolve) => overflow.once("close", () => resolve())),
        1_000,
        "overflow mail connection stayed open",
      );

      expect(Buffer.concat(chunks)).toHaveLength(0);
      expect(await connectionCount(instance.server)).toBe(
        MAIL_SERVICE_HTTP_LIMITS.maxConnections,
      );
    } finally {
      held.forEach((socket) => socket.destroy());
    }
  });

  it("ends partial input and hung admission at the absolute request deadline", async () => {
    const bodyInstance = await startServer();
    const hungAdmission: MailSystemAdmissionPort = {
      readUsage: () => new Promise<never>(() => undefined),
      reserve: () => new Promise<never>(() => undefined),
      release: () => new Promise<never>(() => undefined),
    };
    const admissionInstance = await startServer(hungAdmission);
    const started = performance.now();
    const [bodyResponse, admissionResponse] = await Promise.all([
      rawRequest(
        bodyInstance.socketPath,
        "POST /v1/admission/reservations HTTP/1.1\r\n" +
          "Host: brain-mail\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: 100\r\n" +
          "Connection: close\r\n\r\n" +
          '{"operationId":"held"',
      ),
      rawRequest(
        admissionInstance.socketPath,
        "GET /v1/health HTTP/1.1\r\nHost: brain-mail\r\nConnection: close\r\n\r\n",
      ),
    ]);
    const elapsed = performance.now() - started;

    for (const response of [bodyResponse, admissionResponse]) {
      expect(response).toContain("HTTP/1.1 408 Request Timeout");
      expect(response).toContain('"code":"request_deadline_exceeded"');
    }
    expect(elapsed).toBeGreaterThanOrEqual(
      MAIL_SERVICE_HTTP_LIMITS.requestDeadlineMs - 500,
    );
    expect(elapsed).toBeLessThan(MAIL_SERVICE_HTTP_LIMITS.requestDeadlineMs + 2_000);
  }, 10_000);
});

async function startServer(
  admission?: MailSystemAdmissionPort,
  accounts?: MailAccountService,
  gmailOAuth?: Parameters<typeof createMailServiceHttpServer>[0]["gmailOAuth"],
): Promise<TestServer> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-http-"));
  const socketPath = path.join(root, "mail.sock");
  const server = createMailServiceHttpServer({
    build: { commit: "dev", builtAt: "dev" },
    admission,
    accounts,
    gmailOAuth,
  });
  const instance = { server, root, socketPath };
  running.push(instance);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return instance;
}

function accountStatusFixture() {
  return {
    apiVersion: 1 as const,
    configured: true,
    account: {
      accountId: "account-a11111111111111111111111111111111",
      emailAddress: "person@example.test",
      imap: {
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit" as const,
        username: "person@example.test",
      },
      connectedAt: 1,
    },
  };
}

function accountResultV2Fixture(index: number) {
  const digit = String(index);
  return {
    apiVersion: 2 as const,
    account: {
      accountId: `account-a${digit.repeat(32)}`,
      emailAddress: `person-${index}@example.test`,
      displayName: null,
      status: "connected" as const,
      connectedAt: index,
      createdAt: index,
      updatedAt: index,
      providerKind: "imap" as const,
      imap: {
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit" as const,
        username: `person-${index}@example.test`,
      },
    },
  };
}

function accountServiceV2ErrorFixture(
  error: MailAccountError,
): MailAccountServiceV2 {
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

function imapCapabilitiesFixture() {
  return {
    mailboxes: ["inbox"] as const,
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: false,
    send: false,
    reply: false,
  };
}

function createHeaderCountRequest(headers: number): string {
  if (headers < 2) throw new Error("header fixture needs Host and Connection");
  const extras = Array.from(
    { length: headers - 2 },
    (_value, index) => `X-${index}: a\r\n`,
  ).join("");
  return (
    `GET /v1/health HTTP/1.1\r\nHost: brain-mail\r\n${extras}` +
    "Connection: close\r\n\r\n"
  );
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function requestJson(
  socketPath: string,
  method: string,
  requestPath: string,
  body?: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{ status: number; body: unknown; rawBody: string }> {
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
          const rawBody = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: rawBody ? JSON.parse(rawBody) : null,
            rawBody,
          });
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function rawRequest(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw mail service request timed out"));
    }, MAIL_SERVICE_HTTP_LIMITS.requestDeadlineMs + 3_000);
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("connect", () => socket.write(payload));
  });
}

function waitForConnect(socket: ReturnType<typeof createConnection>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === "open") {
      resolve();
      return;
    }
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function connectionCount(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((error, count) =>
      error ? reject(error) : resolve(count),
    );
  });
}

async function waitForConnectionCount(
  server: Server,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if ((await connectionCount(server)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`mail service did not reach ${expected} connections`);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref();
    }),
  ]);
}
