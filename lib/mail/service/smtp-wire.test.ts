import net from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import type { MailEnvelope, MailTlsMode } from "../ports";
import {
  FakeSmtpServer,
  SMTP_TEST_CA_CERT,
  type FakeSmtpServerOptions,
} from "../testing/smtp-fixtures";
import { submitSmtpMessage } from "./smtp-wire";

const RAW_MESSAGE = Buffer.from(
  "From: me@test.local\r\nTo: friend@example.net\r\nSubject: hi\r\n\r\nBody line\r\n.leading dot line\r\n",
  "utf8",
);

const servers: FakeSmtpServer[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(
  options: FakeSmtpServerOptions,
): Promise<FakeSmtpServer> {
  const server = await FakeSmtpServer.start(options);
  servers.push(server);
  return server;
}

function envelope(recipients: readonly string[] = ["friend@example.net"]): MailEnvelope {
  return Object.freeze({
    from: "me@test.local",
    to: Object.freeze([...recipients]),
    cc: Object.freeze([]),
    bcc: Object.freeze([]),
  });
}

async function runSubmission(
  server: FakeSmtpServer,
  input: {
    readonly tls: MailTlsMode;
    readonly recipients?: readonly string[];
    readonly deadlineMs?: number;
    readonly failBarrier?: boolean;
  },
) {
  const socket = net.connect(server.port, "127.0.0.1");
  sockets.push(socket);
  await once(socket, "connect");
  const deadlineAt = Date.now() + (input.deadlineMs ?? 4_000);
  let beforeDataCalls = 0;
  const outcome = await submitSmtpMessage(
    {
      connection: socket,
      tls: input.tls,
      servername: "smtp.test.local",
      username: "user@test.local",
      password: Buffer.from("swordfish", "utf8"),
      deadlineAt,
      trustedRootCertificates: [SMTP_TEST_CA_CERT],
    },
    { envelope: envelope(input.recipients), raw: RAW_MESSAGE },
    {
      deadlineAt,
      beforeData: async () => {
        beforeDataCalls += 1;
        if (input.failBarrier) throw new Error("barrier lost");
      },
    },
  );
  return { outcome, beforeDataCalls };
}

describe("first-party SMTP wire client", () => {
  it("submits over implicit TLS with dot-stuffed DATA behind the barrier", async () => {
    const server = await startServer({ mode: "implicit" });
    const { outcome, beforeDataCalls } = await runSubmission(server, {
      tls: "implicit",
    });

    expect(outcome).toEqual({
      kind: "accepted",
      responseCode: 250,
      acceptedRecipients: ["friend@example.net"],
      rejectedRecipients: [],
    });
    expect(beforeDataCalls).toBe(1);
    expect(server.sawAuthBeforeTls).toBe(false);
    expect(server.authLines).toHaveLength(1);
    expect(server.authLines[0]).toMatch(/^AUTH PLAIN /);
    const payload = server.dataPayload?.toString("utf8") ?? "";
    expect(payload).toContain("Body line\r\n");
    expect(payload).toContain("\r\n..leading dot line\r\n");
    expect(server.commands).toContain("QUIT");
  });

  it("upgrades through STARTTLS and authenticates only inside TLS", async () => {
    const server = await startServer({ mode: "starttls" });
    const { outcome } = await runSubmission(server, { tls: "starttls" });

    expect(outcome.kind).toBe("accepted");
    expect(server.commands).toContain("STARTTLS");
    expect(server.sawAuthBeforeTls).toBe(false);
    expect(server.authLines).toHaveLength(1);
  });

  it("rejects a STARTTLS downgrade before any credential leaves the process", async () => {
    const server = await startServer({ mode: "starttls-unavailable" });
    const { outcome } = await runSubmission(server, { tls: "starttls" });

    expect(outcome).toEqual({
      kind: "transport_error",
      deliveryRisk: "none",
      errorCode: "smtp_starttls_unavailable",
    });
    expect(server.authLines).toHaveLength(0);
    expect(server.commands).not.toContain("STARTTLS");
  });

  it("fails certificate validation for a wrong-hostname leaf without sending auth", async () => {
    const server = await startServer({
      mode: "implicit",
      certificate: "wrong_hostname",
    });
    const { outcome, beforeDataCalls } = await runSubmission(server, {
      tls: "implicit",
    });

    expect(outcome).toEqual({
      kind: "transport_error",
      deliveryRisk: "none",
      errorCode: "smtp_tls_failed",
    });
    expect(beforeDataCalls).toBe(0);
    expect(server.authLines).toHaveLength(0);
  });

  it("classifies authentication failure as permanent and never reaches MAIL", async () => {
    const server = await startServer({ mode: "implicit", authCode: 535 });
    const { outcome } = await runSubmission(server, { tls: "implicit" });

    expect(outcome).toEqual({
      kind: "rejected",
      responseCode: 535,
      retryable: false,
      errorCode: "smtp_auth_failed",
    });
    expect(
      server.commands.some((command) => command.startsWith("MAIL")),
    ).toBe(false);
  });

  it("classifies a transient authentication rejection as retryable", async () => {
    const server = await startServer({ mode: "implicit", authCode: 454 });
    const { outcome } = await runSubmission(server, { tls: "implicit" });

    expect(outcome).toEqual({
      kind: "rejected",
      responseCode: 454,
      retryable: true,
      errorCode: "smtp_auth_deferred",
    });
  });

  it("classifies sender rejections by response class", async () => {
    const transient = await startServer({ mode: "implicit", mailFromCode: 451 });
    const permanent = await startServer({ mode: "implicit", mailFromCode: 550 });

    await expect(
      runSubmission(transient, { tls: "implicit" }),
    ).resolves.toMatchObject({
      outcome: {
        kind: "rejected",
        responseCode: 451,
        retryable: true,
        errorCode: "smtp_sender_deferred",
      },
    });
    await expect(
      runSubmission(permanent, { tls: "implicit" }),
    ).resolves.toMatchObject({
      outcome: {
        kind: "rejected",
        responseCode: 550,
        retryable: false,
        errorCode: "smtp_sender_rejected",
      },
    });
  });

  it("partitions recipients and still delivers to the accepted subset", async () => {
    const server = await startServer({
      mode: "implicit",
      rcptCodes: { "rejected@example.net": 550 },
    });
    const { outcome, beforeDataCalls } = await runSubmission(server, {
      tls: "implicit",
      recipients: ["friend@example.net", "rejected@example.net"],
    });

    expect(outcome).toEqual({
      kind: "accepted",
      responseCode: 250,
      acceptedRecipients: ["friend@example.net"],
      rejectedRecipients: [
        {
          address: "rejected@example.net",
          responseCode: 550,
          retryable: false,
          errorCode: "smtp_recipient_rejected",
        },
      ],
    });
    expect(beforeDataCalls).toBe(1);
  });

  it("returns a whole-envelope rejection when every recipient is refused", async () => {
    const transient = await startServer({
      mode: "implicit",
      rcptCodes: { "friend@example.net": 450 },
    });
    const permanent = await startServer({
      mode: "implicit",
      rcptCodes: { "friend@example.net": 550 },
    });

    await expect(
      runSubmission(transient, { tls: "implicit" }),
    ).resolves.toMatchObject({
      outcome: {
        kind: "rejected",
        responseCode: 450,
        retryable: true,
        errorCode: "smtp_recipients_deferred",
      },
      beforeDataCalls: 0,
    });
    await expect(
      runSubmission(permanent, { tls: "implicit" }),
    ).resolves.toMatchObject({
      outcome: {
        kind: "rejected",
        responseCode: 550,
        retryable: false,
        errorCode: "smtp_recipients_rejected",
      },
      beforeDataCalls: 0,
    });
  });

  it("marks a silent post-DATA server as ambiguous delivery risk", async () => {
    const server = await startServer({
      mode: "implicit",
      finalBehavior: "silence",
    });
    const { outcome, beforeDataCalls } = await runSubmission(server, {
      tls: "implicit",
      deadlineMs: 1_500,
    });

    expect(outcome).toEqual({
      kind: "transport_error",
      deliveryRisk: "possible",
      errorCode: "smtp_connection_timeout",
    });
    expect(beforeDataCalls).toBe(1);
  });

  it("marks a connection lost after DATA as ambiguous delivery risk", async () => {
    const server = await startServer({
      mode: "implicit",
      finalBehavior: "close",
    });
    const { outcome } = await runSubmission(server, { tls: "implicit" });

    expect(outcome).toEqual({
      kind: "transport_error",
      deliveryRisk: "possible",
      errorCode: "smtp_connection_closed",
    });
  });

  it("treats a definite final-dot error reply as definite non-delivery", async () => {
    const transient = await startServer({
      mode: "implicit",
      finalBehavior: 452,
    });
    const permanent = await startServer({
      mode: "implicit",
      finalBehavior: 552,
    });

    await expect(
      runSubmission(transient, { tls: "implicit" }),
    ).resolves.toMatchObject({
      outcome: {
        kind: "rejected",
        responseCode: 452,
        retryable: true,
        errorCode: "smtp_message_deferred",
      },
    });
    await expect(
      runSubmission(permanent, { tls: "implicit" }),
    ).resolves.toMatchObject({
      outcome: {
        kind: "rejected",
        responseCode: 552,
        retryable: false,
        errorCode: "smtp_message_rejected",
      },
    });
  });

  it("aborts without sending DATA bytes when the durable barrier fails", async () => {
    const server = await startServer({ mode: "implicit" });
    await expect(
      runSubmission(server, { tls: "implicit", failBarrier: true }),
    ).rejects.toThrow(/barrier lost/);
    expect(server.dataPayload).toBeNull();
  });
});
