import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MAIL_RESOURCE_LIMITS } from "../security";
import {
  fingerprintMailDraftCreate,
  fingerprintMailDraftDelete,
  fingerprintMailDraftMutation,
  MAIL_DRAFT_LIMITS,
  validateMailDraftCreateInput,
  validateMailDraftMutationInput,
} from "../draft-codec";
import {
  MAIL_DRAFT_API_VERSION,
  type StoredMailDraft,
} from "../draft-types";
import {
  claimSubmission,
  markSubmissionDeliveryRisk,
  reconcileDeliveryUnknownFound,
  recordSmtpOutcome,
  type SubmissionRecord,
} from "../send-state";
import { MailDraftError } from "./drafts";
import {
  fingerprintMailSendInput,
  MailSendError,
  type StoredMailSendSubmission,
  validateMailSendInput,
} from "./outbound";
import { buildOutboundRfc2822 } from "./outbound-message";
import { SqliteMailSendStore } from "./outbound-store";

const FIRST_ACCOUNT = `account-a${"1".repeat(32)}`;
const SECOND_ACCOUNT = `account-a${"2".repeat(32)}`;
const THIRD_ACCOUNT = `account-a${"3".repeat(32)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("private durable mail outbox", () => {
  it("survives a new store instance and atomically advances one version", async () => {
    const fixture = await createStore();
    const queued = submissionFixture();

    await expect(fixture.store.enqueue(queued)).resolves.toEqual({
      created: true,
      submission: queued,
    });
    const sending = Object.freeze({
      ...queued,
      version: 1,
      status: "sending" as const,
      attemptCount: 1,
      lease: Object.freeze({
        attemptId: "attempt-00000000-0000-4000-8000-000000000001",
        expiresAt: queued.updatedAt + 60_000,
        deliveryRisk: false,
      }),
      nextAttemptAt: null,
      updatedAt: queued.updatedAt + 1,
    });
    await expect(
      fixture.store.compareAndSwap(queued.operationId, 0, sending),
    ).resolves.toBe(true);
    await fixture.store.close();

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    await expect(reopened.readByOperationId(queued.operationId)).resolves.toEqual(
      sending,
    );
    await expect(
      reopened.compareAndSwap(queued.operationId, 0, sending),
    ).resolves.toBe(false);

    const databasePath = path.join(
      fixture.cacheRoot,
      FIRST_ACCOUNT,
      "outbox.sqlite3",
    );
    const metadata = await stat(databasePath);
    expect(metadata.mode & 0o077).toBe(0);
    await expect(readFile(databasePath)).resolves.toBeInstanceOf(Buffer);
    await reopened.close();
  });

  it("keeps Gmail rows byte-for-byte outside the SMTP ownership boundary", async () => {
    const fixture = await createStore();
    const gmail = submissionFixture();
    await fixture.store.enqueue(gmail);
    await fixture.store.close();

    const database = openDatabase(fixture.cacheRoot);
    try {
      expect(
        database
          .prepare("SELECT submission_json FROM outbox WHERE operation_id = ?")
          .get(gmail.operationId)?.submission_json,
      ).toBe(JSON.stringify(gmail));
      // The ownership schema exists, but a Gmail row never becomes SMTP-owned.
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM smtp_submission_state")
          .get()?.count,
      ).toBe(0);
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    } finally {
      database.close();
    }
  });

  it("durably links one pristine IMAP outbox row and lets exactly one CAS win", async () => {
    const fixture = await createStore();
    const imap = submissionFixture({ providerKind: "imap" });
    await fixture.store.enqueue(imap);

    // Ownership was handed off atomically inside the enqueue transaction.
    const initialized = await fixture.store.initializeSmtpSubmissionState(
      imap.accountId,
      imap.operationId,
    );
    expect(initialized.created).toBe(false);
    expect(initialized.state).toMatchObject({
      version: 0,
      phase: "queued",
      submission: {
        operationId: imap.operationId,
        idempotencyKey: imap.idempotencyKey,
        accountId: imap.accountId,
        messageId: imap.message.messageId,
        rawMimeSha256: imap.message.rawRfc2822Sha256,
        rawMimeBytes: imap.message.rawRfc2822Bytes,
        createdAt: imap.createdAt,
      },
    });
    await expect(
      fixture.store.initializeSmtpSubmissionState(
        imap.accountId,
        imap.operationId,
      ),
    ).resolves.toEqual({ created: false, state: initialized.state });

    const claimed = claimSubmission(initialized.state, {
      attemptId: "smtp-attempt-durable",
      now: imap.createdAt,
      leaseMs: 60_000,
    });
    const competitor = new SqliteMailSendStore({
      cacheRoot: fixture.cacheRoot,
    });
    await competitor.initialize();
    const winners = await Promise.all([
      fixture.store.compareAndSwapSmtpSubmissionState(
        imap.accountId,
        imap.operationId,
        0,
        claimed,
      ),
      competitor.compareAndSwapSmtpSubmissionState(
        imap.accountId,
        imap.operationId,
        0,
        claimed,
      ),
    ]);
    expect(winners.filter(Boolean)).toHaveLength(1);
    await Promise.all([fixture.store.close(), competitor.close()]);

    const database = openDatabase(fixture.cacheRoot);
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
      expect(
        database
          .prepare(
            `SELECT format_version, state_version, phase, runnable_at
               FROM smtp_submission_state WHERE operation_id = ?`,
          )
          .get(imap.operationId),
      ).toEqual({
        format_version: 1,
        state_version: 1,
        phase: "submitting",
        runnable_at: claimed.lease!.expiresAt,
      });
    } finally {
      database.close();
    }

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    await expect(
      reopened.readSmtpSubmissionState(imap.accountId, imap.operationId),
    ).resolves.toEqual(claimed);
    await reopened.close();

    const deleting = openDatabase(fixture.cacheRoot);
    try {
      deleting.exec("PRAGMA foreign_keys = ON");
      deleting
        .prepare("DELETE FROM outbox WHERE operation_id = ?")
        .run(imap.operationId);
      expect(
        deleting
          .prepare(
            "SELECT COUNT(*) AS count FROM smtp_submission_state WHERE operation_id = ?",
          )
          .get(imap.operationId)?.count,
      ).toBe(0);
    } finally {
      deleting.close();
    }
  });

  it("fails closed on Gmail ownership, non-pristine state, and corrupt sidecar JSON", async () => {
    const fixture = await createStore();
    const gmail = submissionFixture();
    await fixture.store.enqueue(gmail);
    await expect(
      fixture.store.initializeSmtpSubmissionState(
        gmail.accountId,
        gmail.operationId,
      ),
    ).rejects.toEqual(new MailSendError("mail_send_service_unavailable"));

    const owned = submissionFixture({
      operationId: operationId(11),
      idempotencyKey: "imap-legacy-claim-refused",
      providerKind: "imap",
    });
    await fixture.store.enqueue(owned);
    const sending = Object.freeze({
      ...owned,
      version: 1,
      status: "sending" as const,
      attemptCount: 1,
      lease: Object.freeze({
        attemptId: "attempt-00000000-0000-4000-8000-000000000011",
        expiresAt: owned.updatedAt + 60_000,
        deliveryRisk: false,
      }),
      nextAttemptAt: null,
      updatedAt: owned.updatedAt + 1,
    });
    // The legacy outbox worker can never claim an SMTP-owned operation.
    await expect(
      fixture.store.compareAndSwap(owned.operationId, 0, sending),
    ).resolves.toBe(false);
    await expect(
      fixture.store.readByOperationId(owned.operationId),
    ).resolves.toEqual(owned);
    // An active IMAP row can never be inserted without SMTP ownership.
    await expect(
      fixture.store.enqueue(
        submissionFixture({
          operationId: operationId(13),
          idempotencyKey: "imap-active-unowned",
          providerKind: "imap",
          status: "sending",
          attemptCount: 1,
          lease: {
            attemptId: "attempt-00000000-0000-4000-8000-000000000013",
            expiresAt: Date.parse("2026-07-15T10:01:00.000Z"),
            deliveryRisk: false,
          },
          nextAttemptAt: null,
        }),
      ),
    ).rejects.toEqual(new MailSendError("mail_send_service_unavailable"));

    const imap = submissionFixture({
      operationId: operationId(12),
      idempotencyKey: "imap-corrupt-state",
      providerKind: "imap",
    });
    await fixture.store.enqueue(imap);
    await fixture.store.initializeSmtpSubmissionState(
      imap.accountId,
      imap.operationId,
    );
    await fixture.store.close();

    const database = openDatabase(fixture.cacheRoot);
    try {
      const row = database
        .prepare(
          "SELECT state_json FROM smtp_submission_state WHERE operation_id = ?",
        )
        .get(imap.operationId);
      const parsed = JSON.parse(String(row?.state_json));
      database
        .prepare(
          "UPDATE smtp_submission_state SET state_json = ? WHERE operation_id = ?",
        )
        .run(JSON.stringify({ ...parsed, unexpected: true }), imap.operationId);
    } finally {
      database.close();
    }

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    await expect(
      reopened.readSmtpSubmissionState(imap.accountId, imap.operationId),
    ).rejects.toEqual(new MailSendError("mail_send_service_unavailable"));
    await reopened.close();
  });

  it("deduplicates equal input and rejects changed content for the same key", async () => {
    const fixture = await createStore();
    const first = submissionFixture();
    await fixture.store.enqueue(first);

    await expect(
      fixture.store.enqueue({
        ...first,
        operationId: "send-00000000-0000-4000-8000-000000000002",
      }),
    ).resolves.toEqual({ created: false, submission: first });
    await expect(
      fixture.store.enqueue({
        ...first,
        operationId: "send-00000000-0000-4000-8000-000000000003",
        requestFingerprint: "b".repeat(64),
      }),
    ).rejects.toEqual(new MailSendError("mail_send_idempotency_conflict"));
    await fixture.store.close();
  });

  it("rejects reusing one operation id for another account", async () => {
    const fixture = await createStore();
    const first = submissionFixture();
    await fixture.store.enqueue(first);

    await expect(
      fixture.store.enqueue(
        submissionFixture({
          accountId: SECOND_ACCOUNT,
          operationId: first.operationId,
          idempotencyKey: "second-account-operation-collision",
          requestFingerprint: "b".repeat(64),
        }),
      ),
    ).rejects.toEqual(new MailSendError("mail_send_idempotency_conflict"));
    await expect(
      fixture.store.readByOperationId(first.operationId),
    ).resolves.toEqual(first);
    await fixture.store.close();
  });

  it("lists durable runnable work fairly after reopening the store", async () => {
    const fixture = await createStore();
    const now = Date.parse("2026-07-15T10:05:00.000Z");
    const queued = submissionFixture({
      operationId: operationId(1),
      idempotencyKey: "queued-1",
      nextAttemptAt: now - 3_000,
      updatedAt: now - 3_000,
    });
    const expiredSafe = submissionFixture({
      operationId: operationId(2),
      idempotencyKey: "sending-safe",
      status: "sending",
      attemptCount: 1,
      lease: {
        attemptId: "attempt-00000000-0000-4000-8000-000000000002",
        expiresAt: now - 2_000,
        deliveryRisk: false,
      },
      nextAttemptAt: null,
      updatedAt: now - 4_000,
    });
    const expiredRisk = submissionFixture({
      operationId: operationId(3),
      idempotencyKey: "sending-risk",
      status: "sending",
      attemptCount: 1,
      lease: {
        attemptId: "attempt-00000000-0000-4000-8000-000000000003",
        expiresAt: now - 1_000,
        deliveryRisk: true,
      },
      nextAttemptAt: null,
      updatedAt: now - 5_000,
    });
    const active = submissionFixture({
      operationId: operationId(4),
      idempotencyKey: "sending-active",
      status: "sending",
      attemptCount: 1,
      lease: {
        attemptId: "attempt-00000000-0000-4000-8000-000000000004",
        expiresAt: now + 60_000,
        deliveryRisk: false,
      },
      nextAttemptAt: null,
      updatedAt: now - 1_000,
    });
    const sent = submissionFixture({
      operationId: operationId(5),
      idempotencyKey: "sent-1",
      status: "sent",
      attemptCount: 1,
      nextAttemptAt: null,
      providerMessageId: "gmail-message-5",
      providerThreadId: "gmail-thread-5",
      updatedAt: now,
    });
    const failed = submissionFixture({
      operationId: operationId(6),
      idempotencyKey: "failed-1",
      status: "failed",
      attemptCount: 1,
      nextAttemptAt: null,
      lastErrorCode: "mail_send_account_reauth_required",
      updatedAt: now,
    });
    const unknown = submissionFixture({
      operationId: operationId(7),
      idempotencyKey: "unknown-1",
      status: "delivery_unknown",
      attemptCount: 1,
      nextAttemptAt: null,
      lastErrorCode: "mail_send_service_unavailable",
      updatedAt: now,
    });
    for (const submission of [
      queued,
      expiredSafe,
      expiredRisk,
      active,
      sent,
      failed,
      unknown,
    ]) {
      await fixture.store.enqueue(submission);
    }
    await fixture.store.close();

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    await expect(reopened.listRunnable(now, 2)).resolves.toEqual([
      queued,
      expiredSafe,
    ]);
    await expect(reopened.listRunnable(now, 10)).resolves.toEqual([
      queued,
      expiredSafe,
      expiredRisk,
    ]);
    await expect(reopened.nextRunnableAt()).resolves.toBe(now - 3_000);
    await expect(reopened.countActive()).resolves.toBe(4);
    await reopened.close();
  });

  it("migrates schema v1 rows atomically and builds indexed queue metadata", async () => {
    const fixture = await createStore();
    await fixture.store.close();
    const queued = submissionFixture({
      operationId: operationId(10),
      idempotencyKey: "legacy-queued",
    });
    await createLegacyDatabase(fixture.cacheRoot, queued);

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    await expect(
      reopened.listRunnable(queued.updatedAt, 1),
    ).resolves.toEqual([queued]);
    await reopened.close();

    const database = openDatabase(fixture.cacheRoot);
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
      const columns = database
        .prepare("PRAGMA table_info(outbox)")
        .all()
        .map((row) => row.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "status",
          "runnable_at",
          "created_at",
          "updated_at",
        ]),
      );
      const indexes = database
        .prepare("PRAGMA index_list(outbox)")
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "outbox_runnable_idx",
          "outbox_active_idx",
          "outbox_terminal_retention_idx",
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("rolls back a v1 migration when legacy JSON is corrupt", async () => {
    const fixture = await createStore();
    await fixture.store.close();
    await createLegacyDatabase(
      fixture.cacheRoot,
      submissionFixture({ operationId: operationId(11) }),
      "{not-json",
    );

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    await expect(reopened.countActive()).rejects.toEqual(
      new MailSendError("mail_send_service_unavailable"),
    );
    await reopened.close();

    const database = openDatabase(fixture.cacheRoot);
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      const columns = database
        .prepare("PRAGMA table_info(outbox)")
        .all()
        .map((row) => row.name);
      expect(columns).not.toContain("runnable_at");
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM outbox").get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("enforces one global active quota across concurrent account enqueues", async () => {
    const fixture = await createStore();
    for (
      let index = 1;
      index < MAIL_RESOURCE_LIMITS.maxQueuedSubmissions;
      index += 1
    ) {
      await fixture.store.enqueue(
        submissionFixture({
          operationId: operationId(100 + index),
          idempotencyKey: `quota-seed-${index}`,
        }),
      );
    }
    const second = submissionFixture({
      accountId: SECOND_ACCOUNT,
      operationId: operationId(300),
      idempotencyKey: "quota-second",
    });
    const third = submissionFixture({
      accountId: THIRD_ACCOUNT,
      operationId: operationId(301),
      idempotencyKey: "quota-third",
    });

    const admitted = await Promise.allSettled([
      fixture.store.enqueue(second),
      fixture.store.enqueue(third),
    ]);
    expect(admitted.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(admitted.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    await expect(fixture.store.countActive()).resolves.toBe(
      MAIL_RESOURCE_LIMITS.maxQueuedSubmissions,
    );
    const winner = admitted[0]?.status === "fulfilled" ? second : third;
    await expect(fixture.store.enqueue(winner)).resolves.toEqual({
      created: false,
      submission: winner,
    });
    await fixture.store.close();
  }, 15_000);

  it("drains queued cross-account mutations before close returns", async () => {
    const fixture = await createStore();
    const first = submissionFixture({
      operationId: operationId(400),
      idempotencyKey: "close-first",
    });
    const second = submissionFixture({
      accountId: SECOND_ACCOUNT,
      operationId: operationId(401),
      idempotencyKey: "close-second",
    });
    const pending = [
      fixture.store.enqueue(first),
      fixture.store.enqueue(second),
    ];
    const closing = fixture.store.close();
    const settled = await Promise.allSettled(pending);
    await closing;
    const admitted = settled.filter(
      (result) => result.status === "fulfilled",
    ).length;

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    await expect(reopened.countActive()).resolves.toBe(admitted);
    await reopened.close();
  });

  it("rejects a terminal-to-active CAS that could bypass the global quota", async () => {
    const fixture = await createStore();
    const terminal = terminalSubmission(500, Date.now());
    await fixture.store.enqueue(terminal);
    const resurrected = Object.freeze({
      ...terminal,
      version: 1,
      status: "queued" as const,
      providerMessageId: null,
      providerThreadId: null,
      nextAttemptAt: terminal.updatedAt + 1,
      updatedAt: terminal.updatedAt + 1,
    });

    await expect(
      fixture.store.compareAndSwap(terminal.operationId, 0, resurrected),
    ).rejects.toEqual(new MailSendError("mail_send_service_unavailable"));
    await expect(fixture.store.countActive()).resolves.toBe(0);
    await fixture.store.close();
  });

  it("retains terminal idempotency for 30 days but bounds it to 500 rows", async () => {
    const fixture = await createStore();
    await fixture.store.enqueue(submissionFixture());
    await fixture.store.close();
    const now = Date.now();
    const old = terminalSubmission(1_000, now - 31 * 24 * 60 * 60 * 1_000);
    const recent = Array.from({ length: 501 }, (_, index) =>
      terminalSubmission(1_001 + index, now - index * 1_000),
    );
    const database = openDatabase(fixture.cacheRoot);
    try {
      database.exec("BEGIN IMMEDIATE");
      insertV2Submission(database, old);
      for (const submission of recent) insertV2Submission(database, submission);
      database.exec("COMMIT");
    } finally {
      database.close();
    }

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    const trigger = submissionFixture({
      operationId: operationId(2_000),
      idempotencyKey: "retention-trigger",
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
    await reopened.enqueue(trigger);
    await expect(reopened.readByOperationId(old.operationId)).resolves.toBeNull();
    await expect(
      reopened.readByOperationId(recent[0]!.operationId),
    ).resolves.toEqual(recent[0]);
    await expect(
      reopened.enqueue({
        ...recent[0]!,
        operationId: operationId(2_001),
      }),
    ).resolves.toEqual({ created: false, submission: recent[0] });
    await reopened.close();

    const verified = openDatabase(fixture.cacheRoot);
    try {
      expect(
        verified
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
              WHERE status IN ('sent', 'failed', 'delivery_unknown')`,
          )
          .get()?.count,
      ).toBe(500);
    } finally {
      verified.close();
    }
  });

  it("prunes terminal history from listRunnable at most hourly without enqueue", async () => {
    let now = Date.parse("2026-07-20T10:00:00.000Z");
    const integrityChecks: string[] = [];
    const fixture = await createStore({
      now: () => now,
      onIntegrityCheck: (accountId) => integrityChecks.push(accountId),
    });
    const recent = terminalSubmission(2_100, now);
    await fixture.store.enqueue(recent);

    await expect(fixture.store.listRunnable(now, 10)).resolves.toEqual([]);
    expect(integrityChecks).toEqual([FIRST_ACCOUNT]);
    const old = terminalSubmission(
      2_101,
      now - 31 * 24 * 60 * 60 * 1_000,
    );
    const database = openDatabase(fixture.cacheRoot);
    try {
      insertV2Submission(database, old);
    } finally {
      database.close();
    }

    now += 60 * 60 * 1_000 - 1;
    await fixture.store.listRunnable(now, 10);
    await expect(
      fixture.store.readByOperationId(old.operationId),
    ).resolves.toEqual(old);
    now += 1;
    await fixture.store.listRunnable(now, 10);
    await expect(
      fixture.store.readByOperationId(old.operationId),
    ).resolves.toBeNull();
    expect(integrityChecks).toEqual([FIRST_ACCOUNT]);
    await fixture.store.close();

    const restarted = new SqliteMailSendStore({
      cacheRoot: fixture.cacheRoot,
      now: () => now,
      onIntegrityCheck: (accountId) => integrityChecks.push(accountId),
    });
    await restarted.initialize();
    await restarted.countActive();
    expect(integrityChecks).toEqual([FIRST_ACCOUNT, FIRST_ACCOUNT]);
    await restarted.close();
  });

  it("keeps the cheap account identity check on every hot database open", async () => {
    const integrityChecks: string[] = [];
    const fixture = await createStore({
      onIntegrityCheck: (accountId) => integrityChecks.push(accountId),
    });
    await fixture.store.enqueue(submissionFixture());
    expect(integrityChecks).toEqual([FIRST_ACCOUNT]);
    const database = openDatabase(fixture.cacheRoot);
    try {
      database
        .prepare("UPDATE metadata SET account_id = ? WHERE singleton = 1")
        .run(SECOND_ACCOUNT);
    } finally {
      database.close();
    }

    await expect(fixture.store.countActive()).rejects.toEqual(
      new MailSendError("mail_send_service_unavailable"),
    );
    expect(integrityChecks).toEqual([FIRST_ACCOUNT]);
    await fixture.store.close();
  });

  it("uses metadata aggregates and decodes JSON only for the selected batch", async () => {
    const fixture = await createStore();
    const now = Date.now();
    const valid = submissionFixture({
      operationId: operationId(3_000),
      idempotencyKey: "selected-valid",
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
    await fixture.store.enqueue(valid);
    await fixture.store.close();

    const database = openDatabase(fixture.cacheRoot);
    try {
      insertCorruptV2Row(database, {
        operationId: operationId(3_001),
        idempotencyKey: "corrupt-terminal",
        status: "sent",
        runnableAt: null,
        createdAt: now,
      });
      insertCorruptV2Row(database, {
        operationId: operationId(3_002),
        idempotencyKey: "corrupt-runnable",
        status: "queued",
        runnableAt: now + 1,
        createdAt: now + 1,
      });
    } finally {
      database.close();
    }

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    await expect(reopened.nextRunnableAt()).resolves.toBe(now);
    await expect(reopened.countActive()).resolves.toBe(2);
    await expect(reopened.listRunnable(now + 1, 1)).resolves.toEqual([valid]);
    await expect(reopened.listRunnable(now + 1, 2)).rejects.toEqual(
      new MailSendError("mail_send_service_unavailable"),
    );
    await reopened.close();
  });

  it("puts each outbox below its account cache deletion boundary", async () => {
    const fixture = await createStore();
    const first = submissionFixture();
    const second = submissionFixture({
      accountId: SECOND_ACCOUNT,
      operationId: "send-00000000-0000-4000-8000-000000000002",
      idempotencyKey: "compose-action-2",
      requestFingerprint: "b".repeat(64),
    });
    await fixture.store.enqueue(first);
    await fixture.store.enqueue(second);

    // The account service awaits this barrier before it atomically renames the
    // directory. No open outbox descriptor or later write can survive it.
    await fixture.store.invalidateAccount(FIRST_ACCOUNT);
    await expect(fixture.store.enqueue(first)).rejects.toEqual(
      new MailSendError("mail_send_service_unavailable"),
    );

    // If the authoritative account deletion fails, the removal guard restores
    // every drained layer and the untouched durable outbox becomes live again.
    await fixture.store.restoreInvalidatedAccount(FIRST_ACCOUNT);
    await expect(fixture.store.readByOperationId(first.operationId)).resolves.toEqual(
      first,
    );
    await fixture.store.invalidateAccount(FIRST_ACCOUNT);
    await rm(path.join(fixture.cacheRoot, FIRST_ACCOUNT), { recursive: true });
    await expect(fixture.store.readByOperationId(first.operationId)).resolves.toBeNull();
    await expect(fixture.store.readByOperationId(second.operationId)).resolves.toEqual(
      second,
    );
    await expect(fixture.store.enqueue(first)).rejects.toEqual(
      new MailSendError("mail_send_service_unavailable"),
    );
    await fixture.store.close();
  });
});

