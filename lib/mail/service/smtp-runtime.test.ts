import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailDnsResolverPort } from "../ports";
import { validateResolvedMailTargets } from "../security";
import type { SqliteMailAccountStore } from "./account-store";
import type { StoredImapMailAccount } from "./account-types";
import type { StoredMailSendSubmission } from "./outbound";
import { SqliteMailSendStore } from "./outbound-store";
import { createOptionalProductionSmtpRuntime } from "./smtp-runtime";
import { MailSmtpSubmissionWorker } from "./smtp-worker";

const PUBLIC_ADDRESS = "93.184.216.34";
const ACCOUNT = `account-a${"7".repeat(32)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * The account store is read only through `StoredMailProtocolAccessResolver`,
 * which needs one connected IMAP account with an outgoing server and its
 * password, and through `markAccountReauthRequired` on a definite auth
 * failure. That is the whole surface a worker pass touches, so the stand-in
 * has exactly those three members rather than a SQLite file.
 */
function connectedAccountStore(): SqliteMailAccountStore {
  const stored: StoredImapMailAccount = {
    account: {
      accountId: ACCOUNT,
      emailAddress: "person@example.test",
      endpoint: { hostname: "imap.example.test", port: 993, tls: "implicit" },
      username: "person@example.test",
      credentialRef: { id: `credential-r${"2".repeat(32)}`, version: 1 },
      transportBindingRef: { id: `binding-r${"3".repeat(32)}`, version: 1 },
      smtp: {
        endpoint: { hostname: "smtp.example.test", port: 465, tls: "implicit" },
        username: "person@example.test",
        credentialRef: { id: `credential-r${"2".repeat(32)}`, version: 1 },
        transportBindingRef: { id: `binding-r${"9".repeat(32)}`, version: 1 },
      },
      connectedAt: 1,
    },
    providerKind: "imap",
    displayName: null,
    status: "connected",
    createdAt: 1_000,
    updatedAt: 1_000,
  };
  const store = {
    readAccount: async () => stored,
    loadProvisionedAccount: async () => ({
      stored,
      password: Buffer.from("test-only-password", "utf8"),
    }),
    markAccountReauthRequired: async () => undefined,
  };
  return store as unknown as SqliteMailAccountStore;
}

/** A real outbox with one queued IMAP-provider message, ready for a pass. */
async function queuedOutbox(): Promise<SqliteMailSendStore> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-smtp-runtime-"));
  roots.push(root);
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot, { mode: 0o700 });
  const store = new SqliteMailSendStore({ cacheRoot });
  await store.initialize();
  const raw = Buffer.from(
    "From: person@example.test\r\nTo: friend@example.net\r\n\r\nRuntime body\r\n",
    "utf8",
  );
  // ONE READING OF THE CLOCK. A message that has never been attempted carries
  // one moment three times, and the store refuses a first-party row whose
  // three differ (`createInitialSmtpState`). Read three times, the clock gave
  // three values whenever a millisecond ended between two of the reads, which
  // a busy machine makes likely and an idle one only rare, and the enqueue
  // answered `mail_send_service_unavailable` for a fixture that was wrong.
  const queuedAt = Date.now() - 1_000;
  const submission: StoredMailSendSubmission = Object.freeze({
    version: 0,
    operationId: "send-00000000-0000-4000-8000-000000000901",
    idempotencyKey: "smtp-runtime-op-1",
    requestFingerprint: "e".repeat(64),
    accountId: ACCOUNT,
    providerKind: "imap" as const,
    status: "queued" as const,
    attemptCount: 0,
    lease: null,
    message: Object.freeze({
      messageId: "<brain.runtime.1@example.test>",
      envelope: Object.freeze({
        from: "person@example.test",
        to: Object.freeze(["friend@example.net"]),
        cc: Object.freeze([]),
        bcc: Object.freeze([]),
      }),
      providerThreadId: null,
      rawRfc2822: raw,
      rawRfc2822Bytes: raw.byteLength,
      rawRfc2822Sha256: createHash("sha256").update(raw).digest("hex"),
    }),
    providerMessageId: null,
    providerThreadId: null,
    lastErrorCode: null,
    nextAttemptAt: queuedAt,
    createdAt: queuedAt,
    updatedAt: queuedAt,
  });
  await store.enqueue(submission);
  return store;
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

function pinnedDns(): MailDnsResolverPort {
  return {
    async resolve(protocol, endpoint) {
      const now = Date.now();
      return validateResolvedMailTargets(
        protocol,
        endpoint,
        {
          resolutionId: "dns-r1",
          resolvedAt: now,
          expiresAt: now + 60_000,
          addresses: [{ address: PUBLIC_ADDRESS, family: 4 as const }],
        },
        now,
      );
    },
  };
}

describe("production SMTP runtime composition", () => {
  it("stays absent when no transport flag is set", async () => {
    await expect(
      createOptionalProductionSmtpRuntime({
        environment: {},
        accountStore: connectedAccountStore(),
        outboxStore: {} as SqliteMailSendStore,
        dns: pinnedDns(),
        onEvent: () => undefined,
      }),
    ).resolves.toBeNull();
  });

  it("dials the provider itself when direct submission is enabled", async () => {
    const dialed: Array<{ host: string; port: number; family: 4 | 6 }> = [];
    const createConnection = vi.fn((options: {
      readonly host: string;
      readonly port: number;
      readonly family: 4 | 6;
    }) => {
      dialed.push({ ...options });
      const socket = new FakeDirectSocket();
      queueMicrotask(() => socket.emit("error", new Error("refused")));
      return socket as unknown as net.Socket;
    });
    const outboxStore = await queuedOutbox();
    const runtime = await createOptionalProductionSmtpRuntime({
      environment: { BRAIN_MAIL_SMTP_DIRECT_ENABLED: "1" },
      accountStore: connectedAccountStore(),
      outboxStore,
      dns: pinnedDns(),
      onEvent: () => undefined,
      createConnection,
    });

    expect(runtime).not.toBeNull();
    if (runtime === null) throw new Error("expected a runtime");
    expect(runtime.transport).toBe("direct");
    expect(runtime.worker).toBeInstanceOf(MailSmtpSubmissionWorker);
    // The verifier reaches the injected dialer with the validated literal
    // address, which is only possible through the direct factory: the relay
    // factory would open a WebSocket to a URL that was never configured.
    await expect(
      runtime.verifier.verify({
        endpoint: { hostname: "smtp.example.test", port: 465, tls: "implicit" },
        username: "person@example.test",
        password: Buffer.from("test-only-password", "utf8"),
        deadlineAt: Date.now() + 5_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "smtp_connection_failed" });
    expect(dialed).toEqual([{ host: PUBLIC_ADDRESS, port: 465, family: 4 }]);

    // The worker's transport is composed separately from the verifier and
    // must name the same kind: the direct factory refuses an open request
    // labelled for the relay before it dials, so a pass over the queued
    // message reaches the dialer only if the worker side says "direct" too.
    await runtime.worker.runNow();
    expect(dialed).toEqual([
      { host: PUBLIC_ADDRESS, port: 465, family: 4 },
      { host: PUBLIC_ADDRESS, port: 465, family: 4 },
    ]);
    await outboxStore.close();
  });
});
