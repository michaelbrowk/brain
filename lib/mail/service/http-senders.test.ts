import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mailRequestPhase } from "../security";
import { createMailServiceHttpServer } from "./http";
import { MailSenderError, type MailSenderScreenService } from "./senders";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const DECISION_ID = "decision-a0123456789abcdef0123456789abcdef";
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

describe("brain-mail new-senders routes", () => {
  it("reads and switches the screen", async () => {
    const senders = screenFixture();
    const socketPath = await startServer(senders);

    const read = await requestJson(socketPath, "GET", "/v1/senders/state");
    const switched = await requestJson(
      socketPath,
      "PUT",
      "/v1/senders/state",
      JSON.stringify({ enabled: false }),
    );

    expect(read).toEqual({
      status: 200,
      body: {
        apiVersion: 1,
        enabled: true,
        enabledAt: 5,
        backfillComplete: true,
        domainScopeRefused: ["gmail.com"],
      },
    });
    expect(switched.status).toBe(200);
    expect(senders.setEnabled).toHaveBeenCalledWith(false);
  });

  it("records a decision with the request's deadline and signal", async () => {
    const senders = screenFixture();
    const socketPath = await startServer(senders);

    const answer = await requestJson(
      socketPath,
      "POST",
      "/v1/senders/decisions",
      JSON.stringify({ address: "Lena <lena@example.test>", scope: "address", decision: "block" }),
    );

    expect(answer).toEqual({
      status: 200,
      body: {
        apiVersion: 1,
        decisionId: DECISION_ID,
        archived: [{ accountId: ACCOUNT_ID, threadId: "thread_1" }],
        pending: false,
      },
    });
    const [input, context] = senders.decide.mock.calls[0]!;
    expect(input).toEqual({
      address: "Lena <lena@example.test>",
      scope: "address",
      decision: "block",
    });
    expect(context.deadlineAt).toBeGreaterThan(Date.now());
    expect(context.signal).toBeInstanceOf(AbortSignal);
  });

  it("undoes by default and unblocks when asked not to restore", async () => {
    const senders = screenFixture();
    const socketPath = await startServer(senders);

    const undo = await requestJson(socketPath, "DELETE", `/v1/senders/decisions/${DECISION_ID}`);
    const unblock = await requestJson(
      socketPath,
      "DELETE",
      `/v1/senders/decisions/${DECISION_ID}?restore=false`,
    );

    expect(undo.status).toBe(200);
    expect(unblock.status).toBe(200);
    expect(senders.undo.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [DECISION_ID, { restore: true }],
      [DECISION_ID, { restore: false }],
    ]);
  });

  it("lists the blocked senders", async () => {
    const socketPath = await startServer(screenFixture());

    const answer = await requestJson(socketPath, "GET", "/v1/senders/blocked");

    expect(answer).toEqual({
      status: 200,
      body: {
        apiVersion: 1,
        blocked: [
          {
            decisionId: DECISION_ID,
            key: "growth.test",
            scope: "domain",
            decidedAt: 9,
            archivedCount: 2,
          },
        ],
      },
    });
  });

  it("refuses malformed requests before the screen is asked", async () => {
    const senders = screenFixture();
    const socketPath = await startServer(senders);

    const requests: Array<() => Promise<{ status: number; body: unknown }>> = [
      () => requestJson(socketPath, "PUT", "/v1/senders/state", JSON.stringify({ enabled: "yes" })),
      () => requestJson(
        socketPath,
        "POST",
        "/v1/senders/decisions",
        JSON.stringify({ address: "lena@example.test", scope: "everyone", decision: "block" }),
      ),
      () => requestJson(
        socketPath,
        "POST",
        "/v1/senders/decisions",
        JSON.stringify({ address: "lena@example.test", scope: "address", decision: "block" }),
        { "Content-Type": "text/plain" },
      ),
      () => requestJson(socketPath, "DELETE", `/v1/senders/decisions/${DECISION_ID}?restore=maybe`),
      () => requestJson(socketPath, "DELETE", `/v1/senders/decisions/${DECISION_ID}?other=1`),
      () => requestJson(socketPath, "DELETE", "/v1/senders/decisions/decision-1"),
      () => requestJson(socketPath, "GET", "/v1/senders/state?x=1"),
      () => requestJson(socketPath, "PATCH", "/v1/senders/state", JSON.stringify({ enabled: true })),
      () => requestJson(socketPath, "GET", "/v1/senders/decisions"),
    ];
    const cases: Array<{ status: number; body: unknown }> = [];
    // One at a time: a refusal closes its connection, and the next request
    // must not be written onto a socket the server is ending.
    for (const send of requests) cases.push(await send());

    expect(cases.map((answer) => [answer.status, errorCode(answer.body)])).toEqual([
      [400, "mail_request_invalid"],
      [400, "mail_request_invalid"],
      [415, "content_type_invalid"],
      [400, "mail_request_invalid"],
      [400, "mail_request_invalid"],
      [404, "route_not_found"],
      [404, "route_not_found"],
      [405, "method_not_allowed"],
      [405, "method_not_allowed"],
    ]);
    expect(senders.setEnabled).not.toHaveBeenCalled();
    expect(senders.decide).not.toHaveBeenCalled();
    expect(senders.undo).not.toHaveBeenCalled();
  });

  it("answers the screen's own refusals with their codes", async () => {
    const senders = screenFixture();
    senders.decide
      .mockRejectedValueOnce(new MailSenderError("mail_request_invalid"))
      .mockRejectedValueOnce(new MailSenderError("mail_sender_own_address"))
      .mockRejectedValueOnce(new MailSenderError("mail_sender_domain_scope_refused"));
    senders.undo.mockRejectedValueOnce(new MailSenderError("mail_sender_decision_not_found"));
    senders.listBlocked.mockRejectedValueOnce(new MailSenderError("mail_senders_unavailable"));
    const socketPath = await startServer(senders);
    const decide = () =>
      requestJson(
        socketPath,
        "POST",
        "/v1/senders/decisions",
        JSON.stringify({ address: "someone@gmail.com", scope: "domain", decision: "block" }),
      );

    const answers = [
      await decide(),
      await decide(),
      await decide(),
      await requestJson(socketPath, "DELETE", `/v1/senders/decisions/${DECISION_ID}`),
      await requestJson(socketPath, "GET", "/v1/senders/blocked"),
    ];

    expect(answers.map((answer) => [answer.status, errorCode(answer.body)])).toEqual([
      [400, "mail_request_invalid"],
      [400, "mail_sender_own_address"],
      [400, "mail_sender_domain_scope_refused"],
      [404, "mail_sender_decision_not_found"],
      [503, "mail_senders_unavailable"],
    ]);
  });

  it("says the screen is unavailable when the service has none", async () => {
    const socketPath = await startServer(undefined);

    const answer = await requestJson(socketPath, "GET", "/v1/senders/state");

    expect([answer.status, errorCode(answer.body)]).toEqual([503, "mail_senders_unavailable"]);
  });

  it("names each route family in a failure record", () => {
    expect(mailRequestPhase("GET", "/v1/senders/state")).toBe("sender_state_get");
    expect(mailRequestPhase("POST", "/v1/senders/decisions")).toBe("sender_decision_list_post");
    expect(mailRequestPhase("DELETE", `/v1/senders/decisions/${DECISION_ID}`)).toBe(
      "sender_decision_delete",
    );
    expect(mailRequestPhase("GET", "/v1/senders/blocked")).toBe("sender_blocked_get");
  });
});