describe("SMTP ownership handoff and outbox mirror", () => {
  it("blocks protocol edits while queued SMTP work still owns old bindings", async () => {
    const fixture = await createStore();
    const imap = submissionFixture({
      operationId: operationId(20),
      idempotencyKey: "imap-protocol-edit-barrier",
      providerKind: "imap",
    });
    await fixture.store.enqueue(imap);

    await expect(
      fixture.store.assertAccountProtocolMutationSafe(imap.accountId),
    ).rejects.toEqual(new MailSendError("mail_send_service_unavailable"));
    await fixture.store.invalidateAccount(imap.accountId);
    await expect(
      fixture.store.assertAccountProtocolMutationSafe(imap.accountId),
    ).rejects.toEqual(new MailSendError("mail_send_service_unavailable"));
    await expect(
      fixture.store.assertAccountProtocolMutationSafe(imap.accountId, {
        preservesBindings: true,
      }),
    ).resolves.toBeUndefined();
    await fixture.store.restoreInvalidatedAccount(imap.accountId);
    await expect(
      fixture.store.readSmtpSubmissionState(imap.accountId, imap.operationId),
    ).resolves.toMatchObject({ phase: "queued" });
    await fixture.store.close();
  });

  it("partitions runnable work between the legacy and SMTP workers", async () => {
    const fixture = await createStore();
    const now = Date.parse("2026-07-15T10:00:00.000Z");
    const gmail = submissionFixture();
    const imap = submissionFixture({
      operationId: operationId(21),
      idempotencyKey: "imap-partitioned",
      providerKind: "imap",
    });
    await fixture.store.enqueue(gmail);
    await fixture.store.enqueue(imap);

    await expect(fixture.store.listRunnable(now, 10)).resolves.toEqual([gmail]);
    await expect(fixture.store.nextRunnableAt()).resolves.toBe(
      gmail.nextAttemptAt,
    );
    await expect(fixture.store.countActive()).resolves.toBe(2);
    await expect(
      fixture.store.listRunnableSmtpSubmissions(now, 10),
    ).resolves.toEqual([
      { accountId: imap.accountId, operationId: imap.operationId },
    ]);
    await expect(fixture.store.nextRunnableSmtpAt()).resolves.toBe(
      imap.createdAt,
    );
    await expect(
      fixture.store.readSmtpSubmissionRaw(imap.accountId, imap.operationId),
    ).resolves.toEqual(
      Buffer.from(imap.message.rawRfc2822Base64Url, "base64url"),
    );
    await expect(
      fixture.store.readSmtpSubmissionRaw(gmail.accountId, gmail.operationId),
    ).resolves.toBeNull();
    await fixture.store.close();
  });

  it("mirrors SMTP acceptance onto the outbox row exactly once", async () => {
    const fixture = await createStore();
    const imap = submissionFixture({
      operationId: operationId(22),
      idempotencyKey: "imap-mirror-sent",
      providerKind: "imap",
    });
    await fixture.store.enqueue(imap);
    let state = (await fixture.store.readSmtpSubmissionState(
      imap.accountId,
      imap.operationId,
    ))!;

    state = await casThrough(
      fixture.store,
      state,
      claimSubmission(state, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000022",
        now: imap.createdAt,
        leaseMs: 60_000,
      }),
    );
    // A claim is worker-private and never rewrites the public outbox row.
    await expect(
      fixture.store.readByOperationId(imap.operationId),
    ).resolves.toMatchObject({ version: 0, status: "queued" });

    state = await casThrough(
      fixture.store,
      state,
      markSubmissionDeliveryRisk(state, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000022",
        now: imap.createdAt + 1,
      }),
    );
    state = await casThrough(
      fixture.store,
      state,
      recordSmtpOutcome(state, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000022",
        now: imap.createdAt + 2,
        outcome: {
          kind: "accepted",
          responseCode: 250,
          acceptedRecipients: [...imap.message.envelope.to],
          rejectedRecipients: [],
        },
      }),
    );
    expect(state.phase).toBe("sent_copy_pending");
    await expect(
      fixture.store.readByOperationId(imap.operationId),
    ).resolves.toMatchObject({
      version: 1,
      status: "sent",
      providerMessageId: null,
      providerThreadId: null,
      lastErrorCode: null,
    });
    await fixture.store.close();
  });

  it("projects partial SMTP acceptance as delivery_unknown, never sent", async () => {
    const fixture = await createStore();
    const seed = submissionFixture({
      operationId: operationId(25),
      idempotencyKey: "imap-mirror-partial",
      providerKind: "imap",
    });
    const imap = Object.freeze({
      ...seed,
      message: Object.freeze({
        ...seed.message,
        envelope: Object.freeze({
          ...seed.message.envelope,
          to: Object.freeze([
            "friend@example.net",
            "rejected@example.net",
          ]),
        }),
      }),
    });
    await fixture.store.enqueue(imap);
    let state = (await fixture.store.readSmtpSubmissionState(
      imap.accountId,
      imap.operationId,
    ))!;

    state = await casThrough(
      fixture.store,
      state,
      claimSubmission(state, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000025",
        now: imap.createdAt,
        leaseMs: 60_000,
      }),
    );
    state = await casThrough(
      fixture.store,
      state,
      markSubmissionDeliveryRisk(state, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000025",
        now: imap.createdAt + 1,
      }),
    );
    state = await casThrough(
      fixture.store,
      state,
      recordSmtpOutcome(state, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000025",
        now: imap.createdAt + 2,
        outcome: {
          kind: "accepted",
          responseCode: 250,
          acceptedRecipients: [imap.message.envelope.to[0]!],
          rejectedRecipients: [
            {
              address: imap.message.envelope.to[1]!,
              responseCode: 550,
              retryable: false,
              errorCode: "smtp_recipient_rejected",
            },
          ],
        },
      }),
    );

    expect(state.phase).toBe("sent_copy_pending");
    expect(state.smtpAcceptance?.acceptedRecipients).toEqual([
      imap.message.envelope.to[0],
    ]);
    expect(state.smtpAcceptance?.rejectedRecipients).toEqual([
      {
        address: imap.message.envelope.to[1],
        responseCode: 550,
        retryable: false,
        errorCode: "smtp_recipient_rejected",
      },
    ]);
    await expect(
      fixture.store.readByOperationId(imap.operationId),
    ).resolves.toMatchObject({
      status: "delivery_unknown",
      lastErrorCode: "mail_send_service_unavailable",
    });
    expect(state.attemptCount).toBe(1);
    expect(state.retryAt).toBeNull();
    await fixture.store.close();
  });

  it("mirrors permanent failure and reconciled delivery_unknown outcomes", async () => {
    const fixture = await createStore();
    const failed = submissionFixture({
      operationId: operationId(23),
      idempotencyKey: "imap-mirror-failed",
      providerKind: "imap",
    });
    const unknown = submissionFixture({
      operationId: operationId(24),
      idempotencyKey: "imap-mirror-unknown",
      providerKind: "imap",
    });
    await fixture.store.enqueue(failed);
    await fixture.store.enqueue(unknown);

    let failedState = (await fixture.store.readSmtpSubmissionState(
      failed.accountId,
      failed.operationId,
    ))!;
    failedState = await casThrough(
      fixture.store,
      failedState,
      claimSubmission(failedState, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000023",
        now: failed.createdAt,
        leaseMs: 60_000,
      }),
    );
    await casThrough(
      fixture.store,
      failedState,
      recordSmtpOutcome(failedState, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000023",
        now: failed.createdAt + 1,
        outcome: {
          kind: "rejected",
          responseCode: 535,
          retryable: false,
          errorCode: "smtp_auth_failed",
        },
      }),
    );
    await expect(
      fixture.store.readByOperationId(failed.operationId),
    ).resolves.toMatchObject({
      status: "failed",
      lastErrorCode: "mail_send_account_reauth_required",
    });

    let unknownState = (await fixture.store.readSmtpSubmissionState(
      unknown.accountId,
      unknown.operationId,
    ))!;
    unknownState = await casThrough(
      fixture.store,
      unknownState,
      claimSubmission(unknownState, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000024",
        now: unknown.createdAt,
        leaseMs: 60_000,
      }),
    );
    unknownState = await casThrough(
      fixture.store,
      unknownState,
      markSubmissionDeliveryRisk(unknownState, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000024",
        now: unknown.createdAt + 1,
      }),
    );
    unknownState = await casThrough(
      fixture.store,
      unknownState,
      recordSmtpOutcome(unknownState, {
        attemptId: "attempt-00000000-0000-4000-8000-000000000024",
        now: unknown.createdAt + 2,
        outcome: {
          kind: "transport_error",
          deliveryRisk: "possible",
          errorCode: "smtp_connection_closed",
        },
      }),
    );
    await expect(
      fixture.store.readByOperationId(unknown.operationId),
    ).resolves.toMatchObject({
      status: "delivery_unknown",
      lastErrorCode: "mail_send_service_unavailable",
    });
    await expect(
      fixture.store.listReconcilableSmtpSubmissions(10),
    ).resolves.toEqual([
      { accountId: unknown.accountId, operationId: unknown.operationId },
    ]);

    unknownState = await casThrough(
      fixture.store,
      unknownState,
      reconcileDeliveryUnknownFound(unknownState, {
        now: unknown.createdAt + 3,
        mailboxId: "sent",
        uidValidity: "99",
        uid: 7,
      }),
    );
    expect(unknownState.phase).toBe("sent");
    await expect(
      fixture.store.readByOperationId(unknown.operationId),
    ).resolves.toMatchObject({ status: "sent", lastErrorCode: null });
    await fixture.store.close();
  });
});

