import { EventEmitter, once } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type {
  SmtpEgressTunnelOpenRequest,
  ValidatedMailDialTarget,
} from "../ports";
import { validateResolvedMailTargets } from "../security";
import { FakeSmtpServer, SMTP_TEST_CA_CERT } from "../testing/smtp-fixtures";
import {
  DirectSmtpConnectionFactory,
  FirstPartySmtpCredentialVerifier,
  FirstPartySmtpSubmissionTransport,
  type MailSmtpByteConnection,
} from "./smtp-transport";
import type { MailSmtpSubmissionAttempt } from "./smtp-worker";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const PUBLIC_ADDRESS = "93.184.216.34";
const SECOND_PUBLIC_ADDRESS = "93.184.216.35";

const servers: FakeSmtpServer[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function validatedTargets(
  addresses: readonly string[],
  now = NOW,
): readonly ValidatedMailDialTarget[] {
  return validateResolvedMailTargets(
    "smtp",
    { hostname: "smtp.test.local", port: 465, tls: "implicit" },
    {
      resolutionId: "dns-r1",
      resolvedAt: now,
      expiresAt: now + 60_000,
      addresses: addresses.map((address) => ({ address, family: 4 as const })),
    },
    now,
  );
}

function openRequest(
  target: ValidatedMailDialTarget,
  now = NOW,
): SmtpEgressTunnelOpenRequest {
  return Object.freeze({
    transport: "direct" as const,
    sessionId: "smtp-s-test",
    attemptId: "attempt-test",
    target,
    deadlineAt: now + 30_000,
  });
}

class FakeDirectSocket extends EventEmitter {
  destroyed = false;
  remoteAddress: string | undefined;

  setNoDelay(): this {
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

describe("direct SMTP connection factory", () => {
  it("dials the pinned literal address and verifies the observed peer", async () => {
    const target = validatedTargets([PUBLIC_ADDRESS])[0]!;
    const dialed: Array<{ host: string; port: number; family: 4 | 6 }> = [];
    const socket = new FakeDirectSocket();
    socket.remoteAddress = PUBLIC_ADDRESS;
    const factory = new DirectSmtpConnectionFactory({
      now: () => NOW,
      createConnection: (options) => {
        dialed.push(options);
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as net.Socket;
      },
    });

    const connection = await factory.open(openRequest(target));
    expect(dialed).toEqual([
      { host: PUBLIC_ADDRESS, port: 465, family: 4 },
    ]);
    expect(connection.stream).toBe(socket);
    await connection.close();
    expect(socket.destroyed).toBe(true);
  });

  it("destroys a connection whose observed peer differs from the target", async () => {
    const target = validatedTargets([PUBLIC_ADDRESS])[0]!;
    const socket = new FakeDirectSocket();
    socket.remoteAddress = "198.51.100.99";
    const factory = new DirectSmtpConnectionFactory({
      now: () => NOW,
      createConnection: () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as net.Socket;
      },
    });

    await expect(factory.open(openRequest(target))).rejects.toThrow(
      /peer does not match/,
    );
    expect(socket.destroyed).toBe(true);
  });

  it("refuses loopback targets before any socket is created", () => {
    expect(() => validatedTargets(["127.0.0.1"])).toThrow(
      /forbidden address/,
    );
  });
});

describe("first-party SMTP submission transport", () => {
  it("advances past a dead target and submits through the next one", async () => {
    const server = await FakeSmtpServer.start({ mode: "implicit" });
    servers.push(server);
    const targets = validatedTargets(
      [PUBLIC_ADDRESS, SECOND_PUBLIC_ADDRESS],
      Date.now(),
    );
    const opened: string[] = [];
    const password = Buffer.from("swordfish", "utf8");
    const transport = new FirstPartySmtpSubmissionTransport({
      dns: {
        async resolve() {
          return targets;
        },
      },
      connections: {
        async open(
          request: SmtpEgressTunnelOpenRequest,
        ): Promise<MailSmtpByteConnection> {
          opened.push(request.target.address);
          if (request.target.address === PUBLIC_ADDRESS) {
            throw new Error("connect refused");
          }
          const socket = net.connect(server.port, "127.0.0.1");
          sockets.push(socket);
          await once(socket, "connect");
          return Object.freeze({
            stream: socket,
            close: async () => {
              socket.destroy();
            },
          });
        },
      },
      access: {
        async resolveSmtpAccess() {
          return Object.freeze({
            endpoint: Object.freeze({
              hostname: "smtp.test.local",
              port: 465,
              tls: "implicit" as const,
            }),
            username: "user@test.local",
            readPassword: async () => password,
          });
        },
      },
      transportKind: "direct",
      trustedRootCertificates: [SMTP_TEST_CA_CERT],
    });

    const attempt: MailSmtpSubmissionAttempt = Object.freeze({
      accountId: `account-a${"9".repeat(32)}`,
      operationId: "send-00000000-0000-4000-8000-000000000901",
      attemptId: "attempt-00000000-0000-4000-8000-000000000901",
      messageId: "<brain.transport.1@test.local>",
      envelope: Object.freeze({
        from: "me@test.local",
        to: Object.freeze(["friend@example.net"]),
        cc: Object.freeze([]),
        bcc: Object.freeze([]),
      }),
      raw: Buffer.from("From: me@test.local\r\n\r\nHi\r\n", "utf8"),
      deadlineAt: Date.now() + 20_000,
      signal: new AbortController().signal,
    });
    let barrierRuns = 0;
    const outcome = await transport.submit(attempt, {
      deadlineAt: attempt.deadlineAt,
      beforeData: async () => {
        barrierRuns += 1;
      },
    });

    expect(outcome).toMatchObject({ kind: "accepted", responseCode: 250 });
    expect(opened).toEqual([PUBLIC_ADDRESS, SECOND_PUBLIC_ADDRESS]);
    expect(barrierRuns).toBe(1);
    // The transport wipes the secret bytes after the submission settles.
    expect(password.every((byte) => byte === 0)).toBe(true);
  });

  it("keeps Bcc recipients in RCPT but removes their header from DATA", async () => {
    const server = await FakeSmtpServer.start({ mode: "implicit" });
    servers.push(server);
    const password = Buffer.from("swordfish", "utf8");
    const transport = new FirstPartySmtpSubmissionTransport({
      dns: {
        async resolve() {
          return validatedTargets([PUBLIC_ADDRESS], Date.now());
        },
      },
      connections: {
        async open(): Promise<MailSmtpByteConnection> {
          const socket = net.connect(server.port, "127.0.0.1");
          sockets.push(socket);
          await once(socket, "connect");
          return Object.freeze({
            stream: socket,
            close: async () => {
              socket.destroy();
            },
          });
        },
      },
      access: {
        async resolveSmtpAccess() {
          return Object.freeze({
            endpoint: Object.freeze({
              hostname: "smtp.test.local",
              port: 465,
              tls: "implicit" as const,
            }),
            username: "user@test.local",
            readPassword: async () => password,
          });
        },
      },
      transportKind: "direct",
      trustedRootCertificates: [SMTP_TEST_CA_CERT],
    });
    const raw = Buffer.from(
      "From: me@test.local\r\nTo: friend@example.net\r\nBcc: private@example.org\r\nSubject: private\r\n\r\nBody\r\n",
      "utf8",
    );
    const attempt: MailSmtpSubmissionAttempt = Object.freeze({
      accountId: `account-a${"8".repeat(32)}`,
      operationId: "send-00000000-0000-4000-8000-000000000902",
      attemptId: "attempt-00000000-0000-4000-8000-000000000902",
      messageId: "<brain.transport.2@test.local>",
      envelope: Object.freeze({
        from: "me@test.local",
        to: Object.freeze(["friend@example.net"]),
        cc: Object.freeze([]),
        bcc: Object.freeze(["private@example.org"]),
      }),
      raw,
      deadlineAt: Date.now() + 20_000,
      signal: new AbortController().signal,
    });

    await expect(
      transport.submit(attempt, {
        deadlineAt: attempt.deadlineAt,
        beforeData: async () => undefined,
      }),
    ).resolves.toMatchObject({ kind: "accepted" });
    expect(server.commands).toContain("RCPT TO:<friend@example.net>");
    expect(server.commands).toContain("RCPT TO:<private@example.org>");
    expect(server.dataPayload?.toString("utf8") ?? "").not.toMatch(
      /(?:^|\r\n)Bcc:/i,
    );
    expect(raw.toString("utf8")).toContain("Bcc: private@example.org\r\n");
    raw.fill(0);
  });
});

describe("first-party SMTP credential verifier", () => {
  it("authenticates through TLS and quits before MAIL FROM", async () => {
    const server = await FakeSmtpServer.start({ mode: "implicit" });
    servers.push(server);
    const password = Buffer.from("swordfish", "utf8");
    const verifier = new FirstPartySmtpCredentialVerifier({
      dns: {
        async resolve() {
          return validatedTargets([PUBLIC_ADDRESS], Date.now());
        },
      },
      connections: {
        async open(): Promise<MailSmtpByteConnection> {
          const socket = net.connect(server.port, "127.0.0.1");
          sockets.push(socket);
          await once(socket, "connect");
          return Object.freeze({
            stream: socket,
            close: async () => {
              socket.destroy();
            },
          });
        },
      },
      transportKind: "direct",
      trustedRootCertificates: [SMTP_TEST_CA_CERT],
    });

    await verifier.verify({
      endpoint: {
        hostname: "smtp.test.local",
        port: 465,
        tls: "implicit",
      },
      username: "user@test.local",
      password,
      deadlineAt: Date.now() + 20_000,
      signal: new AbortController().signal,
    });

    expect(server.commands.some((line) => line.startsWith("AUTH "))).toBe(true);
    expect(server.commands).not.toContain("MAIL FROM:<user@test.local>");
    expect(server.commands).not.toContain("DATA");
    expect(server.dataPayload).toBeNull();
    expect(password.toString("utf8")).toBe("swordfish");
    password.fill(0);
  });

  it("maps rejected AUTH to a setup error without trying to send", async () => {
    const server = await FakeSmtpServer.start({
      mode: "implicit",
      authCode: 535,
    });
    servers.push(server);
    const verifier = new FirstPartySmtpCredentialVerifier({
      dns: {
        async resolve() {
          return validatedTargets([PUBLIC_ADDRESS], Date.now());
        },
      },
      connections: {
        async open(): Promise<MailSmtpByteConnection> {
          const socket = net.connect(server.port, "127.0.0.1");
          sockets.push(socket);
          await once(socket, "connect");
          return Object.freeze({
            stream: socket,
            close: async () => {
              socket.destroy();
            },
          });
        },
      },
      transportKind: "direct",
      trustedRootCertificates: [SMTP_TEST_CA_CERT],
    });
    const password = Buffer.from("wrong-password", "utf8");

    await expect(
      verifier.verify({
        endpoint: {
          hostname: "smtp.test.local",
          port: 465,
          tls: "implicit",
        },
        username: "user@test.local",
        password,
        deadlineAt: Date.now() + 20_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "smtp_authentication_failed" });
    expect(server.commands.some((line) => line.startsWith("AUTH "))).toBe(true);
    expect(server.commands).not.toContain("DATA");
    password.fill(0);
  });
});
