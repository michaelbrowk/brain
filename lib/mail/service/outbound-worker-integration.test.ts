import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
});

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
      rawRfc2822Base64Url: raw.toString("base64url"),
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
