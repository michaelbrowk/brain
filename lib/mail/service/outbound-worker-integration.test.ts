import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

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

  /** ONE MESSAGE RESIDENT, WHATEVER THE BACKLOG.
   *
   *  The worker takes a batch of twenty by default and delivers them one at a
   *  time, so the batch read is where a backlog becomes memory: twenty messages
   *  at the attachment cap is 219 MiB of message, against `MemoryMax=256M`. The
   *  listing carries identities and nothing else, and the message is read at the
   *  moment it is delivered, so what the pass holds is one message however deep
   *  the queue is. Measured separately by
   *  `scripts/mail-outbox-memory-probe.mjs --drain`; what this pins is the shape
   *  that makes the measurement true. */
  it("drains a backlog one message at a time, never a batch of them", async () => {
    const now = Date.parse("2026-07-20T00:00:00.000Z");
    const root = await mkdtemp(path.join(tmpdir(), "brain-mail-drain-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { mode: 0o700 });

    const store = new SqliteMailSendStore({ cacheRoot, now: () => now });
    await store.initialize();
    const queued = [11, 12, 13, 14].map((index) =>
      submission(index, {
        nextAttemptAt: now - 1_000,
        createdAt: now - 1_000,
        updatedAt: now - 1_000,
      }),
    );
    for (const value of queued) await store.enqueue(value);

    const events: string[] = [];
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (message, hooks) => {
        events.push(`send ${message.operationId.slice(-2)}`);
        await hooks.beforeDelivery();
        return {
          kind: "accepted",
          providerMessageId: `gmail-message-${message.operationId.slice(-2)}`,
          providerThreadId: `gmail-thread-${message.operationId.slice(-2)}`,
        } as const;
      }),
    };
    // The store as the worker sees it, recording what it is handed: a listing
    // that carries a message would be a batch of them.
    const recording = new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "listRunnable" && typeof value === "function") {
          return async (...args: [number, number]) => {
            const listed = await target.listRunnable(...args);
            for (const entry of listed) {
              expect(Object.keys(entry).sort()).toEqual([
                "accountId",
                "operationId",
              ]);
            }
            return listed;
          };
        }
        if (property === "readByOperationId" && typeof value === "function") {
          return async (operationId: string) => {
            const read = await target.readByOperationId(operationId);
            if (read !== null) events.push(`read ${operationId.slice(-2)}`);
            return read;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new ProviderNeutralMailSendService({
      store: recording,
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
      store: recording,
      processor: service,
      now: () => now,
      batchSize: 20,
    });

    await worker.runNow();

    // Read, send, read, send: each message is read for its own delivery and
    // none of them before the pass needs it.
    expect(events).toEqual([
      "read 11",
      "send 11",
      "read 12",
      "send 12",
      "read 13",
      "send 13",
      "read 14",
      "send 14",
    ]);
    await worker.stop();
    await store.close();
  });

  /** The same property one layer down: the statement the listing prepares does
   *  not name the message column at all. */
  it("prepares no statement that reads a message while it lists work", async () => {
    const now = Date.parse("2026-07-20T00:00:00.000Z");
    const root = await mkdtemp(path.join(tmpdir(), "brain-mail-listing-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { mode: 0o700 });

    const store = new SqliteMailSendStore({ cacheRoot, now: () => now });
    await store.initialize();
    await store.enqueue(
      submission(21, {
        nextAttemptAt: now - 1_000,
        createdAt: now - 1_000,
        updatedAt: now - 1_000,
      }),
    );

    const prepared: string[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        prepared.push(sql);
        return prepare.call(this, sql);
      });
    try {
      await store.listRunnable(now, 20);
    } finally {
      spy.mockRestore();
    }

    expect(prepared.length).toBeGreaterThan(0);
    expect(prepared.filter((sql) => sql.includes("raw_rfc2822"))).toEqual([]);
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
