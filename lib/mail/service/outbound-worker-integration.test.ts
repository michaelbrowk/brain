import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MAIL_RESOURCE_LIMITS } from "../security";
import { MAIL_SEND_ATTACHMENT_LIMITS } from "../send-attachment-codec";
import type { MailSendProvider } from "./outbound";
import {
  ProviderNeutralMailSendService,
  type StoredMailSendSubmission,
} from "./outbound";
import { SqliteMailSendStore } from "./outbound-store";
import { MailOutboundWorker } from "./outbound-worker";

const ACCOUNT_ID = `account-a${"1".repeat(32)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable mail outbound worker integration", () => {
  it("drains a reopened SQLite queue without repeating a risky delivery", async () => {
    const now = Date.parse("2026-07-20T00:00:00.000Z");
    const root = await mkdtemp(path.join(tmpdir(), "brain-mail-worker-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { mode: 0o700 });

    const queued = submission(1, {
      nextAttemptAt: now - 3_000,
      createdAt: now - 3_000,
      updatedAt: now - 3_000,
    });
    const expiredSafe = submission(2, {
      status: "sending",
      attemptCount: 1,
      lease: {
        attemptId: "attempt-00000000-0000-4000-8000-000000000002",
        expiresAt: now - 2_000,
        deliveryRisk: false,
      },
      nextAttemptAt: null,
      createdAt: now - 4_000,
      updatedAt: now - 4_000,
    });
    const expiredRisk = submission(3, {
      status: "sending",
      attemptCount: 1,
      lease: {
        attemptId: "attempt-00000000-0000-4000-8000-000000000003",
        expiresAt: now - 1_000,
        deliveryRisk: true,
      },
      nextAttemptAt: null,
      createdAt: now - 5_000,
      updatedAt: now - 5_000,
    });

    const initial = new SqliteMailSendStore({ cacheRoot, now: () => now });
    await initial.initialize();
    await initial.enqueue(queued);
    await initial.enqueue(expiredSafe);
    await initial.enqueue(expiredRisk);
    await initial.close();

    const reopened = new SqliteMailSendStore({ cacheRoot, now: () => now });
    await reopened.initialize();
    const providerCalls: string[] = [];
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (message, hooks) => {
        providerCalls.push(message.operationId);
        await hooks.beforeDelivery();
        const suffix = message.operationId.slice(-12);
        return {
          kind: "accepted",
          providerMessageId: `gmail-message-${suffix}`,
          providerThreadId: `gmail-thread-${suffix}`,
        } as const;
      }),
    };
    const service = new ProviderNeutralMailSendService({
      store: reopened,
      accounts: {
        readSendAccount: async () => ({
          accountId: ACCOUNT_ID,
          providerKind: "gmail",
          emailAddress: "me@example.com",
          status: "connected",
        }),
      },
      replies: { resolveReplyContext: async () => null },
      providers: [provider],
      now: () => now,
    });
    const worker = new MailOutboundWorker({
      store: reopened,
      processor: service,
      now: () => now,
      batchSize: 10,
    });

    await worker.runNow();

    expect(providerCalls).toEqual([queued.operationId, expiredSafe.operationId]);
    await expect(reopened.readByOperationId(queued.operationId)).resolves.toMatchObject({
      status: "sent",
    });
    await expect(
      reopened.readByOperationId(expiredSafe.operationId),
    ).resolves.toMatchObject({ status: "sent" });
    await expect(
      reopened.readByOperationId(expiredRisk.operationId),
    ).resolves.toMatchObject({ status: "delivery_unknown" });

    await worker.stop();
    await reopened.close();
  });

  /** THE WHOLE PATH AT THE CAP, ON A REAL DATABASE.
   *
   *  A send carrying `MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes` of files, from
   *  the request a client posts through `validateMailSendInput`, the MIME
   *  build, the row, and back out of the row to the provider. Everything else
   *  in this file and most of the store's own tests run on a 53-byte body,
   *  which is how an attachment cap the store would not hold shipped once
   *  already. What this pins is that the bytes the provider is handed are the
   *  bytes the sender sent, after a round trip through a BLOB column. */
  it("carries a send at the attachment cap from the request to the provider", async () => {
    const now = Date.parse("2026-07-20T00:00:00.000Z");
    const root = await mkdtemp(path.join(tmpdir(), "brain-mail-cap-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { mode: 0o700 });

    const payload = Buffer.alloc(MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes, 7);
    const store = new SqliteMailSendStore({ cacheRoot, now: () => now });
    await store.initialize();
    let delivered: Buffer | null = null;
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (message, hooks) => {
        delivered = message.rawRfc2822;
        await hooks.beforeDelivery();
        return {
          kind: "accepted",
          providerMessageId: "gmail-message-cap",
          providerThreadId: "gmail-thread-cap",
        } as const;
      }),
    };
    const service = new ProviderNeutralMailSendService({
      store,
      accounts: {
        readSendAccount: async () => ({
          accountId: ACCOUNT_ID,
          providerKind: "gmail",
          emailAddress: "me@example.com",
          status: "connected",
        }),
      },
      replies: { resolveReplyContext: async () => null },
      providers: [provider],
      now: () => now,
      createOperationId: () => operationId(9),
    });

    const sent = await service.send(
      {
        accountId: ACCOUNT_ID,
        idempotencyKey: "send-at-the-cap",
        mode: "compose",
        to: ["friend@example.net"],
        cc: [],
        bcc: [],
        subject: "At the cap",
        text: "One line of body beside the file.\n",
        replyToMessageId: null,
        attachments: [
          {
            filename: "payload.bin",
            mimeType: "application/octet-stream",
            dataBase64: payload.toString("base64"),
          },
        ],
        origin: "app",
        agentLine: false,
      },
      requestContext(),
    );
    expect(sent).toMatchObject({ created: true, status: "sent" });

    const message: Buffer | null = delivered;
    expect(message).not.toBeNull();
    expect(message!.byteLength).toBeGreaterThan(payload.byteLength);
    expect(message!.byteLength).toBeLessThanOrEqual(
      MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes,
    );
    // The file came back out of the row as the file that went in: the first
    // wrapped line of its base64 is in the message the provider was handed.
    expect(
      message!.includes(
        Buffer.from(payload.toString("base64").slice(0, 76), "ascii"),
      ),
    ).toBe(true);
    const stored = await store.readByOperationId(sent.operationId);
    expect(stored?.message.rawRfc2822.equals(message!)).toBe(true);
    expect(createHash("sha256").update(message!).digest("hex")).toBe(
      stored?.message.rawRfc2822Sha256,
    );
    await store.close();
  });
});

function requestContext() {
  return {
    deadlineAt: Number.MAX_SAFE_INTEGER,
    signal: new AbortController().signal,
  };
}

function submission(
  index: number,
  override: Partial<StoredMailSendSubmission>,
): StoredMailSendSubmission {
  const raw = Buffer.from(
    `From: me@example.com\r\nTo: friend@example.net\r\nMessage-ID: <message-${index}@brain.local>\r\n\r\nBody\r\n`,
    "utf8",
  );
  return Object.freeze({
    version: 0,
    operationId: operationId(index),
    idempotencyKey: `worker-restart-${index}`,
    requestFingerprint: String(index).repeat(64).slice(0, 64),
    accountId: ACCOUNT_ID,
    providerKind: "gmail",
    status: "queued",
    attemptCount: 0,
    lease: null,
    message: Object.freeze({
      messageId: `<message-${index}@brain.local>`,
      envelope: Object.freeze({
        from: "me@example.com",
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
    nextAttemptAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...override,
  });
}

function operationId(index: number): string {
  return `send-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
