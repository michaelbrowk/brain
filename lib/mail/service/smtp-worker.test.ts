import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ImapAppendHooks,
  SmtpSubmissionHooks,
  SmtpSubmissionOutcome,
} from "../ports";
import {
  claimSubmission,
  markSubmissionDeliveryRisk,
  SMTP_MAX_ATTEMPTS,
  type SubmissionRecord,
} from "../send-state";
import type { StoredMailSendSubmission } from "./outbound";
import { SqliteMailSendStore } from "./outbound-store";
import {
  MailSmtpSubmissionWorker,
  type MailSentCopyAppendRequest,
  type MailSentCopyAppendResult,
  type MailSentCopyFindRequest,
  type MailSentCopyLookup,
  type MailSentCopyPort,
  type MailSmtpSubmissionAttempt,
  type MailSmtpSubmissionTransport,
} from "./smtp-worker";

const ACCOUNT = `account-a${"7".repeat(32)}`;
const ACCOUNT_B = `account-a${"8".repeat(32)}`;
const START_AT = Date.parse("2026-07-16T09:00:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

class FakeSmtpTransport implements MailSmtpSubmissionTransport {
  readonly calls: Array<
    Pick<MailSmtpSubmissionAttempt, "accountId" | "operationId" | "attemptId">
  > = [];
  private next = 0;

  constructor(private readonly outcomes: readonly SmtpSubmissionOutcome[]) {}

  async submit(
    attempt: MailSmtpSubmissionAttempt,
    hooks: SmtpSubmissionHooks,
  ): Promise<SmtpSubmissionOutcome> {
    this.calls.push({
      accountId: attempt.accountId,
      operationId: attempt.operationId,
      attemptId: attempt.attemptId,
    });
    const outcome = this.outcomes[this.next];
    if (!outcome) throw new Error("smtp transport script exhausted");
    this.next += 1;
    if (
      outcome.kind === "accepted" ||
      (outcome.kind === "transport_error" && outcome.deliveryRisk === "possible")
    ) {
      await hooks.beforeData();
    }
    return outcome;
  }
}

class FakeSentCopyPort implements MailSentCopyPort {
  readonly findCalls: MailSentCopyFindRequest[] = [];
  readonly appendCalls: MailSentCopyAppendRequest[] = [];
  private nextFind = 0;
  private nextAppend = 0;

  constructor(
    private readonly findResults: readonly MailSentCopyLookup[],
    private readonly appendResults: readonly MailSentCopyAppendResult[] = [],
  ) {}

  async findByMessageId(
    request: MailSentCopyFindRequest,
  ): Promise<MailSentCopyLookup> {
    this.findCalls.push(request);
    const result = this.findResults[this.nextFind];
    if (!result) throw new Error("sent copy find script exhausted");
    this.nextFind += 1;
    return result;
  }

  async append(
    request: MailSentCopyAppendRequest,
    hooks: ImapAppendHooks,
  ): Promise<MailSentCopyAppendResult> {
    this.appendCalls.push({ ...request, raw: Buffer.from(request.raw) });
    const result = this.appendResults[this.nextAppend];
    if (!result) throw new Error("sent copy append script exhausted");
    this.nextAppend += 1;
    if (
      result.outcome.kind === "stored" ||
      result.outcome.kind === "stored_without_uid" ||
      (result.outcome.kind === "transport_error" &&
        result.outcome.deliveryRisk === "possible")
    ) {
      await hooks.beforeLiteral();
    }
    return result;
  }
}

interface Fixture {
  readonly store: SqliteMailSendStore;
  readonly submission: StoredMailSendSubmission;
  readonly clock: { now: number };
  worker(
    transport: MailSmtpSubmissionTransport,
    sentCopy: MailSentCopyPort,
    accountLifecycle?: ConstructorParameters<
      typeof MailSmtpSubmissionWorker
    >[0]["accountLifecycle"],
  ): MailSmtpSubmissionWorker;
  state(): Promise<SubmissionRecord>;
  outbox(): Promise<StoredMailSendSubmission>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-smtp-worker-"));
  roots.push(root);
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot, { mode: 0o700 });
  const clock = { now: START_AT };
  const store = new SqliteMailSendStore({ cacheRoot, now: () => clock.now });
  await store.initialize();
  const submission = imapSubmission();
  await store.enqueue(submission);
  return {
    store,
    submission,
    clock,
    worker: (transport, sentCopy, accountLifecycle) =>
      new MailSmtpSubmissionWorker({
        store,
        transport,
        sentCopy,
        ...(accountLifecycle ? { accountLifecycle } : {}),
        now: () => clock.now,
      }),
    state: async () => {
      const state = await store.readSmtpSubmissionState(
        submission.accountId,
        submission.operationId,
      );
      if (state === null) throw new Error("missing smtp submission state");
      return state;
    },
    outbox: async () => {
      const row = await store.readByOperationId(submission.operationId);
      if (row === null) throw new Error("missing outbox row");
      return row;
    },
  };
}