async function casThrough(
  store: SqliteMailSendStore,
  current: SubmissionRecord,
  next: SubmissionRecord,
): Promise<SubmissionRecord> {
  const swapped = await store.compareAndSwapSmtpSubmissionState(
    current.submission.accountId,
    current.submission.operationId,
    current.version,
    next,
  );
  expect(swapped).toBe(true);
  return next;
}

describe("durable account-scoped mail drafts", () => {
  it("adds dormant draft tables without changing schema v2 or the send path", async () => {
    const fixture = await createStore();
    await fixture.store.enqueue(submissionFixture());
    await fixture.store.close();

    const database = openDatabase(fixture.cacheRoot);
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
      const tables = database
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'draft%'
            ORDER BY name`,
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual([
        "draft_attachments",
        "draft_deletions",
        "draft_mutations",
        "drafts",
      ]);
      const outboxForeignKeys = database
        .prepare("PRAGMA foreign_key_list(drafts)")
        .all()
        .filter((row) => row.from === "send_operation_id");
      expect(outboxForeignKeys).toEqual([]);
      expect(
        database
          .prepare("PRAGMA index_list(drafts)")
          .all()
          .find((row) => row.name === "drafts_send_operation_unique_idx"),
      ).toMatchObject({ unique: 1, partial: 1 });
      expect(
        database
          .prepare("PRAGMA index_info(drafts_send_operation_unique_idx)")
          .all()
          .map((row) => row.name),
      ).toEqual(["account_id", "send_operation_id"]);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM outbox").get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("recovers incomplete-address drafts after a process restart", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture({
      to: "Friend <friend@",
      cc: "team, another <",
      text: "line one\nline two",
    });
    await expect(
      fixture.store.createDraft(
        draft,
        fingerprintMailDraftCreate(createInputFromFixture(draft)),
      ),
    ).resolves.toEqual({ created: true, draft });
    await fixture.store.close();

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    await expect(reopened.readDraft(FIRST_ACCOUNT, draft.draftId)).resolves.toEqual(
      draft,
    );
    await reopened.close();
  });

  it("preserves astral Unicode exactly across restart and create replay", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture({
      to: "😀 <emoji@example.com>",
      subject: "Astral 😀 subject",
      text: "Astral 😀 body",
    });
    const createFingerprint = fingerprintMailDraftCreate(
      createInputFromFixture(draft),
    );
    await expect(
      fixture.store.createDraft(draft, createFingerprint),
    ).resolves.toEqual({ created: true, draft });
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId),
    ).resolves.toEqual(draft);
    await fixture.store.close();

    const reopened = new SqliteMailSendStore({ cacheRoot: fixture.cacheRoot });
    await reopened.initialize();
    await expect(reopened.readDraft(FIRST_ACCOUNT, draft.draftId)).resolves.toEqual(
      draft,
    );
    await expect(
      reopened.createDraft(draft, createFingerprint),
    ).resolves.toEqual({ created: false, draft });
    await reopened.close();
  });

  it("replays the immutable create receipt after the draft was edited", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture();
    const createFingerprint = fingerprintMailDraftCreate(
      createInputFromFixture(draft),
    );
    await fixture.store.createDraft(draft, createFingerprint);
    const mutation = draftPatchMutation(20, 0, { subject: "Edited later" });
    await fixture.store.applyDraftMutation(
      mutation,
      fingerprintMailDraftMutation(mutation),
      draft.updatedAt + 1,
    );

    await expect(
      fixture.store.createDraft(draft, createFingerprint),
    ).resolves.toMatchObject({
      created: false,
      draft: { revision: 1, subject: "Edited later" },
    });
    const changedCreate = storedDraftFixture({ subject: "Different create" });
    await expect(
      fixture.store.createDraft(
        changedCreate,
        fingerprintMailDraftCreate(createInputFromFixture(changedCreate)),
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_idempotency_conflict"));
    await fixture.store.close();
  });

  it("increments CAS for same-value edits and replays only the same fingerprint", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture();
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const mutation = draftPatchMutation(1, 0, { subject: draft.subject });
    const fingerprint = fingerprintMailDraftMutation(mutation);

    await expect(
      fixture.store.applyDraftMutation(mutation, fingerprint, draft.updatedAt + 1),
    ).resolves.toEqual({
      replayed: false,
      appliedRevision: 1,
      operationId: null,
    });
    await expect(
      fixture.store.applyDraftMutation(mutation, fingerprint, draft.updatedAt + 2),
    ).resolves.toEqual({
      replayed: true,
      appliedRevision: 1,
      operationId: null,
    });
    const changed = draftPatchMutation(1, 0, { subject: "Changed" });
    await expect(
      fixture.store.applyDraftMutation(
        changed,
        fingerprintMailDraftMutation(changed),
        draft.updatedAt + 2,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_idempotency_conflict"));
    await expect(fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId)).resolves.toMatchObject({
      revision: 1,
      subject: draft.subject,
    });
    await fixture.store.close();
  });

  it("atomically commits a draft send receipt with its durable outbox row", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture({ to: "friend@example.com" });
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const submission = draftSubmissionFixture(draft, {
      operationId: operationId(8_101),
      idempotencyKey: "draft-atomic-send-1",
      createdAt: draft.updatedAt + 1,
      updatedAt: draft.updatedAt + 1,
      nextAttemptAt: draft.updatedAt + 1,
    });
    const mutation = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: draft.draftId,
      mutationId: draftMutationId(8_101),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: submission.idempotencyKey,
      sendOperationId: submission.operationId,
    });
    const fingerprint = fingerprintMailDraftMutation(mutation);

    await expect(
      fixture.store.commitDraftSend(
        mutation,
        fingerprint,
        submission,
        submission.createdAt,
      ),
    ).resolves.toEqual({
      replayed: false,
      appliedRevision: 1,
      operationId: submission.operationId,
      created: true,
      submission,
    });
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId),
    ).resolves.toMatchObject({
      revision: 1,
      state: "submitting",
      sendIdempotencyKey: submission.idempotencyKey,
      sendOperationId: submission.operationId,
    });
    await expect(
      fixture.store.readByOperationId(submission.operationId),
    ).resolves.toEqual(submission);
    await expect(
      fixture.store.commitDraftSend(
        mutation,
        fingerprint,
        submission,
        submission.createdAt,
      ),
    ).resolves.toEqual({
      replayed: true,
      appliedRevision: 1,
      operationId: submission.operationId,
      created: false,
      submission,
    });
    const database = openDatabase(fixture.cacheRoot);
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM outbox").get()?.count,
      ).toBe(1);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM draft_mutations").get()
          ?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
    await fixture.store.close();
  });

  it("allows only one account to claim a concurrent global send operation id", async () => {
    const fixture = await createStore();
    const firstDraft = storedDraftFixture({
      draftId: draftId(8_190),
      accountId: FIRST_ACCOUNT,
      to: "first@example.com",
    });
    const secondDraft = storedDraftFixture({
      draftId: draftId(8_191),
      accountId: SECOND_ACCOUNT,
      to: "second@example.com",
    });
    await Promise.all(
      [firstDraft, secondDraft].map((draft) =>
        fixture.store.createDraft(
          draft,
          fingerprintMailDraftCreate(createInputFromFixture(draft)),
        ),
      ),
    );

    const sharedOperationId = operationId(8_190);
    const attempts = [firstDraft, secondDraft].map((draft, index) => {
      const submission = draftSubmissionFixture(draft, {
        accountId: draft.accountId,
        operationId: sharedOperationId,
        idempotencyKey: `cross-account-draft-send-${index + 1}`,
        createdAt: draft.updatedAt + 1,
        updatedAt: draft.updatedAt + 1,
        nextAttemptAt: draft.updatedAt + 1,
      });
      const mutation = validateMailDraftMutationInput({
        accountId: draft.accountId,
        draftId: draft.draftId,
        mutationId: draftMutationId(8_190 + index),
        expectedRevision: 0,
        kind: "send",
        sendIdempotencyKey: submission.idempotencyKey,
        sendOperationId: sharedOperationId,
      });
      return Object.freeze({ draft, mutation, submission });
    });

    const settled = await Promise.allSettled(
      attempts.map(({ mutation, submission }) =>
        fixture.store.commitDraftSend(
          mutation,
          fingerprintMailDraftMutation(mutation),
          submission,
          submission.createdAt,
        ),
      ),
    );
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof fixture.store.commitDraftSend>>> =>
        result.status === "fulfilled",
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toEqual(
      new MailDraftError("mail_draft_idempotency_conflict"),
    );

    const winnerAccountId = fulfilled[0]!.value.submission.accountId;
    await expect(
      fixture.store.readByOperationId(sharedOperationId),
    ).resolves.toMatchObject({ accountId: winnerAccountId });
    for (const { draft } of attempts) {
      await expect(
        fixture.store.readDraft(draft.accountId, draft.draftId),
      ).resolves.toMatchObject(
        draft.accountId === winnerAccountId
          ? { revision: 1, state: "submitting", sendOperationId: sharedOperationId }
          : { revision: 0, state: "editing", sendOperationId: null },
      );
    }
    await fixture.store.close();
  });

  it("atomically rejects deleting a submitting draft without breaking its send receipt", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture({
      draftId: draftId(8_192),
      to: "friend@example.com",
    });
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const submission = draftSubmissionFixture(draft, {
      operationId: operationId(8_192),
      idempotencyKey: "submitting-draft-delete",
      createdAt: draft.updatedAt + 1,
      updatedAt: draft.updatedAt + 1,
      nextAttemptAt: draft.updatedAt + 1,
    });
    const mutation = validateMailDraftMutationInput({
      accountId: draft.accountId,
      draftId: draft.draftId,
      mutationId: draftMutationId(8_192),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: submission.idempotencyKey,
      sendOperationId: submission.operationId,
    });
    const fingerprint = fingerprintMailDraftMutation(mutation);
    await fixture.store.commitDraftSend(
      mutation,
      fingerprint,
      submission,
      submission.createdAt,
    );

    const deletion = draftDelete(8_193, draft.draftId, 1, draft.accountId);
    await expect(
      fixture.store.deleteDraft(
        deletion,
        fingerprintMailDraftDelete(deletion),
        submission.updatedAt + 1,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_state_invalid"));
    await expect(
      fixture.store.readDraft(draft.accountId, draft.draftId),
    ).resolves.toMatchObject({
      revision: 1,
      state: "submitting",
      sendOperationId: submission.operationId,
    });
    await expect(
      fixture.store.readByOperationId(submission.operationId),
    ).resolves.toEqual(submission);
    await expect(
      fixture.store.commitDraftSend(
        mutation,
        fingerprint,
        submission,
        submission.createdAt,
      ),
    ).resolves.toMatchObject({ replayed: true, created: false });
    await fixture.store.close();
  });

  it("rolls back the draft receipt when its matching outbox insert aborts", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture({ to: "friend@example.com" });
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const submission = draftSubmissionFixture(draft, {
      operationId: operationId(8_102),
      idempotencyKey: "draft-atomic-send-rollback",
      createdAt: draft.updatedAt + 1,
      updatedAt: draft.updatedAt + 1,
      nextAttemptAt: draft.updatedAt + 1,
    });
    const mutation = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: draft.draftId,
      mutationId: draftMutationId(8_102),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: submission.idempotencyKey,
      sendOperationId: submission.operationId,
    });
    const database = openDatabase(fixture.cacheRoot);
    try {
      database.exec(`CREATE TRIGGER reject_atomic_draft_send
        BEFORE INSERT ON outbox
        BEGIN
          SELECT RAISE(ABORT, 'test outbox insert failure');
        END`);
    } finally {
      database.close();
    }

    await expect(
      fixture.store.commitDraftSend(
        mutation,
        fingerprintMailDraftMutation(mutation),
        submission,
        submission.createdAt,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_service_unavailable"));
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId),
    ).resolves.toMatchObject({ revision: 0, state: "editing" });
    await expect(
      fixture.store.readByOperationId(submission.operationId),
    ).resolves.toBeNull();
    const rolledBack = openDatabase(fixture.cacheRoot);
    try {
      expect(
        rolledBack.prepare("SELECT COUNT(*) AS count FROM draft_mutations").get()
          ?.count,
      ).toBe(0);
    } finally {
      rolledBack.close();
    }
    await fixture.store.close();
  });

  it("rejects an outbox proposal whose recipients or MIME differ from the draft", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture({
      draftId: draftId(8_106),
      to: "draft-recipient@example.com",
      subject: "Exact draft subject",
      text: "Exact draft body",
    });
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const matching = draftSubmissionFixture(draft, {
      operationId: operationId(8_106),
      idempotencyKey: "draft-content-mismatch",
      createdAt: draft.updatedAt + 1,
      updatedAt: draft.updatedAt + 1,
      nextAttemptAt: draft.updatedAt + 1,
    });
    const mutation = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: draft.draftId,
      mutationId: draftMutationId(8_106),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: matching.idempotencyKey,
      sendOperationId: matching.operationId,
    });
    const wrongRecipients = Object.freeze({
      ...matching,
      message: Object.freeze({
        ...matching.message,
        envelope: Object.freeze({
          ...matching.message.envelope,
          to: Object.freeze(["another-recipient@example.com"]),
        }),
      }),
    });

    await expect(
      fixture.store.commitDraftSend(
        mutation,
        fingerprintMailDraftMutation(mutation),
        wrongRecipients,
        wrongRecipients.createdAt,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_idempotency_conflict"));
    const wrongRaw = Buffer.concat([
      Buffer.from(matching.message.rawRfc2822Base64Url, "base64url"),
      Buffer.from("X", "ascii"),
    ]);
    const wrongMime = Object.freeze({
      ...matching,
      message: Object.freeze({
        ...matching.message,
        rawRfc2822Base64Url: wrongRaw.toString("base64url"),
        rawRfc2822Bytes: wrongRaw.byteLength,
        rawRfc2822Sha256: createHash("sha256").update(wrongRaw).digest("hex"),
      }),
    });
    await expect(
      fixture.store.commitDraftSend(
        mutation,
        fingerprintMailDraftMutation(mutation),
        wrongMime,
        wrongMime.createdAt,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_idempotency_conflict"));
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId),
    ).resolves.toMatchObject({ revision: 0, state: "editing" });
    await expect(
      fixture.store.readByOperationId(matching.operationId),
    ).resolves.toBeNull();
    const database = openDatabase(fixture.cacheRoot);
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM draft_mutations").get()
          ?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
    await fixture.store.close();
  });

  it("binds reply, reply-all, and forward intents to their exact send context", async () => {
    const fixture = await createStore();
    const cases = [
      { kind: "reply" as const, index: 8_108, withThreading: true },
      { kind: "reply_all" as const, index: 8_109, withThreading: true },
      { kind: "forward" as const, index: 8_110, withThreading: false },
    ];
    for (const testCase of cases) {
      const draft = storedDraftFixture({
        draftId: draftId(testCase.index),
        intent: Object.freeze({
          kind: testCase.kind,
          sourceMessageId: `source-message-${testCase.index}`,
        }),
        threading: testCase.withThreading
          ? Object.freeze({
              providerThreadId: `gmail-thread-${testCase.index}`,
              rfcMessageId: `<source-${testCase.index}@example.com>`,
              references: Object.freeze([
                `<root-${testCase.index}@example.com>`,
              ]),
            })
          : null,
        to: `intent-${testCase.index}@example.com`,
      });
      await fixture.store.createDraft(
        draft,
        fingerprintMailDraftCreate(createInputFromFixture(draft)),
      );
      const submission = draftSubmissionFixture(draft, {
        operationId: operationId(testCase.index),
        idempotencyKey: `draft-intent-${testCase.kind}`,
        createdAt: draft.updatedAt + 1,
        updatedAt: draft.updatedAt + 1,
        nextAttemptAt: draft.updatedAt + 1,
      });
      const mutation = validateMailDraftMutationInput({
        accountId: FIRST_ACCOUNT,
        draftId: draft.draftId,
        mutationId: draftMutationId(testCase.index),
        expectedRevision: 0,
        kind: "send",
        sendIdempotencyKey: submission.idempotencyKey,
        sendOperationId: submission.operationId,
      });
      await expect(
        fixture.store.commitDraftSend(
          mutation,
          fingerprintMailDraftMutation(mutation),
          submission,
          submission.createdAt,
        ),
      ).resolves.toMatchObject({ replayed: false, created: true });
    }
    await fixture.store.close();
  });

  it("does not attach a draft to a pre-existing standalone send", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture({ to: "friend@example.com" });
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const submission = draftSubmissionFixture(draft, {
      operationId: operationId(8_103),
      idempotencyKey: "standalone-send-before-draft",
      createdAt: draft.updatedAt + 1,
      updatedAt: draft.updatedAt + 1,
      nextAttemptAt: draft.updatedAt + 1,
    });
    await fixture.store.enqueue(submission);
    const mutation = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: draft.draftId,
      mutationId: draftMutationId(8_103),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: submission.idempotencyKey,
      sendOperationId: submission.operationId,
    });

    await expect(
      fixture.store.commitDraftSend(
        mutation,
        fingerprintMailDraftMutation(mutation),
        submission,
        submission.createdAt,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_idempotency_conflict"));
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId),
    ).resolves.toMatchObject({ revision: 0, state: "editing" });
    const database = openDatabase(fixture.cacheRoot);
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM draft_mutations").get()
          ?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
    await fixture.store.close();
  });

  it("preserves exact draft-send replay at capacity but rejects a new handoff", async () => {
    const fixture = await createStore();
    const firstDraft = storedDraftFixture({
      draftId: draftId(8_104),
      to: "first@example.com",
    });
    await fixture.store.createDraft(
      firstDraft,
      fingerprintMailDraftCreate(createInputFromFixture(firstDraft)),
    );
    const firstSubmission = draftSubmissionFixture(firstDraft, {
      operationId: operationId(8_104),
      idempotencyKey: "draft-atomic-capacity-first",
      createdAt: firstDraft.updatedAt + 1,
      updatedAt: firstDraft.updatedAt + 1,
      nextAttemptAt: firstDraft.updatedAt + 1,
    });
    const firstMutation = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: firstDraft.draftId,
      mutationId: draftMutationId(8_104),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: firstSubmission.idempotencyKey,
      sendOperationId: firstSubmission.operationId,
    });
    const firstFingerprint = fingerprintMailDraftMutation(firstMutation);
    await fixture.store.commitDraftSend(
      firstMutation,
      firstFingerprint,
      firstSubmission,
      firstSubmission.createdAt,
    );
    for (
      let index = 1;
      index < MAIL_RESOURCE_LIMITS.maxQueuedSubmissions;
      index += 1
    ) {
      await fixture.store.enqueue(
        submissionFixture({
          operationId: operationId(8_200 + index),
          idempotencyKey: `draft-capacity-seed-${index}`,
        }),
      );
    }
    await expect(fixture.store.countActive()).resolves.toBe(
      MAIL_RESOURCE_LIMITS.maxQueuedSubmissions,
    );
    await expect(
      fixture.store.commitDraftSend(
        firstMutation,
        firstFingerprint,
        firstSubmission,
        firstSubmission.createdAt,
      ),
    ).resolves.toMatchObject({
      replayed: true,
      created: false,
      operationId: firstSubmission.operationId,
    });

    const secondDraft = storedDraftFixture({
      draftId: draftId(8_105),
      to: "second@example.com",
    });
    await fixture.store.createDraft(
      secondDraft,
      fingerprintMailDraftCreate(createInputFromFixture(secondDraft)),
    );
    const secondSubmission = draftSubmissionFixture(secondDraft, {
      operationId: operationId(8_105),
      idempotencyKey: "draft-atomic-capacity-second",
      createdAt: secondDraft.updatedAt + 1,
      updatedAt: secondDraft.updatedAt + 1,
      nextAttemptAt: secondDraft.updatedAt + 1,
    });
    const secondMutation = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: secondDraft.draftId,
      mutationId: draftMutationId(8_105),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: secondSubmission.idempotencyKey,
      sendOperationId: secondSubmission.operationId,
    });
    await expect(
      fixture.store.commitDraftSend(
        secondMutation,
        fingerprintMailDraftMutation(secondMutation),
        secondSubmission,
        secondSubmission.createdAt,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_service_unavailable"));
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, secondDraft.draftId),
    ).resolves.toMatchObject({ revision: 0, state: "editing" });
    await expect(
      fixture.store.readByOperationId(secondSubmission.operationId),
    ).resolves.toBeNull();
    await fixture.store.close();
  }, 15_000);

  it("retains a linked terminal outbox row until its draft tombstone expires", async () => {
    const now = Date.parse("2026-07-20T02:00:00.000Z");
    const fixture = await createStore({ now: () => now });
    const draft = storedDraftFixture({
      draftId: draftId(8_107),
      to: "retained@example.com",
    });
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const submission = draftSubmissionFixture(draft, {
      operationId: operationId(8_107),
      idempotencyKey: "draft-terminal-replay",
      createdAt: draft.updatedAt + 1,
      updatedAt: draft.updatedAt + 1,
      nextAttemptAt: draft.updatedAt + 1,
    });
    const mutation = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: draft.draftId,
      mutationId: draftMutationId(8_107),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: submission.idempotencyKey,
      sendOperationId: submission.operationId,
    });
    const fingerprint = fingerprintMailDraftMutation(mutation);
    await fixture.store.commitDraftSend(
      mutation,
      fingerprint,
      submission,
      submission.createdAt,
    );
    const sent = Object.freeze({
      ...submission,
      version: 1,
      status: "sent" as const,
      attemptCount: 1,
      providerMessageId: "gmail-draft-terminal-replay",
      providerThreadId: "gmail-draft-terminal-thread",
      nextAttemptAt: null,
      updatedAt: submission.updatedAt + 1,
    });
    await expect(
      fixture.store.compareAndSwap(submission.operationId, 0, sent),
    ).resolves.toBe(true);

    const database = openDatabase(fixture.cacheRoot);
    try {
      database.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < 501; index += 1) {
        insertV2Submission(
          database,
          terminalSubmission(20_000 + index, now + index),
        );
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    await fixture.store.enqueue(
      submissionFixture({
        operationId: operationId(21_000),
        idempotencyKey: "draft-terminal-retention-pulse",
      }),
    );
    await expect(
      fixture.store.commitDraftSend(
        mutation,
        fingerprint,
        submission,
        submission.createdAt,
      ),
    ).resolves.toMatchObject({
      replayed: true,
      created: false,
      operationId: submission.operationId,
      submission: { status: "sent" },
    });
    await expect(
      fixture.store.readByOperationId(submission.operationId),
    ).resolves.toEqual(sent);
    await fixture.store.close();
  }, 15_000);

  it("retains terminal send replay after a failed draft is edited", async () => {
    const now = Date.parse("2026-07-20T02:00:00.000Z");
    const fixture = await createStore({ now: () => now });
    const draft = storedDraftFixture({ to: "retained@example.com" });
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const submission = draftSubmissionFixture(draft, {
      operationId: operationId(8_108),
      idempotencyKey: "draft-failed-edited-replay",
      createdAt: draft.updatedAt + 1,
      updatedAt: draft.updatedAt + 1,
      nextAttemptAt: draft.updatedAt + 1,
    });
    const sendMutation = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: draft.draftId,
      mutationId: draftMutationId(8_108),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: submission.idempotencyKey,
      sendOperationId: submission.operationId,
    });
    const sendFingerprint = fingerprintMailDraftMutation(sendMutation);
    await fixture.store.commitDraftSend(
      sendMutation,
      sendFingerprint,
      submission,
      submission.createdAt,
    );
    const failed = Object.freeze({
      ...submission,
      version: 1,
      status: "failed" as const,
      attemptCount: 1,
      lastErrorCode: "mail_send_account_reauth_required" as const,
      nextAttemptAt: null,
      updatedAt: submission.updatedAt + 1,
    });
    await expect(
      fixture.store.compareAndSwap(submission.operationId, 0, failed),
    ).resolves.toBe(true);
    const edit = draftPatchMutation(8_109, 2, { subject: "Edited after failure" });
    await expect(
      fixture.store.applyDraftMutation(
        edit,
        fingerprintMailDraftMutation(edit),
        failed.updatedAt + 1,
      ),
    ).resolves.toMatchObject({ replayed: false, appliedRevision: 3 });

    const database = openDatabase(fixture.cacheRoot);
    try {
      database.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < 501; index += 1) {
        insertV2Submission(
          database,
          terminalSubmission(22_000 + index, now + index),
        );
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    await fixture.store.enqueue(
      submissionFixture({
        operationId: operationId(23_000),
        idempotencyKey: "draft-failed-retention-pulse",
      }),
    );
    await expect(
      fixture.store.commitDraftSend(
        sendMutation,
        sendFingerprint,
        submission,
        submission.createdAt,
      ),
    ).resolves.toMatchObject({
      replayed: true,
      created: false,
      operationId: submission.operationId,
      submission: { status: "failed" },
    });
    await expect(
      fixture.store.readByOperationId(submission.operationId),
    ).resolves.toEqual(failed);
    await fixture.store.close();
  }, 15_000);

  it("enforces 100 drafts, 1 MiB bodies, and the 128 MiB account aggregate", async () => {
    const now = Date.parse("2026-07-20T02:00:00.000Z");
    const fixture = await createStore({ now: () => now });
    const firstActive = storedDraftFixture({ draftId: draftId(1) });
    await fixture.store.createDraft(
      firstActive,
      fingerprintMailDraftCreate(createInputFromFixture(firstActive)),
    );
    await insertDraftDirect(
      fixture.cacheRoot,
      storedDraftFixture({
        draftId: draftId(1_000),
        revision: 2,
        state: "sent",
        to: "",
        subject: "",
        text: "",
        sendIdempotencyKey: "sent-before-active-quota",
        sendOperationId: operationId(1_000),
        createdAt: now,
        updatedAt: now,
        sentAt: now,
      }),
    );
    for (let index = 2; index <= MAIL_DRAFT_LIMITS.maxDraftsPerAccount; index += 1) {
      const draft = storedDraftFixture({ draftId: draftId(index) });
      await fixture.store.createDraft(
        draft,
        fingerprintMailDraftCreate(createInputFromFixture(draft)),
      );
    }
    const overflow = storedDraftFixture({ draftId: draftId(101) });
    await expect(
      fixture.store.createDraft(
        overflow,
        fingerprintMailDraftCreate(createInputFromFixture(overflow)),
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_quota_exceeded"));
    await fixture.store.close();

    const aggregateFixture = await createStore();
    const empty = storedDraftFixture({ text: "" });
    await aggregateFixture.store.createDraft(
      empty,
      fingerprintMailDraftCreate(createInputFromFixture(empty)),
    );
    const database = openDatabase(aggregateFixture.cacheRoot);
    try {
      database
        .prepare(
          `INSERT INTO draft_attachments(
             attachment_id, draft_id, account_id, filename, mime_type, bytes,
             blob_sha256, blob_name, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "draft-attachment-00000000-0000-4000-8000-000000000001",
          empty.draftId,
          FIRST_ACCOUNT,
          "large.bin",
          "application/octet-stream",
          MAIL_DRAFT_LIMITS.maxAccountBytes,
          "a".repeat(64),
          `sha256-${"a".repeat(64)}`,
          empty.createdAt,
        );
    } finally {
      database.close();
    }
    const exact = draftPatchMutation(2, 0, { subject: "same bytes" });
    await expect(
      aggregateFixture.store.applyDraftMutation(
        exact,
        fingerprintMailDraftMutation(exact),
        empty.updatedAt + 1,
      ),
    ).resolves.toMatchObject({ appliedRevision: 1 });
    const tooLarge = draftPatchMutation(3, 1, { text: "x" });
    await expect(
      aggregateFixture.store.applyDraftMutation(
        tooLarge,
        fingerprintMailDraftMutation(tooLarge),
        empty.updatedAt + 2,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_quota_exceeded"));
    await aggregateFixture.store.close();
  }, 15_000);

  it("bounds sent tombstones separately from active draft quota", async () => {
    const now = Date.parse("2026-07-20T03:00:00.000Z");
    const fixture = await createStore({ now: () => now });
    const schemaSeed = storedDraftFixture({ draftId: draftId(3_000) });
    await fixture.store.createDraft(
      schemaSeed,
      fingerprintMailDraftCreate(createInputFromFixture(schemaSeed)),
    );
    const seedDeletion = draftDelete(3_000, schemaSeed.draftId, 0);
    await fixture.store.deleteDraft(
      seedDeletion,
      fingerprintMailDraftDelete(seedDeletion),
      now,
    );
    for (
      let index = 1;
      index <= MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount + 1;
      index += 1
    ) {
      await insertDraftDirect(
        fixture.cacheRoot,
        storedDraftFixture({
          draftId: draftId(index),
          revision: 2,
          state: "sent",
          to: "",
          subject: "",
          text: "",
          sendIdempotencyKey: `sent-tombstone-${index}`,
          sendOperationId: operationId(9_000 + index),
          createdAt: now,
          updatedAt: now,
          sentAt: now,
        }),
      );
    }

    await fixture.store.enqueue(
      submissionFixture({
        operationId: operationId(9_999),
        idempotencyKey: "tombstone-retention-pulse",
      }),
    );
    const database = openDatabase(fixture.cacheRoot);
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM drafts WHERE state = 'sent'",
          )
          .get()?.count,
      ).toBe(MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount);
    } finally {
      database.close();
    }
    const retained = await fixture.store.listDrafts(FIRST_ACCOUNT);
    expect(retained).toHaveLength(
      MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount,
    );
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, draftId(1)),
    ).resolves.toBeNull();
    await expect(
      fixture.store.readDraft(
        FIRST_ACCOUNT,
        draftId(MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount + 1),
      ),
    ).resolves.toMatchObject({ state: "sent" });

    const active = storedDraftFixture({ draftId: draftId(2_000) });
    await expect(
      fixture.store.createDraft(
        active,
        fingerprintMailDraftCreate(createInputFromFixture(active)),
      ),
    ).resolves.toMatchObject({ created: true });
    await fixture.store.close();
  }, 15_000);

  it("keeps 128 replay receipts and rejects a pruned stale mutation", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture();
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const first = draftPatchMutation(1, 0, { subject: "1" });
    for (let index = 1; index <= 129; index += 1) {
      const mutation = draftPatchMutation(index, index - 1, {
        subject: String(index),
      });
      await fixture.store.applyDraftMutation(
        mutation,
        fingerprintMailDraftMutation(mutation),
        draft.updatedAt + index,
      );
    }
    const database = openDatabase(fixture.cacheRoot);
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM draft_mutations").get()?.count,
      ).toBe(MAIL_DRAFT_LIMITS.maxMutationReceiptsPerAccount);
    } finally {
      database.close();
    }
    await expect(
      fixture.store.applyDraftMutation(
        first,
        fingerprintMailDraftMutation(first),
        draft.updatedAt + 200,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_revision_conflict"));
    await fixture.store.close();
  }, 15_000);

  it("maps outbox states atomically and scrubs sent content", async () => {
    const now = Date.parse("2026-07-20T01:00:00.000Z");
    const fixture = await createStore({ now: () => now });
    const draft = storedDraftFixture();
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const operation = submissionFixture({
      operationId: operationId(8_001),
      idempotencyKey: "draft-send-1",
      createdAt: draft.updatedAt + 1,
      updatedAt: draft.updatedAt + 1,
      nextAttemptAt: draft.updatedAt + 1,
    });
    const send = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: draft.draftId,
      mutationId: draftMutationId(1),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: operation.idempotencyKey,
      sendOperationId: operation.operationId,
    });
    await fixture.store.applyDraftMutation(
      send,
      fingerprintMailDraftMutation(send),
      draft.updatedAt + 1,
    );
    const attachmentId =
      "draft-attachment-00000000-0000-4000-8000-000000008001";
    const database = openDatabase(fixture.cacheRoot);
    try {
      database
        .prepare(
          `INSERT INTO draft_attachments(
             attachment_id, draft_id, account_id, filename, mime_type, bytes,
             blob_sha256, blob_name, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attachmentId,
          draft.draftId,
          FIRST_ACCOUNT,
          "evidence.txt",
          "text/plain",
          8,
          "b".repeat(64),
          `sha256-${"b".repeat(64)}`,
          draft.updatedAt,
        );
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM draft_attachments")
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
    await fixture.store.enqueue(operation);

    const sent = Object.freeze({
      ...operation,
      version: 1,
      status: "sent" as const,
      attemptCount: 1,
      providerMessageId: "gmail-message-draft",
      providerThreadId: "gmail-thread-draft",
      nextAttemptAt: null,
      updatedAt: operation.updatedAt + 2,
    });
    await expect(
      fixture.store.compareAndSwap(operation.operationId, 0, sent),
    ).resolves.toBe(true);
    await expect(fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId)).resolves.toMatchObject({
      revision: 2,
      state: "sent",
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      text: "",
      attachments: [],
      sendOperationId: operation.operationId,
      sentAt: sent.updatedAt,
    });
    const scrubbedDatabase = openDatabase(fixture.cacheRoot);
    try {
      expect(
        scrubbedDatabase
          .prepare("SELECT COUNT(*) AS count FROM draft_attachments")
          .get()?.count,
      ).toBe(0);
    } finally {
      scrubbedDatabase.close();
    }
    await fixture.store.close();
  });

  it("maps failed and delivery-unknown outbox transitions back to drafts", async () => {
    const fixture = await createStore();
    const cases = [
      {
        index: 8_011,
        draftIndex: 11,
        status: "failed" as const,
        errorCode: "mail_send_account_reauth_required" as const,
        expectedState: "failed" as const,
      },
      {
        index: 8_012,
        draftIndex: 12,
        status: "delivery_unknown" as const,
        errorCode: "mail_send_service_unavailable" as const,
        expectedState: "delivery_unknown" as const,
      },
    ];

    for (const testCase of cases) {
      const draft = storedDraftFixture({ draftId: draftId(testCase.draftIndex) });
      await fixture.store.createDraft(
        draft,
        fingerprintMailDraftCreate(createInputFromFixture(draft)),
      );
      const operation = submissionFixture({
        operationId: operationId(testCase.index),
        idempotencyKey: `draft-terminal-${testCase.index}`,
        createdAt: draft.updatedAt + 1,
        updatedAt: draft.updatedAt + 1,
        nextAttemptAt: draft.updatedAt + 1,
      });
      const send = validateMailDraftMutationInput({
        accountId: FIRST_ACCOUNT,
        draftId: draft.draftId,
        mutationId: draftMutationId(testCase.index),
        expectedRevision: 0,
        kind: "send",
        sendIdempotencyKey: operation.idempotencyKey,
        sendOperationId: operation.operationId,
      });
      await fixture.store.applyDraftMutation(
        send,
        fingerprintMailDraftMutation(send),
        draft.updatedAt + 1,
      );
      await fixture.store.enqueue(operation);

      const terminal = Object.freeze({
        ...operation,
        version: 1,
        status: testCase.status,
        attemptCount: 1,
        lastErrorCode: testCase.errorCode,
        nextAttemptAt: null,
        updatedAt: operation.updatedAt + 2,
      });
      await expect(
        fixture.store.compareAndSwap(operation.operationId, 0, terminal),
      ).resolves.toBe(true);
      await expect(
        fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId),
      ).resolves.toMatchObject({
        revision: 2,
        state: testCase.expectedState,
        to: draft.to,
        subject: draft.subject,
        text: draft.text,
        sendOperationId: operation.operationId,
        sendErrorCode: testCase.errorCode,
        sentAt: null,
      });
    }
    await fixture.store.close();
  });

  it("rejects a send operation reused by a different draft", async () => {
    const fixture = await createStore();
    const first = storedDraftFixture({ draftId: draftId(21) });
    const second = storedDraftFixture({ draftId: draftId(22) });
    for (const draft of [first, second]) {
      await fixture.store.createDraft(
        draft,
        fingerprintMailDraftCreate(createInputFromFixture(draft)),
      );
    }
    const sharedOperationId = operationId(8_021);
    const firstSend = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: first.draftId,
      mutationId: draftMutationId(21),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: "draft-send-first",
      sendOperationId: sharedOperationId,
    });
    await fixture.store.applyDraftMutation(
      firstSend,
      fingerprintMailDraftMutation(firstSend),
      first.updatedAt + 1,
    );
    const secondSend = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: second.draftId,
      mutationId: draftMutationId(22),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: "draft-send-second",
      sendOperationId: sharedOperationId,
    });
    await expect(
      fixture.store.applyDraftMutation(
        secondSend,
        fingerprintMailDraftMutation(secondSend),
        second.updatedAt + 1,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_idempotency_conflict"));
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, second.draftId),
    ).resolves.toMatchObject({ revision: 0, state: "editing" });
    await fixture.store.close();
  });

  it("binds outbox triggers to both operation and idempotency identity", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture({ draftId: draftId(23) });
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const operation = submissionFixture({
      operationId: operationId(8_023),
      idempotencyKey: "outbox-wrong-key",
      createdAt: draft.updatedAt + 1,
      updatedAt: draft.updatedAt + 1,
      nextAttemptAt: draft.updatedAt + 1,
    });
    const send = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: draft.draftId,
      mutationId: draftMutationId(23),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: "draft-expected-key",
      sendOperationId: operation.operationId,
    });
    await fixture.store.applyDraftMutation(
      send,
      fingerprintMailDraftMutation(send),
      draft.updatedAt + 1,
    );
    await fixture.store.enqueue(operation);
    const sent = Object.freeze({
      ...operation,
      version: 1,
      status: "sent" as const,
      attemptCount: 1,
      providerMessageId: "gmail-message-wrong-key",
      providerThreadId: "gmail-thread-wrong-key",
      nextAttemptAt: null,
      updatedAt: operation.updatedAt + 2,
    });
    await expect(
      fixture.store.compareAndSwap(operation.operationId, 0, sent),
    ).resolves.toBe(true);
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId),
    ).resolves.toMatchObject({
      revision: 1,
      state: "submitting",
      to: draft.to,
      subject: draft.subject,
      text: draft.text,
      sentAt: null,
    });
    await fixture.store.close();
  });

  it("shares the account invalidation and recovery boundary", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture();
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );

    await fixture.store.invalidateAccount(FIRST_ACCOUNT);
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId),
    ).rejects.toEqual(new MailDraftError("mail_draft_service_unavailable"));
    await fixture.store.restoreInvalidatedAccount(FIRST_ACCOUNT);
    await expect(
      fixture.store.readDraft(FIRST_ACCOUNT, draft.draftId),
    ).resolves.toEqual(draft);
    await fixture.store.close();
  });

  it("rolls back an outbox transition when the linked draft update aborts", async () => {
    const fixture = await createStore();
    const draft = storedDraftFixture();
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const operation = submissionFixture({
      operationId: operationId(8_002),
      idempotencyKey: "draft-send-rollback",
      createdAt: draft.updatedAt + 1,
      updatedAt: draft.updatedAt + 1,
      nextAttemptAt: draft.updatedAt + 1,
    });
    const send = validateMailDraftMutationInput({
      accountId: FIRST_ACCOUNT,
      draftId: draft.draftId,
      mutationId: draftMutationId(2),
      expectedRevision: 0,
      kind: "send",
      sendIdempotencyKey: operation.idempotencyKey,
      sendOperationId: operation.operationId,
    });
    await fixture.store.applyDraftMutation(
      send,
      fingerprintMailDraftMutation(send),
      draft.updatedAt + 1,
    );
    await fixture.store.enqueue(operation);
    const database = openDatabase(fixture.cacheRoot);
    try {
      database.exec(`CREATE TRIGGER reject_draft_update
        BEFORE UPDATE ON drafts BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    } finally {
      database.close();
    }
    const sending = Object.freeze({
      ...operation,
      version: 1,
      status: "sending" as const,
      attemptCount: 1,
      lease: Object.freeze({
        attemptId: "attempt-00000000-0000-4000-8000-000000008002",
        expiresAt: operation.updatedAt + 60_000,
        deliveryRisk: false,
      }),
      nextAttemptAt: null,
      updatedAt: operation.updatedAt + 2,
    });
    await expect(
      fixture.store.compareAndSwap(operation.operationId, 0, sending),
    ).rejects.toEqual(new MailSendError("mail_send_service_unavailable"));
    await expect(fixture.store.readByOperationId(operation.operationId)).resolves.toEqual(
      operation,
    );
    await fixture.store.close();
  });

  it("deletes by revision and prunes sent tombstones only after 24 hours", async () => {
    let now = Date.parse("2026-07-20T00:00:00.000Z");
    const fixture = await createStore({ now: () => now });
    const first = storedDraftFixture({ createdAt: now, updatedAt: now });
    await fixture.store.createDraft(
      first,
      fingerprintMailDraftCreate(createInputFromFixture(first)),
    );
    const staleDeletion = draftDelete(2, first.draftId, 1);
    await expect(
      fixture.store.deleteDraft(
        staleDeletion,
        fingerprintMailDraftDelete(staleDeletion),
        now,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_revision_conflict"));
    const deletion = draftDelete(3, first.draftId, 0);
    await expect(
      fixture.store.deleteDraft(
        deletion,
        fingerprintMailDraftDelete(deletion),
        now,
      ),
    ).resolves.toEqual({ replayed: false });
    await expect(
      fixture.store.deleteDraft(
        deletion,
        fingerprintMailDraftDelete(deletion),
        now,
      ),
    ).resolves.toEqual({ replayed: true });
    await expect(fixture.store.readDraft(FIRST_ACCOUNT, first.draftId)).resolves.toBeNull();

    const sent = storedDraftFixture({
      draftId: draftId(2),
      revision: 2,
      state: "sent",
      to: "",
      subject: "",
      text: "",
      sendIdempotencyKey: "sent-tombstone",
      sendOperationId: operationId(8_003),
      createdAt: now,
      updatedAt: now,
      sentAt: now,
    });
    await insertDraftDirect(fixture.cacheRoot, sent);
    now += MAIL_DRAFT_LIMITS.sentTombstoneMs;
    await expect(fixture.store.readDraft(FIRST_ACCOUNT, sent.draftId)).resolves.toEqual(sent);
    now += 1;
    await expect(fixture.store.readDraft(FIRST_ACCOUNT, sent.draftId)).resolves.toBeNull();
    await fixture.store.close();
  });

  it("replays an exact delete after restart and rejects a changed retry", async () => {
    const now = Date.parse("2026-07-20T00:00:00.000Z");
    const fixture = await createStore({ now: () => now });
    const draft = storedDraftFixture({ createdAt: now, updatedAt: now });
    await fixture.store.createDraft(
      draft,
      fingerprintMailDraftCreate(createInputFromFixture(draft)),
    );
    const deletion = draftDelete(4, draft.draftId, 0);
    await expect(
      fixture.store.deleteDraft(
        deletion,
        fingerprintMailDraftDelete(deletion),
        now,
      ),
    ).resolves.toEqual({ replayed: false });
    await fixture.store.close();

    const reopened = new SqliteMailSendStore({
      cacheRoot: fixture.cacheRoot,
      now: () => now,
    });
    await reopened.initialize();
    await expect(
      reopened.deleteDraft(
        deletion,
        fingerprintMailDraftDelete(deletion),
        now,
      ),
    ).resolves.toEqual({ replayed: true });
    const changed = { ...deletion, expectedRevision: 1 };
    await expect(
      reopened.deleteDraft(
        changed,
        fingerprintMailDraftDelete(changed),
        now,
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_idempotency_conflict"));
    await expect(
      reopened.readDraft(FIRST_ACCOUNT, draft.draftId),
    ).resolves.toBeNull();
    await reopened.close();
  });
});

async function createStore(
  options: {
    readonly now?: () => number;
    readonly onIntegrityCheck?: (accountId: string) => void;
  } = {},
): Promise<{
  readonly store: SqliteMailSendStore;
  readonly cacheRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-outbox-"));
  roots.push(root);
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot, { mode: 0o700 });
  const store = new SqliteMailSendStore({ cacheRoot, ...options });
  await store.initialize();
  return { store, cacheRoot };
}

async function createLegacyDatabase(
  cacheRoot: string,
  submission: StoredMailSendSubmission,
  serializedOverride?: string,
): Promise<void> {
  const accountDirectory = path.join(cacheRoot, submission.accountId);
  await mkdir(accountDirectory, { mode: 0o700 });
  const filePath = path.join(accountDirectory, "outbox.sqlite3");
  await writeFile(filePath, "", { flag: "wx", mode: 0o600 });
  const database = new DatabaseSync(filePath);
  try {
    database.exec(`
      CREATE TABLE metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        account_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE outbox (
        operation_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version >= 0),
        submission_json TEXT NOT NULL,
        UNIQUE(account_id, idempotency_key)
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    database
      .prepare("INSERT INTO metadata(singleton, account_id) VALUES (1, ?)")
      .run(submission.accountId);
    const legacy: Record<string, unknown> = { ...submission };
    delete legacy.nextAttemptAt;
    database
      .prepare(
        `INSERT INTO outbox(
           operation_id, account_id, idempotency_key,
           request_fingerprint, version, submission_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        submission.operationId,
        submission.accountId,
        submission.idempotencyKey,
        submission.requestFingerprint,
        submission.version,
        serializedOverride ?? JSON.stringify(legacy),
      );
  } finally {
    database.close();
  }
}

function openDatabase(
  cacheRoot: string,
  accountId = FIRST_ACCOUNT,
): DatabaseSync {
  return new DatabaseSync(path.join(cacheRoot, accountId, "outbox.sqlite3"));
}

function insertV2Submission(
  database: DatabaseSync,
  submission: StoredMailSendSubmission,
): void {
  database
    .prepare(
      `INSERT INTO outbox(
         operation_id, account_id, idempotency_key, request_fingerprint,
         version, status, runnable_at, created_at, updated_at, submission_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      submission.operationId,
      submission.accountId,
      submission.idempotencyKey,
      submission.requestFingerprint,
      submission.version,
      submission.status,
      submission.nextAttemptAt ?? submission.lease?.expiresAt ?? null,
      submission.createdAt,
      submission.updatedAt,
      JSON.stringify(submission),
    );
}

function insertCorruptV2Row(
  database: DatabaseSync,
  input: {
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly status: "queued" | "sent";
    readonly runnableAt: number | null;
    readonly createdAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO outbox(
         operation_id, account_id, idempotency_key, request_fingerprint,
         version, status, runnable_at, created_at, updated_at, submission_json
       ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.operationId,
      FIRST_ACCOUNT,
      input.idempotencyKey,
      "c".repeat(64),
      input.status,
      input.runnableAt,
      input.createdAt,
      input.createdAt,
      "{not-json",
    );
}

function storedDraftFixture(
  override: Partial<StoredMailDraft> = {},
): StoredMailDraft {
  const timestamp = Date.parse("2026-07-20T01:00:00.000Z");
  return Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    draftId: draftId(1),
    accountId: FIRST_ACCOUNT,
    revision: 0,
    state: "editing" as const,
    intent: Object.freeze({ kind: "compose" as const }),
    threading: null,
    to: "Friend <friend@",
    cc: "",
    bcc: "",
    subject: "Draft subject",
    text: "Draft body",
    attachments: Object.freeze([]),
    sendIdempotencyKey: null,
    sendOperationId: null,
    sendErrorCode: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    sentAt: null,
    ...override,
  });
}

function createInputFromFixture(draft: StoredMailDraft) {
  return validateMailDraftCreateInput({
    draftId: draft.draftId,
    accountId: draft.accountId,
    intent: draft.intent,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.text,
  });
}

function draftPatchMutation(
  index: number,
  expectedRevision: number,
  patch: Record<string, string>,
) {
  return validateMailDraftMutationInput({
    accountId: FIRST_ACCOUNT,
    draftId: draftId(1),
    mutationId: draftMutationId(index),
    expectedRevision,
    kind: "patch",
    patch,
  });
}

function draftDelete(
  index: number,
  targetDraftId: string,
  expectedRevision: number,
  accountId = FIRST_ACCOUNT,
) {
  return {
    accountId,
    draftId: targetDraftId,
    mutationId: draftMutationId(index),
    expectedRevision,
  } as const;
}

function draftId(index: number): string {
  return `draft-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function draftMutationId(index: number): string {
  return `draft-mutation-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function insertDraftDirect(
  cacheRoot: string,
  draft: StoredMailDraft,
): Promise<void> {
  const database = openDatabase(cacheRoot, draft.accountId);
  try {
    database
      .prepare(
        `INSERT INTO drafts(
           draft_id, account_id, revision, state, intent, source_message_id,
           threading_json, to_text, cc_text, bcc_text, subject, text_body,
           body_bytes, create_fingerprint, send_idempotency_key,
           send_operation_id, send_error_code,
           created_at, updated_at, sent_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.draftId,
        draft.accountId,
        draft.revision,
        draft.state,
        draft.intent.kind,
        draft.intent.kind === "compose" ? null : draft.intent.sourceMessageId,
        null,
        draft.to,
        draft.cc,
        draft.bcc,
        draft.subject,
        draft.text,
        Buffer.byteLength(draft.text),
        "c".repeat(64),
        draft.sendIdempotencyKey,
        draft.sendOperationId,
        draft.sendErrorCode,
        draft.createdAt,
        draft.updatedAt,
        draft.sentAt,
      );
  } finally {
    database.close();
  }
}

function terminalSubmission(
  index: number,
  timestamp: number,
): StoredMailSendSubmission {
  return submissionFixture({
    operationId: operationId(index),
    idempotencyKey: `terminal-${index}`,
    status: "sent",
    attemptCount: 1,
    providerMessageId: `gmail-message-${index}`,
    providerThreadId: `gmail-thread-${index}`,
    nextAttemptAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function submissionFixture(
  override: Partial<StoredMailSendSubmission> = {},
): StoredMailSendSubmission {
  const raw = Buffer.from(
    "From: me@example.com\r\nTo: friend@example.net\r\n\r\nBody\r\n",
    "utf8",
  );
  return Object.freeze({
    version: 0,
    operationId: "send-00000000-0000-4000-8000-000000000001",
    idempotencyKey: "compose-action-1",
    requestFingerprint: "a".repeat(64),
    accountId: FIRST_ACCOUNT,
    providerKind: "gmail",
    status: "queued",
    attemptCount: 0,
    lease: null,
    message: Object.freeze({
      messageId: "<brain.1@example.com>",
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
    nextAttemptAt: Date.parse("2026-07-15T10:00:00.000Z"),
    createdAt: Date.parse("2026-07-15T10:00:00.000Z"),
    updatedAt: Date.parse("2026-07-15T10:00:00.000Z"),
    ...override,
  });
}

function draftSubmissionFixture(
  draft: StoredMailDraft,
  override: Partial<StoredMailSendSubmission> = {},
): StoredMailSendSubmission {
  const seed = submissionFixture(override);
  const replyMode =
    draft.intent.kind === "reply" || draft.intent.kind === "reply_all";
  const threading = draft.threading;
  if (replyMode && (threading === null || threading.rfcMessageId === null)) {
    throw new Error("reply draft fixture requires threading");
  }
  const input = validateMailSendInput({
    accountId: draft.accountId,
    idempotencyKey: seed.idempotencyKey,
    mode: replyMode ? "reply" : "compose",
    to: fixtureRecipients(draft.to),
    cc: fixtureRecipients(draft.cc),
    bcc: fixtureRecipients(draft.bcc),
    subject: draft.subject,
    text: draft.text,
    replyToMessageId: replyMode ? draft.intent.sourceMessageId : null,
  });
  const built = buildOutboundRfc2822({
    from: seed.message.envelope.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    messageId: seed.message.messageId,
    createdAt: seed.createdAt,
    reply:
      threading === null
        ? null
        : {
            inReplyTo: threading.rfcMessageId!,
            references: threading.references,
          },
  });
  try {
    return Object.freeze({
      ...seed,
      requestFingerprint: fingerprintMailSendInput(input),
      message: Object.freeze({
        messageId: built.messageId,
        envelope: built.envelope,
        providerThreadId: threading?.providerThreadId ?? null,
        rawRfc2822Base64Url: built.rawRfc2822.toString("base64url"),
        rawRfc2822Bytes: built.rawRfc2822.byteLength,
        rawRfc2822Sha256: createHash("sha256")
          .update(built.rawRfc2822)
          .digest("hex"),
      }),
    });
  } finally {
    built.rawRfc2822.fill(0);
  }
}

function fixtureRecipients(value: string): readonly string[] {
  const trimmed = value.trim();
  return trimmed.length === 0
    ? Object.freeze([])
    : Object.freeze(value.split(",").map((recipient) => recipient.trim()));
}

function operationId(index: number): string {
  return `send-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
