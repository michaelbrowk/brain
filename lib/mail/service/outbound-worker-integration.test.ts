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
import { createMailSyncPause } from "./sync-pause";

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

  /** THE WORST MESSAGE THE COMPOSER CAN BUILD, AGAINST THE CEILING.
   *
   *  The case above sends the attachment cap beside a 35-byte body, so it
   *  builds about 13.7 MiB and clears the 17 MiB ceiling whatever that ceiling
   *  says down to 14 — the ceiling is not load-bearing in it. What
   *  `outgoingRawMessageBytes` has to carry is the whole band: the cap in
   *  files, the text body at its own limit, the headers at theirs.
   *
   *  So this one asks the composer for every byte it can be made to produce.
   *  Ten files (`maxCount`) summing to `maxTotalBytes`, each with a filename
   *  that forces both the ASCII and the RFC 5987 parameter. A text body at
   *  `MAX_TEXT_BYTES` made entirely of line breaks, which is the shape that
   *  costs the most: `normalizeLineEndings` turns every one into CRLF, so the
   *  part that reaches base64 is twice the body that was admitted. `origin:
   *  "mcp"` with `agentLine`, which appends a line after that. A subject at
   *  `MAX_SUBJECT_BYTES`, which travels as base64 encoded words. A hundred
   *  recipients (`MAX_RECIPIENTS`) at `MAX_ADDRESS_BYTES` each.
   *
   *  There is no HTML part to add: the outbound composer writes text/plain and
   *  the attachments, and nothing else.
   *
   *  The assertion is the whole point — the message is over 15 MiB and still
   *  inside `outgoingRawMessageBytes`, so lowering that constant below what
   *  this shape costs reddens the case instead of passing silently. */
  it("carries the composer's worst shape, files and text at their limits, under the ceiling", async () => {
    const now = Date.parse("2026-07-20T00:00:00.000Z");
    const root = await mkdtemp(path.join(tmpdir(), "brain-mail-band-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { mode: 0o700 });

    const perFile =
      MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes /
      MAIL_SEND_ATTACHMENT_LIMITS.maxCount;
    expect(Number.isInteger(perFile)).toBe(true);
    const payloads = Array.from(
      { length: MAIL_SEND_ATTACHMENT_LIMITS.maxCount },
      (_, index) => Buffer.alloc(perFile, index + 1),
    );
    // A space in the name is what makes `encodeAttachmentFilename` write the
    // RFC 5987 form beside the ASCII one, which is the longer of the two
    // Content-Disposition shapes it can produce.
    const attachments = payloads.map((bytes, index) => ({
      filename: `f${index} ${"n".repeat(247)}.bin`,
      mimeType: "application/octet-stream",
      dataBase64: bytes.toString("base64"),
    }));
    // A hundred addresses of 254 bytes, all distinct, split across the three
    // recipient fields. Bcc is in the message a provider API is handed.
    const address = (index: number) =>
      `r${String(index).padStart(3, "0")}${"a".repeat(238)}@example.net`;
    const everyone = Array.from({ length: 100 }, (_, index) => address(index));
    expect(new Set(everyone).size).toBe(100);
    expect(everyone.every((one) => Buffer.byteLength(one) === 254)).toBe(true);
    const text = "\n".repeat(1024 * 1024);
    const subject = "S".repeat(998);

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
          providerMessageId: "gmail-message-band",
          providerThreadId: "gmail-thread-band",
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
      createOperationId: () => operationId(10),
    });

    const request = {
      accountId: ACCOUNT_ID,
      idempotencyKey: "send-the-whole-band",
      mode: "compose" as const,
      to: everyone.slice(0, 1),
      cc: everyone.slice(1, 50),
      bcc: everyone.slice(50),
      subject,
      text,
      replyToMessageId: null,
      attachments,
      origin: "mcp" as const,
      agentLine: true,
    };
    const sent = await service.send(request, requestContext());
    expect(sent).toMatchObject({ created: true, status: "sent" });

    const message: Buffer | null = delivered;
    expect(message).not.toBeNull();
    // Over 15 MiB is what makes the ceiling load-bearing: the case above is
    // not, and a ceiling nothing reaches is a number nobody can check.
    expect(message!.byteLength).toBeGreaterThan(15 * 1024 * 1024);
    expect(message!.byteLength).toBeLessThanOrEqual(
      MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes,
    );
    // The body doubled on its way to the wire: the first wrapped line of the
    // CRLF-normalized text is in the message, not the first line of the text
    // as it was admitted.
    const normalized = Buffer.from("\r\n".repeat(1024 * 1024), "utf8");
    expect(
      message!.includes(
        Buffer.from(normalized.toString("base64").slice(0, 76), "ascii"),
      ),
    ).toBe(true);
    expect(
      message!.includes(
        Buffer.from(payloads[9]!.toString("base64").slice(0, 76), "ascii"),
      ),
    ).toBe(true);
    expect(message!.includes(Buffer.from("Bcc: ", "ascii"))).toBe(true);
    expect(message!.includes(Buffer.from("X-Brain-Agent: mcp", "ascii"))).toBe(
      true,
    );

    const stored = await store.readByOperationId(sent.operationId);
    expect(stored?.message.rawRfc2822.equals(message!)).toBe(true);
    expect(createHash("sha256").update(message!).digest("hex")).toBe(
      stored?.message.rawRfc2822Sha256,
    );

    // The 1 MiB above is a mirror of `MAX_TEXT_BYTES`, which the service keeps
    // to itself. One byte more is refused, so the mirror cannot drift without
    // this case saying so — a text limit that had quietly risen would make the
    // band measured here an understatement.
    await expect(
      service.send(
        { ...request, idempotencyKey: "one-byte-over", text: `${text}\n` },
        requestContext(),
      ),
    ).rejects.toMatchObject({ code: "mail_send_request_invalid" });

    await store.close();
  });

  /** ONE MESSAGE RESIDENT, WHATEVER THE BACKLOG.
   *
   *  The worker takes a batch of twenty by default and delivers them one at a
   *  time, so the batch read is where a backlog becomes memory: twenty messages
   *  at the attachment cap is 274 MiB of message, against `MemoryMax=296M`. The
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

  /** OFF MEANS NOTHING LEAVES, AND NOTHING IS LOST EITHER.
   *
   *  The owner's switch reaches this worker as `stop()` through the pause
   *  port, and a row already in the outbox has to be exactly where it was
   *  when the switch comes back on. Nothing here is theoretical: the
   *  retention sweep deletes only terminal rows and only inside a pass, and
   *  `SMTP_MAX_ATTEMPTS` counts attempts rather than wall clock, so a stopped
   *  worker costs the row neither a deletion nor an attempt however long the
   *  pause lasts. */
  it("keeps a queued row through a pause and delivers it on resume", async () => {
    const now = Date.parse("2026-07-20T00:00:00.000Z");
    const root = await mkdtemp(path.join(tmpdir(), "brain-mail-pause-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    await mkdir(cacheRoot, { mode: 0o700 });

    const store = new SqliteMailSendStore({ cacheRoot, now: () => now });
    await store.initialize();
    const queued = submission(31, {
      nextAttemptAt: now - 1_000,
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
    });
    await store.enqueue(queued);

    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (message, hooks) => {
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
    });
    const worker = new MailOutboundWorker({
      store,
      processor: service,
      now: () => now,
      // Long enough that `start()` schedules rather than runs, so what makes
      // the row move below is the resume and the pass, not a race.
      initialDelayMs: 60_000,
      batchSize: 10,
    });

    let storedPaused = false;
    const pause = createMailSyncPause({
      readPaused: () => storedPaused,
      writePaused: (value) => {
        storedPaused = value;
      },
      workers: [worker],
    });

    await worker.start();
    await pause.setPaused(true);
    expect(storedPaused).toBe(true);
    expect(provider.send).not.toHaveBeenCalled();
    await expect(
      store.readByOperationId(queued.operationId),
    ).resolves.toMatchObject({ status: "queued", attemptCount: 0 });

    await pause.setPaused(false);
    await worker.runNow();
    expect(provider.send).toHaveBeenCalledTimes(1);
    await expect(
      store.readByOperationId(queued.operationId),
    ).resolves.toMatchObject({ status: "sent" });

    await worker.stop();
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