function imapSubmission(): StoredMailSendSubmission {
  const raw = Buffer.from(
    "From: me@example.com\r\nTo: friend@example.net\r\n\r\nWorker body\r\n",
    "utf8",
  );
  return Object.freeze({
    version: 0,
    operationId: "send-00000000-0000-4000-8000-000000000701",
    idempotencyKey: "smtp-worker-op-1",
    requestFingerprint: "c".repeat(64),
    accountId: ACCOUNT,
    providerKind: "imap" as const,
    status: "queued" as const,
    attemptCount: 0,
    lease: null,
    message: Object.freeze({
      messageId: "<brain.worker.1@example.com>",
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
    nextAttemptAt: START_AT,
    createdAt: START_AT,
    updatedAt: START_AT,
  });
}

function accepted(): SmtpSubmissionOutcome {
  return Object.freeze({
    kind: "accepted" as const,
    responseCode: 250,
    acceptedRecipients: ["friend@example.net"],
    rejectedRecipients: [],
  });
}

describe("mail SMTP submission worker", () => {
  it("reports readiness only while the worker is started and healthy", async () => {
    const fixture = await createFixture();
    const worker = fixture.worker(
      new FakeSmtpTransport([accepted()]),
      new FakeSentCopyPort([]),
    );
    expect(worker.isReady()).toBe(false);
    await worker.start();
    expect(worker.isReady()).toBe(true);
    await worker.stop();
    expect(worker.isReady()).toBe(false);
    await fixture.store.close();
  });

  it("invalidating account A never aborts account B after its DATA barrier", async () => {
    const fixture = await createFixture();
    const base = imapSubmission();
    const accountB = Object.freeze({
      ...base,
      accountId: ACCOUNT_B,
      operationId: "send-00000000-0000-4000-8000-000000000700",
      idempotencyKey: "smtp-worker-account-b",
      requestFingerprint: "d".repeat(64),
    });
    await fixture.store.enqueue(accountB);
    let entered!: () => void;
    const enteredData = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accountBSignals: AbortSignal[] = [];
    const transport: MailSmtpSubmissionTransport = {
      async submit(attempt, hooks) {
        if (attempt.accountId !== ACCOUNT_B) return accepted();
        accountBSignals.push(attempt.signal);
        await hooks.beforeData();
        entered();
        await released;
        return accepted();
      },
    };
    const worker = fixture.worker(transport, new FakeSentCopyPort([]));

    const pass = worker.runNow();
    await enteredData;
    await worker.invalidateAccount(ACCOUNT);
    expect(accountBSignals[0]?.aborted).toBe(false);
    release();
    await pass;
    await expect(
      fixture.store.readSmtpSubmissionState(ACCOUNT_B, accountB.operationId),
    ).resolves.toMatchObject({ phase: "sent_copy_pending" });
    await worker.restoreInvalidatedAccount(ACCOUNT);
    await fixture.store.close();
  });

  it("submits, appends the Sent copy, and settles the operation as sent", async () => {
    const fixture = await createFixture();
    const transport = new FakeSmtpTransport([accepted()]);
    const sentCopy = new FakeSentCopyPort(
      [{ kind: "absent", mailboxId: "sent" }],
      [
        {
          mailboxId: "sent",
          outcome: { kind: "stored", uidValidity: "31", uid: 88 },
        },
      ],
    );
    const worker = fixture.worker(transport, sentCopy);

    await worker.runNow();
    await expect(fixture.state()).resolves.toMatchObject({
      phase: "sent_copy_pending",
    });
    await expect(fixture.outbox()).resolves.toMatchObject({ status: "sent" });

    await worker.runNow();
    const state = await fixture.state();
    expect(state.phase).toBe("sent");
    expect(state.sentCopy).toEqual({
      mailboxId: "sent",
      uidValidity: "31",
      uid: 88,
    });
    expect(transport.calls).toHaveLength(1);
    expect(sentCopy.appendCalls).toHaveLength(1);
    expect(sentCopy.appendCalls[0]?.raw.toString("utf8")).toContain(
      "Worker body",
    );
    await fixture.store.close();
  });

  it("avoids a duplicate Sent copy when the Message-ID already exists", async () => {
    const fixture = await createFixture();
    const transport = new FakeSmtpTransport([accepted()]);
    const sentCopy = new FakeSentCopyPort([
      { kind: "found", mailboxId: "sent", uidValidity: "31", uid: 902 },
    ]);
    const worker = fixture.worker(transport, sentCopy);

    await worker.runNow();
    await worker.runNow();
    const state = await fixture.state();
    expect(state.phase).toBe("sent");
    expect(state.sentCopy).toEqual({
      mailboxId: "sent",
      uidValidity: "31",
      uid: 902,
    });
    expect(sentCopy.appendCalls).toHaveLength(0);
    await fixture.store.close();
  });

  it("retries transient rejections with backoff and stops at the attempt cap", async () => {
    const fixture = await createFixture();
    const transport = new FakeSmtpTransport(
      Array.from({ length: SMTP_MAX_ATTEMPTS }, () =>
        Object.freeze({
          kind: "rejected" as const,
          responseCode: 450,
          retryable: true,
          errorCode: "smtp_recipients_deferred",
        }),
      ),
    );
    const worker = fixture.worker(transport, new FakeSentCopyPort([]));

    for (let attempt = 1; attempt <= SMTP_MAX_ATTEMPTS; attempt += 1) {
      await worker.runNow();
      const state = await fixture.state();
      expect(state.attemptCount).toBe(attempt);
      if (attempt < SMTP_MAX_ATTEMPTS) {
        expect(state.phase).toBe("retry_wait");
        expect(state.retryAt).toBeGreaterThan(fixture.clock.now);
        fixture.clock.now = state.retryAt!;
      } else {
        expect(state.phase).toBe("failed");
        expect(state.lastErrorCode).toBe("smtp_attempts_exhausted");
      }
    }
    expect(transport.calls).toHaveLength(SMTP_MAX_ATTEMPTS);
    await expect(fixture.outbox()).resolves.toMatchObject({
      status: "failed",
      lastErrorCode: "mail_send_service_unavailable",
    });

    // A terminal operation is no longer runnable for any worker.
    await worker.runNow();
    expect(transport.calls).toHaveLength(SMTP_MAX_ATTEMPTS);
    await fixture.store.close();
  });

  it("fails permanently on a 5xx rejection after one attempt", async () => {
    const fixture = await createFixture();
    const transport = new FakeSmtpTransport([
      Object.freeze({
        kind: "rejected" as const,
        responseCode: 550,
        retryable: false,
        errorCode: "smtp_message_rejected",
      }),
    ]);
    const worker = fixture.worker(transport, new FakeSentCopyPort([]));

    await worker.runNow();
    await expect(fixture.state()).resolves.toMatchObject({
      phase: "failed",
      attemptCount: 1,
      lastErrorCode: "smtp_message_rejected",
    });
    await expect(fixture.outbox()).resolves.toMatchObject({
      status: "failed",
      lastErrorCode: "mail_send_request_invalid",
    });
    await fixture.store.close();
  });

  it("marks the account reauth_required before settling definite AUTH failure", async () => {
    const fixture = await createFixture();
    const lifecycleCalls: string[] = [];
    const worker = fixture.worker(
      new FakeSmtpTransport([
        Object.freeze({
          kind: "rejected" as const,
          responseCode: 535,
          retryable: false,
          errorCode: "smtp_auth_failed",
        }),
      ]),
      new FakeSentCopyPort([]),
      {
        markSmtpReauthRequired: async (accountId) => {
          lifecycleCalls.push(accountId);
          await expect(fixture.state()).resolves.toMatchObject({
            phase: "submitting",
          });
        },
      },
    );

    await worker.runNow();
    expect(lifecycleCalls).toEqual([ACCOUNT]);
    await expect(fixture.state()).resolves.toMatchObject({
      phase: "failed",
      lastErrorCode: "smtp_auth_failed",
    });
    await expect(fixture.outbox()).resolves.toMatchObject({
      status: "failed",
      lastErrorCode: "mail_send_account_reauth_required",
    });
    await fixture.store.close();
  });

  it("never auto-retries an ambiguous post-DATA failure", async () => {
    const fixture = await createFixture();
    const transport = new FakeSmtpTransport([
      Object.freeze({
        kind: "transport_error" as const,
        deliveryRisk: "possible" as const,
        errorCode: "smtp_connection_timeout",
      }),
    ]);
    const sentCopy = new FakeSentCopyPort([
      { kind: "unavailable", errorCode: "sent_copy_lookup_failed" },
    ]);
    const worker = fixture.worker(transport, sentCopy);

    await worker.runNow();
    await expect(fixture.state()).resolves.toMatchObject({
      phase: "delivery_unknown",
    });
    await expect(fixture.outbox()).resolves.toMatchObject({
      status: "delivery_unknown",
      lastErrorCode: "mail_send_service_unavailable",
    });

    fixture.clock.now += 24 * 60 * 60 * 1_000;
    await worker.runNow();
    expect(transport.calls).toHaveLength(1);
    await expect(fixture.state()).resolves.toMatchObject({
      phase: "delivery_unknown",
    });
    await fixture.store.close();
  });

  it("reclaims an expired lease and never double-sends after the DATA barrier", async () => {
    const fixture = await createFixture();
    const state = await fixture.state();

    // A crashed worker left an expired risk-marked lease behind.
    const crashedClaim = claimSubmission(state, {
      attemptId: "attempt-00000000-0000-4000-8000-000000000777",
      now: fixture.clock.now,
      leaseMs: 60_000,
    });
    await fixture.store.compareAndSwapSmtpSubmissionState(
      ACCOUNT,
      fixture.submission.operationId,
      state.version,
      crashedClaim,
    );
    const risked = markSubmissionDeliveryRisk(crashedClaim, {
      attemptId: "attempt-00000000-0000-4000-8000-000000000777",
      now: fixture.clock.now + 1,
    });
    await fixture.store.compareAndSwapSmtpSubmissionState(
      ACCOUNT,
      fixture.submission.operationId,
      crashedClaim.version,
      risked,
    );

    fixture.clock.now += 61_000;
    const transport = new FakeSmtpTransport([]);
    const sentCopy = new FakeSentCopyPort([
      { kind: "unavailable", errorCode: "sent_copy_lookup_failed" },
    ]);
    const worker = fixture.worker(transport, sentCopy);
    await worker.runNow();

    await expect(fixture.state()).resolves.toMatchObject({
      phase: "delivery_unknown",
      lastErrorCode: "worker_lease_expired_after_data",
    });
    expect(transport.calls).toHaveLength(0);
    await fixture.store.close();
  });

  it("reclaims an expired pre-DATA lease into a safe retry", async () => {
    const fixture = await createFixture();
    const state = await fixture.state();
    const crashedClaim = claimSubmission(state, {
      attemptId: "attempt-00000000-0000-4000-8000-000000000778",
      now: fixture.clock.now,
      leaseMs: 60_000,
    });
    await fixture.store.compareAndSwapSmtpSubmissionState(
      ACCOUNT,
      fixture.submission.operationId,
      state.version,
      crashedClaim,
    );

    fixture.clock.now += 61_000;
    const transport = new FakeSmtpTransport([accepted()]);
    const worker = fixture.worker(
      transport,
      new FakeSentCopyPort([{ kind: "absent", mailboxId: "sent" }]),
    );
    await worker.runNow();
    const recovered = await fixture.state();
    expect(recovered.phase).toBe("retry_wait");
    expect(transport.calls).toHaveLength(0);

    fixture.clock.now = recovered.retryAt!;
    await worker.runNow();
    await expect(fixture.state()).resolves.toMatchObject({
      phase: "sent_copy_pending",
      attemptCount: 2,
    });
    expect(transport.calls).toHaveLength(1);
    await fixture.store.close();
  });

  it("lets exactly one of two concurrent workers claim an operation", async () => {
    const fixture = await createFixture();
    const transport = new FakeSmtpTransport([accepted(), accepted()]);
    const sentCopy = new FakeSentCopyPort(
      [
        { kind: "absent", mailboxId: "sent" },
        { kind: "absent", mailboxId: "sent" },
      ],
      [
        {
          mailboxId: "sent",
          outcome: { kind: "stored", uidValidity: "31", uid: 88 },
        },
        {
          mailboxId: "sent",
          outcome: { kind: "stored", uidValidity: "31", uid: 89 },
        },
      ],
    );
    const first = fixture.worker(transport, sentCopy);
    const second = fixture.worker(transport, sentCopy);

    await Promise.all([first.runNow(), second.runNow()]);
    expect(transport.calls).toHaveLength(1);
    await expect(fixture.state()).resolves.toMatchObject({
      phase: "sent_copy_pending",
      attemptCount: 1,
    });
    await fixture.store.close();
  });

  it("reconciles sent_copy_unknown by Message-ID in either direction", async () => {
    const foundFixture = await createFixture();
    const foundTransport = new FakeSmtpTransport([accepted()]);
    const foundWorker = foundFixture.worker(
      foundTransport,
      new FakeSentCopyPort(
        [
          { kind: "absent", mailboxId: "sent" },
          { kind: "found", mailboxId: "sent", uidValidity: "31", uid: 55 },
        ],
        [
          {
            mailboxId: "sent",
            outcome: {
              kind: "transport_error",
              deliveryRisk: "possible",
              errorCode: "sent_copy_append_failed",
            },
          },
        ],
      ),
    );
    await foundWorker.runNow();
    // The second pass first drives the APPEND into sent_copy_unknown, then the
    // same-pass reconciliation slice resolves the ambiguity by Message-ID.
    await foundWorker.runNow();
    const reconciled = await foundFixture.state();
    expect(reconciled.phase).toBe("sent");
    expect(reconciled.sentCopy).toEqual({
      mailboxId: "sent",
      uidValidity: "31",
      uid: 55,
    });
    await foundFixture.store.close();

    const absentFixture = await createFixture();
    const absentWorker = absentFixture.worker(
      new FakeSmtpTransport([accepted()]),
      new FakeSentCopyPort(
        [
          { kind: "absent", mailboxId: "sent" },
          { kind: "absent", mailboxId: "sent" },
        ],
        [
          {
            mailboxId: "sent",
            outcome: {
              kind: "transport_error",
              deliveryRisk: "possible",
              errorCode: "sent_copy_append_failed",
            },
          },
        ],
      ),
    );
    await absentWorker.runNow();
    await absentWorker.runNow();
    // Definitive absence proves the ambiguous APPEND stored nothing, so the
    // Sent copy re-enters its safe retry loop.
    await expect(absentFixture.state()).resolves.toMatchObject({
      phase: "sent_copy_pending",
      lastErrorCode: "sent_copy_reconciled_absent",
    });
    await absentFixture.store.close();
  });

  it("resolves delivery_unknown when reconciliation finds the Sent copy", async () => {
    const fixture = await createFixture();
    const transport = new FakeSmtpTransport([
      Object.freeze({
        kind: "transport_error" as const,
        deliveryRisk: "possible" as const,
        errorCode: "smtp_connection_timeout",
      }),
    ]);
    const sentCopy = new FakeSentCopyPort([
      { kind: "found", mailboxId: "sent", uidValidity: "31", uid: 12 },
    ]);
    const worker = fixture.worker(transport, sentCopy);

    // One pass reaches delivery_unknown and its reconciliation slice then
    // locates the Message-ID in Sent, settling the operation as sent.
    await worker.runNow();
    const state = await fixture.state();
    expect(state.phase).toBe("sent");
    expect(state.smtpAcceptance?.acceptedRecipients).toEqual([
      "friend@example.net",
    ]);
    await expect(fixture.outbox()).resolves.toMatchObject({ status: "sent" });
    expect(transport.calls).toHaveLength(1);
    await fixture.store.close();
  });
});