function screenFixture() {
  return {
    readState: vi.fn(async () => ({
      apiVersion: 1 as const,
      enabled: true,
      enabledAt: 5,
      backfillComplete: true,
      domainScopeRefused: ["gmail.com"],
    })),
    setEnabled: vi.fn(async (enabled: boolean) => ({
      apiVersion: 1 as const,
      enabled,
      enabledAt: enabled ? 5 : null,
      backfillComplete: enabled,
      domainScopeRefused: ["gmail.com"],
    })),
    decide: vi.fn<MailSenderScreenService["decide"]>(async () => ({
      apiVersion: 1 as const,
      decisionId: DECISION_ID,
      archived: [{ accountId: ACCOUNT_ID, threadId: "thread_1" }],
      pending: false,
    })),
    undo: vi.fn<MailSenderScreenService["undo"]>(async () => ({
      apiVersion: 1 as const,
      restored: [],
      pending: false,
    })),
    listBlocked: vi.fn<MailSenderScreenService["listBlocked"]>(async () => ({
      apiVersion: 1 as const,
      blocked: [
        {
          decisionId: DECISION_ID,
          key: "growth.test",
          scope: "domain" as const,
          decidedAt: 9,
          archivedCount: 2,
        },
      ],
    })),
  } satisfies MailSenderScreenService;
}

async function startServer(senders: MailSenderScreenService | undefined): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-http-senders-"));
  const socketPath = path.join(root, "mail.sock");
  const server = createMailServiceHttpServer({
    build: { commit: "dev", builtAt: "dev" },
    senders,
  });
  running.push({ server, root });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return socketPath;
}

function errorCode(body: unknown): unknown {
  return (body as { error?: { code?: unknown } } | null)?.error?.code;
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
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }),
          ...extraHeaders,
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
