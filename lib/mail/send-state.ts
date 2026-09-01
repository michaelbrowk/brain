import type {
  ImapAppendOutcome,
  MailEnvelope,
  SmtpRecipientRejection,
  SmtpSubmissionOutcome,
} from "./ports";
import { MAIL_RESOURCE_LIMITS, admitOutgoingRawMessage } from "./security";

export type SubmissionPhase =
  | "queued"
  | "submitting"
  | "retry_wait"
  | "sent_copy_pending"
  | "sent_copy_unknown"
  | "sent_copy_failed"
  | "sent"
  | "partially_sent"
  | "failed"
  | "delivery_unknown";

export interface QueuedSubmissionInput {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly messageId: string;
  readonly envelope: MailEnvelope;
  readonly rawMimeSha256: string;
  readonly rawMimeBytes: number;
  readonly createdAt: number;
}

export type ImmutableSubmission = QueuedSubmissionInput;

export interface SubmissionLease {
  readonly attemptId: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly deliveryRisk: "none" | "possible";
  readonly dataStartedAt: number | null;
}

export interface StoredSentCopy {
  readonly mailboxId: string;
  readonly uidValidity: string;
  readonly uid: number;
}

export interface StoredSmtpAcceptance {
  readonly responseCode: number;
  readonly acceptedRecipients: readonly string[];
  readonly rejectedRecipients: readonly SmtpRecipientRejection[];
}

export interface SentCopyLease {
  readonly attemptId: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly deliveryRisk: "none" | "possible";
  readonly appendStartedAt: number | null;
}

export interface SubmissionRecord {
  readonly version: number;
  readonly phase: SubmissionPhase;
  readonly submission: ImmutableSubmission;
  readonly attemptCount: number;
  readonly lease: SubmissionLease | null;
  readonly retryAt: number | null;
  readonly acceptedAt: number | null;
  readonly smtpAcceptance: StoredSmtpAcceptance | null;
  readonly sentCopyAttemptCount: number;
  readonly sentCopyLease: SentCopyLease | null;
  readonly sentCopyRetryAt: number | null;
  readonly sentCopy: StoredSentCopy | null;
  readonly lastErrorCode: string | null;
}

const SUBMISSION_PHASES = new Set<SubmissionPhase>([
  "queued",
  "submitting",
  "retry_wait",
  "sent_copy_pending",
  "sent_copy_unknown",
  "sent_copy_failed",
  "sent",
  "partially_sent",
  "failed",
  "delivery_unknown",
]);

const SMTP_RETRY_BASE_MS = 5 * 60_000;
const SMTP_RETRY_CAP_MS = 60 * 60_000;
const SENT_COPY_RETRY_BASE_MS = 60_000;
const SENT_COPY_RETRY_CAP_MS = 30 * 60_000;

/** Transient SMTP failures stop retrying after this many claimed attempts. */
export const SMTP_MAX_ATTEMPTS = 8;
export const SMTP_ATTEMPTS_EXHAUSTED_ERROR_CODE = "smtp_attempts_exhausted";
export const SENT_COPY_RECONCILED_ABSENT_ERROR_CODE =
  "sent_copy_reconciled_absent";

export function createQueuedSubmission(input: QueuedSubmissionInput): SubmissionRecord {
  const submission = validateSubmission(input);
  return freezeRecord({
    version: 0,
    phase: "queued",
    submission,
    attemptCount: 0,
    lease: null,
    retryAt: null,
    acceptedAt: null,
    smtpAcceptance: null,
    sentCopyAttemptCount: 0,
    sentCopyLease: null,
    sentCopyRetryAt: null,
    sentCopy: null,
    lastErrorCode: null,
  });
}

/**
 * Restores one untrusted persisted record into the exact, deeply immutable
 * state-machine shape. Extra keys are rejected so storage corruption cannot
 * silently become executable worker state.
 */
export function restoreSubmissionRecord(value: unknown): SubmissionRecord {
  try {
    if (
      !isExactRecord(value, [
        "acceptedAt",
        "attemptCount",
        "lastErrorCode",
        "lease",
        "phase",
        "retryAt",
        "sentCopy",
        "sentCopyAttemptCount",
        "sentCopyLease",
        "sentCopyRetryAt",
        "smtpAcceptance",
        "submission",
        "version",
      ]) ||
      !Number.isSafeInteger(value.version) ||
      (value.version as number) < 0 ||
      typeof value.phase !== "string" ||
      !SUBMISSION_PHASES.has(value.phase as SubmissionPhase) ||
      !Number.isSafeInteger(value.attemptCount) ||
      (value.attemptCount as number) < 0 ||
      !Number.isSafeInteger(value.sentCopyAttemptCount) ||
      (value.sentCopyAttemptCount as number) < 0 ||
      !isOptionalTimestamp(value.retryAt) ||
      !isOptionalTimestamp(value.acceptedAt) ||
      !isOptionalTimestamp(value.sentCopyRetryAt) ||
      !isOptionalErrorCode(value.lastErrorCode)
    ) {
      throw persistedStateInvalid();
    }

    return freezeRecord({
      version: value.version as number,
      phase: value.phase as SubmissionPhase,
      submission: restoreSubmission(value.submission),
      attemptCount: value.attemptCount as number,
      lease: restoreSubmissionLease(value.lease),
      retryAt: value.retryAt as number | null,
      acceptedAt: value.acceptedAt as number | null,
      smtpAcceptance: restoreSmtpAcceptance(value.smtpAcceptance),
      sentCopyAttemptCount: value.sentCopyAttemptCount as number,
      sentCopyLease: restoreSentCopyLease(value.sentCopyLease),
      sentCopyRetryAt: value.sentCopyRetryAt as number | null,
      sentCopy: restoreSentCopy(value.sentCopy),
      lastErrorCode: value.lastErrorCode as string | null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "persisted mail submission state is invalid") {
      throw error;
    }
    throw persistedStateInvalid();
  }
}

/** Earliest time at which a durable worker may safely examine this record. */
export function submissionRunnableAt(record: SubmissionRecord): number | null {
  validateRecord(record);
  switch (record.phase) {
    case "queued":
      return record.submission.createdAt;
    case "submitting":
      return record.lease!.expiresAt;
    case "retry_wait":
      return record.retryAt!;
    case "sent_copy_pending":
      return record.sentCopyLease?.expiresAt ?? record.sentCopyRetryAt!;
    case "sent_copy_unknown":
    case "sent_copy_failed":
    case "sent":
    case "partially_sent":
    case "failed":
    case "delivery_unknown":
      return null;
  }
}

export function claimSubmission(
  record: SubmissionRecord,
  input: { readonly attemptId: string; readonly now: number; readonly leaseMs: number },
): SubmissionRecord {
  validateRecord(record);
  assertSafeIdentifier(input.attemptId, "SMTP attempt id");
  assertTimestamp(input.now, "SMTP claim time");
  if (
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs < 1_000 ||
    input.leaseMs > MAIL_RESOURCE_LIMITS.workerLeaseMs
  ) {
    throw new Error(
      `SMTP lease must be between 1000 and ${MAIL_RESOURCE_LIMITS.workerLeaseMs} milliseconds`,
    );
  }
  const expiresAt = input.now + input.leaseMs;
  assertTimestamp(expiresAt, "SMTP lease expiry time");

  if (record.phase === "retry_wait") {
    if (record.retryAt === null || input.now < record.retryAt) {
      throw new Error("SMTP submission retry window has not opened");
    }
  } else if (
    record.phase === "sent_copy_pending" ||
    record.phase === "sent_copy_unknown" ||
    record.phase === "sent_copy_failed" ||
    record.phase === "sent" ||
    record.phase === "partially_sent"
  ) {
    throw new Error("SMTP submission was already accepted and must not be resent");
  } else if (record.phase === "delivery_unknown") {
    throw new Error("SMTP delivery unknown requires manual reconciliation");
  } else if (record.phase === "failed") {
    throw new Error("SMTP submission permanently failed");
  } else if (record.phase === "submitting") {
    throw new Error("SMTP submission already has an active attempt");
  } else if (record.phase !== "queued") {
    throw new Error("SMTP submission cannot be claimed from its current phase");
  }

  return freezeRecord({
    ...record,
    version: record.version + 1,
    phase: "submitting",
    attemptCount: record.attemptCount + 1,
    lease: {
      attemptId: input.attemptId,
      startedAt: input.now,
      expiresAt,
      deliveryRisk: "none",
      dataStartedAt: null,
    },
    retryAt: null,
    lastErrorCode: null,
  });
}

/** Persist this transition immediately before the SMTP DATA bytes are handed off. */
export function markSubmissionDeliveryRisk(
  record: SubmissionRecord,
  input: { readonly attemptId: string; readonly now: number },
): SubmissionRecord {
  const lease = requireSubmissionAttempt(record, input.attemptId);
  assertTimestampWithinLease(input.now, lease, "SMTP DATA start time");
  if (lease.deliveryRisk === "possible") return record;

  return freezeRecord({
    ...record,
    version: record.version + 1,
    lease: {
      ...lease,
      deliveryRisk: "possible",
      dataStartedAt: input.now,
    },
  });
}

export function recordSmtpOutcome(
  record: SubmissionRecord,
  input: {
    readonly attemptId: string;
    readonly now: number;
    readonly outcome: SmtpSubmissionOutcome;
  },
): SubmissionRecord {
  const lease = requireSubmissionAttempt(record, input.attemptId);
  assertTimestampWithinLease(input.now, lease, "SMTP outcome time");

  if (input.outcome.kind === "accepted") {
    if (lease.deliveryRisk !== "possible") {
      throw new Error("SMTP acceptance requires a durable pre-DATA risk mark");
    }
    if (input.outcome.responseCode !== 250) {
      throw new Error("SMTP DATA acceptance must use response code 250");
    }
    const smtpAcceptance = validateSmtpAcceptance(
      input.outcome,
      record.submission.envelope,
    );
    return freezeRecord({
      ...record,
      version: record.version + 1,
      phase: "sent_copy_pending",
      lease: null,
      retryAt: null,
      acceptedAt: input.now,
      smtpAcceptance,
      sentCopyLease: null,
      sentCopyRetryAt: input.now,
      lastErrorCode: null,
    });
  }

  assertErrorCode(input.outcome.errorCode);
  if (input.outcome.kind === "transport_error") {
    assertDeliveryRisk(input.outcome.deliveryRisk, "SMTP transport outcome");
    const deliveryRisk =
      input.outcome.deliveryRisk === "possible" || lease.deliveryRisk === "possible"
        ? "possible"
        : "none";
    if (deliveryRisk === "possible") {
      return freezeRecord({
        ...record,
        version: record.version + 1,
        phase: "delivery_unknown",
        lease: null,
        retryAt: null,
        lastErrorCode: input.outcome.errorCode,
      });
    }
    return transitionToSmtpRetry(record, input.now, input.outcome.errorCode);
  }

  if (input.outcome.kind !== "rejected") {
    throw new Error("SMTP outcome kind is invalid");
  }
  if (typeof input.outcome.retryable !== "boolean") {
    throw new Error("SMTP rejection retryability is invalid");
  }
  assertSmtpResponse(input.outcome.responseCode, 400, 599);
  if (input.outcome.retryable) {
    if (input.outcome.responseCode >= 500) {
      throw new Error("permanent SMTP response cannot be marked retryable");
    }
    return transitionToSmtpRetry(record, input.now, input.outcome.errorCode);
  }
  if (input.outcome.responseCode < 500) {
    throw new Error("transient SMTP response cannot be marked permanent");
  }

  return freezeRecord({
    ...record,
    version: record.version + 1,
    phase: "failed",
    lease: null,
    retryAt: null,
    lastErrorCode: input.outcome.errorCode,
  });
}

export function recoverExpiredSubmission(
  record: SubmissionRecord,
  input: { readonly now: number },
): SubmissionRecord {
  validateRecord(record);
  assertTimestamp(input.now, "SMTP recovery time");
  if (record.phase !== "submitting" || !record.lease) {
    throw new Error("SMTP submission has no active lease to recover");
  }
  if (input.now < record.lease.expiresAt) {
    throw new Error("SMTP submission lease has not expired");
  }

  if (record.lease.deliveryRisk === "possible") {
    return freezeRecord({
      ...record,
      version: record.version + 1,
      phase: "delivery_unknown",
      lease: null,
      retryAt: null,
      lastErrorCode: "worker_lease_expired_after_data",
    });
  }
  return transitionToSmtpRetry(record, input.now, "worker_lease_expired_before_data");
}

export function claimSentCopy(
  record: SubmissionRecord,
  input: { readonly attemptId: string; readonly now: number; readonly leaseMs: number },
): SubmissionRecord {
  validateRecord(record);
  if (record.phase === "sent_copy_unknown") {
    throw new Error("Sent copy requires reconciliation before another APPEND");
  }
  requireSentCopyPending(record);
  assertSafeIdentifier(input.attemptId, "Sent copy attempt id");
  assertTimestamp(input.now, "Sent copy claim time");
  assertWorkerLease(input.leaseMs, "Sent copy");
  const expiresAt = input.now + input.leaseMs;
  assertTimestamp(expiresAt, "Sent copy lease expiry time");
  if (record.sentCopyLease) throw new Error("Sent copy already has an active attempt");
  if (record.sentCopyRetryAt !== null && input.now < record.sentCopyRetryAt) {
    throw new Error("Sent copy retry window has not opened");
  }

  return freezeRecord({
    ...record,
    version: record.version + 1,
    sentCopyAttemptCount: record.sentCopyAttemptCount + 1,
    sentCopyLease: {
      attemptId: input.attemptId,
      startedAt: input.now,
      expiresAt,
      deliveryRisk: "none",
      appendStartedAt: null,
    },
    sentCopyRetryAt: null,
    lastErrorCode: null,
  });
}

/** Persist this transition immediately before writing the IMAP APPEND literal. */
export function markSentCopyDeliveryRisk(
  record: SubmissionRecord,
  input: { readonly attemptId: string; readonly now: number },
): SubmissionRecord {
  const lease = requireSentCopyAttempt(record, input.attemptId);
  assertTimestampWithinLease(input.now, lease, "Sent copy APPEND start time");
  if (lease.deliveryRisk === "possible") return record;
  return freezeRecord({
    ...record,
    version: record.version + 1,
    sentCopyLease: {
      ...lease,
      deliveryRisk: "possible",
      appendStartedAt: input.now,
    },
  });
}

export function recordSentCopyOutcome(
  record: SubmissionRecord,
  input: {
    readonly attemptId: string;
    readonly now: number;
    readonly mailboxId: string;
    readonly outcome: ImapAppendOutcome;
  },
): SubmissionRecord {
  const lease = requireSentCopyAttempt(record, input.attemptId);
  assertTimestampWithinLease(input.now, lease, "Sent copy outcome time");
  assertSafeIdentifier(input.mailboxId, "Sent mailbox id");

  if (input.outcome.kind === "stored") {
    if (lease.deliveryRisk !== "possible") {
      throw new Error("Sent copy success requires a durable pre-APPEND risk mark");
    }
    validateUidValidity(input.outcome.uidValidity);
    assertUid(input.outcome.uid);
    return freezeRecord({
      ...record,
      version: record.version + 1,
      phase: smtpDeliveryWasPartial(record) ? "partially_sent" : "sent",
      sentCopyLease: null,
      sentCopyRetryAt: null,
      sentCopy: {
        mailboxId: input.mailboxId,
        uidValidity: input.outcome.uidValidity,
        uid: input.outcome.uid,
      },
      lastErrorCode: null,
    });
  }

  if (input.outcome.kind === "stored_without_uid") {
    if (lease.deliveryRisk !== "possible") {
      throw new Error("Sent copy success requires a durable pre-APPEND risk mark");
    }
    return freezeRecord({
      ...record,
      version: record.version + 1,
      phase: "sent_copy_unknown",
      sentCopyLease: null,
      sentCopyRetryAt: null,
      lastErrorCode: "sent_copy_stored_without_uid",
    });
  }

  assertErrorCode(input.outcome.errorCode);
  if (input.outcome.kind === "transport_error") {
    assertDeliveryRisk(input.outcome.deliveryRisk, "Sent copy transport outcome");
    if (input.outcome.deliveryRisk === "possible" || lease.deliveryRisk === "possible") {
      return freezeRecord({
        ...record,
        version: record.version + 1,
        phase: "sent_copy_unknown",
        sentCopyLease: null,
        sentCopyRetryAt: null,
        lastErrorCode: input.outcome.errorCode,
      });
    }
    return transitionToSentCopyRetry(record, input.now, input.outcome.errorCode);
  }

  if (input.outcome.kind !== "rejected" || typeof input.outcome.retryable !== "boolean") {
    throw new Error("Sent copy outcome is invalid");
  }
  if (!input.outcome.retryable) {
    return freezeRecord({
      ...record,
      version: record.version + 1,
      phase: "sent_copy_failed",
      sentCopyLease: null,
      sentCopyRetryAt: null,
      lastErrorCode: input.outcome.errorCode,
    });
  }
  return transitionToSentCopyRetry(record, input.now, input.outcome.errorCode);
}

function transitionToSentCopyRetry(
  record: SubmissionRecord,
  now: number,
  errorCode: string,
): SubmissionRecord {
  const delay = Math.min(
    SENT_COPY_RETRY_CAP_MS,
    SENT_COPY_RETRY_BASE_MS * 2 ** Math.min(record.sentCopyAttemptCount - 1, 10),
  );

  return freezeRecord({
    ...record,
    version: record.version + 1,
    sentCopyLease: null,
    sentCopyRetryAt: now + delay,
    lastErrorCode: errorCode,
  });
}

export function recoverExpiredSentCopy(
  record: SubmissionRecord,
  input: { readonly now: number },
): SubmissionRecord {
  requireSentCopyPending(record);
  assertTimestamp(input.now, "Sent copy recovery time");
  if (!record.sentCopyLease) throw new Error("Sent copy has no active lease to recover");
  if (input.now < record.sentCopyLease.expiresAt) {
    throw new Error("Sent copy lease has not expired");
  }
  if (record.sentCopyLease.deliveryRisk === "possible") {
    return freezeRecord({
      ...record,
      version: record.version + 1,
      phase: "sent_copy_unknown",
      sentCopyLease: null,
      sentCopyRetryAt: null,
      lastErrorCode: "sent_copy_worker_lease_expired_after_append",
    });
  }
  const delay = Math.min(
    SENT_COPY_RETRY_CAP_MS,
    SENT_COPY_RETRY_BASE_MS * 2 ** Math.min(record.sentCopyAttemptCount - 1, 10),
  );
  return freezeRecord({
    ...record,
    version: record.version + 1,
    sentCopyLease: null,
    sentCopyRetryAt: input.now + delay,
    lastErrorCode: "sent_copy_worker_lease_expired",
  });
}

function transitionToSmtpRetry(
  record: SubmissionRecord,
  now: number,
  errorCode: string,
): SubmissionRecord {
  if (record.attemptCount >= SMTP_MAX_ATTEMPTS) {
    return freezeRecord({
      ...record,
      version: record.version + 1,
      phase: "failed",
      lease: null,
      retryAt: null,
      lastErrorCode: SMTP_ATTEMPTS_EXHAUSTED_ERROR_CODE,
    });
  }
  const delay = Math.min(
    SMTP_RETRY_CAP_MS,
    SMTP_RETRY_BASE_MS * 2 ** Math.min(Math.max(0, record.attemptCount - 1), 10),
  );
  return freezeRecord({
    ...record,
    version: record.version + 1,
    phase: "retry_wait",
    lease: null,
    retryAt: now + delay,
    lastErrorCode: errorCode,
  });
}

/**
 * Resolves an ambiguous Sent copy after reconciliation located the immutable
 * Message-ID in the account's Sent mailbox. The stored copy already exists, so
 * no further APPEND may run.
 */
export function reconcileSentCopyFound(
  record: SubmissionRecord,
  input: {
    readonly now: number;
    readonly mailboxId: string;
    readonly uidValidity: string;
    readonly uid: number;
  },
): SubmissionRecord {
  validateRecord(record);
  if (record.phase !== "sent_copy_unknown") {
    throw new Error("Sent copy reconciliation requires an ambiguous APPEND");
  }
  assertTimestamp(input.now, "Sent copy reconciliation time");
  assertSafeIdentifier(input.mailboxId, "Sent mailbox id");
  validateUidValidity(input.uidValidity);
  assertUid(input.uid);
  return freezeRecord({
    ...record,
    version: record.version + 1,
    phase: smtpDeliveryWasPartial(record) ? "partially_sent" : "sent",
    sentCopyLease: null,
    sentCopyRetryAt: null,
    sentCopy: {
      mailboxId: input.mailboxId,
      uidValidity: input.uidValidity,
      uid: input.uid,
    },
    lastErrorCode: null,
  });
}

/**
 * A definitive Message-ID miss proves the ambiguous APPEND stored nothing, so
 * one more APPEND cannot duplicate the Sent copy. The record re-enters the
 * normal Sent-copy retry loop after backoff.
 */
export function reconcileSentCopyAbsent(
  record: SubmissionRecord,
  input: { readonly now: number },
): SubmissionRecord {
  validateRecord(record);
  if (record.phase !== "sent_copy_unknown") {
    throw new Error("Sent copy reconciliation requires an ambiguous APPEND");
  }
  assertTimestamp(input.now, "Sent copy reconciliation time");
  const delay = Math.min(
    SENT_COPY_RETRY_CAP_MS,
    SENT_COPY_RETRY_BASE_MS *
      2 ** Math.min(Math.max(0, record.sentCopyAttemptCount - 1), 10),
  );
  return freezeRecord({
    ...record,
    version: record.version + 1,
    phase: "sent_copy_pending",
    sentCopyLease: null,
    sentCopyRetryAt: input.now + delay,
    lastErrorCode: SENT_COPY_RECONCILED_ABSENT_ERROR_CODE,
  });
}

/**
 * Resolves delivery_unknown after reconciliation located the immutable
 * Message-ID in the account's Sent mailbox. Presence of the exact stored copy
 * proves the provider accepted the message, so the recipient partition is
 * recorded as fully accepted. Absence proves nothing and never re-sends.
 */
export function reconcileDeliveryUnknownFound(
  record: SubmissionRecord,
  input: {
    readonly now: number;
    readonly mailboxId: string;
    readonly uidValidity: string;
    readonly uid: number;
  },
): SubmissionRecord {
  validateRecord(record);
  if (record.phase !== "delivery_unknown") {
    throw new Error("delivery reconciliation requires an unknown delivery");
  }
  assertTimestamp(input.now, "delivery reconciliation time");
  if (input.now < record.submission.createdAt) {
    throw new Error("delivery reconciliation time predates the submission");
  }
  assertSafeIdentifier(input.mailboxId, "Sent mailbox id");
  validateUidValidity(input.uidValidity);
  assertUid(input.uid);
  const envelope = record.submission.envelope;
  return freezeRecord({
    ...record,
    version: record.version + 1,
    phase: "sent",
    lease: null,
    retryAt: null,
    acceptedAt: input.now,
    smtpAcceptance: {
      responseCode: 250,
      acceptedRecipients: [...envelope.to, ...envelope.cc, ...envelope.bcc],
      rejectedRecipients: [],
    },
    sentCopyAttemptCount: Math.max(1, record.sentCopyAttemptCount),
    sentCopyLease: null,
    sentCopyRetryAt: null,
    sentCopy: {
      mailboxId: input.mailboxId,
      uidValidity: input.uidValidity,
      uid: input.uid,
    },
    lastErrorCode: null,
  });
}

function requireSubmissionAttempt(
  record: SubmissionRecord,
  attemptId: string,
): SubmissionLease {
  validateRecord(record);
  assertSafeIdentifier(attemptId, "SMTP attempt id");
  if (record.phase !== "submitting" || !record.lease) {
    throw new Error("SMTP submission has no active attempt");
  }
  if (record.lease.attemptId !== attemptId) {
    throw new Error("SMTP attempt does not match the active lease");
  }
  return record.lease;
}

function requireSentCopyPending(record: SubmissionRecord): void {
  validateRecord(record);
  if (record.phase !== "sent_copy_pending") {
    throw new Error("Sent copy can only be updated after SMTP acceptance");
  }
}

function requireSentCopyAttempt(
  record: SubmissionRecord,
  attemptId: string,
): SentCopyLease {
  requireSentCopyPending(record);
  assertSafeIdentifier(attemptId, "Sent copy attempt id");
  if (!record.sentCopyLease) throw new Error("Sent copy has no active attempt");
  if (record.sentCopyLease.attemptId !== attemptId) {
    throw new Error("Sent copy attempt does not match the active lease");
  }
  return record.sentCopyLease;
}

function validateSubmission(input: QueuedSubmissionInput): ImmutableSubmission {
  assertSafeIdentifier(input.operationId, "send operation id");
  assertSafeIdentifier(input.idempotencyKey, "send idempotency key");
  assertSafeIdentifier(input.accountId, "mail account id");
  if (
    input.messageId.includes("\r") ||
    input.messageId.includes("\n") ||
    !/^<[^<>\s@]+@[^<>\s@]+>$/.test(input.messageId) ||
    input.messageId.length > 254
  ) {
    throw new Error("mail Message ID is invalid or unsafe");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.rawMimeSha256)) {
    throw new Error("raw MIME SHA256 must be a 64-character hexadecimal digest");
  }
  admitOutgoingRawMessage(input.rawMimeBytes);
  assertTimestamp(input.createdAt, "submission creation time");
  validateEnvelope(input.envelope);

  return {
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    accountId: input.accountId,
    messageId: input.messageId,
    envelope: {
      from: input.envelope.from,
      to: [...input.envelope.to],
      cc: [...input.envelope.cc],
      bcc: [...input.envelope.bcc],
    },
    rawMimeSha256: input.rawMimeSha256.toLowerCase(),
    rawMimeBytes: input.rawMimeBytes,
    createdAt: input.createdAt,
  };
}

function validateEnvelope(envelope: MailEnvelope): void {
  validateAddress(envelope.from, "envelope sender");
  const recipients = [...envelope.to, ...envelope.cc, ...envelope.bcc];
  if (recipients.length === 0) throw new Error("mail envelope requires at least one recipient");
  if (recipients.length > MAIL_RESOURCE_LIMITS.addressesPerMessage) {
    throw new Error("mail envelope exceeds the configured address limit");
  }
  const uniqueRecipients = new Set<string>();
  for (const recipient of recipients) {
    validateAddress(recipient, "envelope recipient");
    if (uniqueRecipients.has(recipient)) {
      throw new Error("mail envelope contains a duplicate recipient");
    }
    uniqueRecipients.add(recipient);
  }
}

function validateAddress(value: string, label: string): void {
  if (
    value.length > 254 ||
    value.includes("\r") ||
    value.includes("\n") ||
    !/^[^<>\s@]+@[^<>\s@]+$/.test(value)
  ) {
    throw new Error(`${label} is invalid or unsafe`);
  }
}

function validateSmtpAcceptance(
  outcome: Extract<SmtpSubmissionOutcome, { readonly kind: "accepted" }>,
  envelope: MailEnvelope,
): StoredSmtpAcceptance {
  if (!Array.isArray(outcome.acceptedRecipients) || outcome.acceptedRecipients.length === 0) {
    throw new Error("SMTP acceptance requires at least one accepted recipient");
  }
  if (!Array.isArray(outcome.rejectedRecipients)) {
    throw new Error("SMTP rejected recipient list is invalid");
  }
  const expected = new Set([...envelope.to, ...envelope.cc, ...envelope.bcc]);
  const seen = new Set<string>();
  const acceptedRecipients = outcome.acceptedRecipients.map((address) => {
    validateAddress(address, "accepted SMTP recipient");
    assertExpectedRecipient(address, expected, seen);
    return address;
  });
  const rejectedRecipients = outcome.rejectedRecipients.map((recipient) => {
    validateAddress(recipient.address, "rejected SMTP recipient");
    assertExpectedRecipient(recipient.address, expected, seen);
    assertErrorCode(recipient.errorCode);
    if (typeof recipient.retryable !== "boolean") {
      throw new Error("SMTP recipient retryability is invalid");
    }
    assertSmtpResponse(recipient.responseCode, 400, 599);
    if (recipient.retryable !== (recipient.responseCode < 500)) {
      throw new Error("SMTP recipient response and retryability disagree");
    }
    return Object.freeze({ ...recipient });
  });
  if (seen.size !== expected.size) {
    throw new Error("SMTP outcome does not account for every envelope recipient");
  }
  return Object.freeze({
    responseCode: 250,
    acceptedRecipients: Object.freeze(acceptedRecipients),
    rejectedRecipients: Object.freeze(rejectedRecipients),
  });
}

function assertExpectedRecipient(
  address: string,
  expected: ReadonlySet<string>,
  seen: Set<string>,
): void {
  if (!expected.has(address) || seen.has(address)) {
    throw new Error("SMTP outcome contains an unknown or duplicate recipient");
  }
  seen.add(address);
}

function smtpDeliveryWasPartial(record: SubmissionRecord): boolean {
  if (!record.smtpAcceptance) {
    throw new Error("Sent copy state is missing SMTP acceptance metadata");
  }
  return record.smtpAcceptance.rejectedRecipients.length > 0;
}

function validateRecord(record: SubmissionRecord): void {
  assertNonNegativeInteger(record.version, "submission state version");
  if (!SUBMISSION_PHASES.has(record.phase)) {
    throw new Error("submission state phase is invalid");
  }
  validateSubmission(record.submission);
  assertNonNegativeInteger(record.attemptCount, "SMTP attempt count");
  assertNonNegativeInteger(record.sentCopyAttemptCount, "Sent copy attempt count");
  if ((record.phase === "queued") !== (record.attemptCount === 0)) {
    throw new Error("SMTP attempt count does not match its phase");
  }
  const sentCopyStartedPhase = [
    "sent_copy_unknown",
    "sent_copy_failed",
    "sent",
    "partially_sent",
  ].includes(record.phase);
  if (sentCopyStartedPhase && record.sentCopyAttemptCount < 1) {
    throw new Error("Sent copy result is missing its attempt count");
  }
  if (
    ![
      "sent_copy_pending",
      "sent_copy_unknown",
      "sent_copy_failed",
      "sent",
      "partially_sent",
    ].includes(record.phase) &&
    record.sentCopyAttemptCount !== 0
  ) {
    throw new Error("Sent copy attempt count exists before SMTP acceptance");
  }
  if (record.lease) validateWorkLease(record.lease, "SMTP");
  if (record.sentCopyLease) validateWorkLease(record.sentCopyLease, "Sent copy");
  if (record.retryAt !== null) assertTimestamp(record.retryAt, "SMTP retry time");
  if (record.acceptedAt !== null) {
    assertTimestamp(record.acceptedAt, "SMTP acceptance time");
    if (record.acceptedAt < record.submission.createdAt) {
      throw new Error("SMTP acceptance predates its queued submission");
    }
  }
  if (record.sentCopyRetryAt !== null) {
    assertTimestamp(record.sentCopyRetryAt, "Sent copy retry time");
  }
  if (record.lastErrorCode !== null) assertErrorCode(record.lastErrorCode);

  if (record.phase === "submitting" && !record.lease) {
    throw new Error("submitting SMTP state is missing its lease");
  }
  if (record.phase !== "submitting" && record.lease) {
    throw new Error("SMTP state has a lease outside the submitting phase");
  }
  if (record.phase !== "sent_copy_pending" && record.sentCopyLease) {
    throw new Error("Sent copy state has a lease outside its pending phase");
  }
  if (record.phase === "retry_wait" && record.retryAt === null) {
    throw new Error("SMTP retry state is missing its retry time");
  }
  if (record.phase !== "retry_wait" && record.retryAt !== null) {
    throw new Error("SMTP retry time exists outside retry state");
  }
  if (
    record.phase !== "sent_copy_pending" &&
    record.sentCopyRetryAt !== null
  ) {
    throw new Error("Sent copy retry time exists outside pending state");
  }
  if (record.sentCopyLease && record.sentCopyRetryAt !== null) {
    throw new Error("Sent copy cannot have a lease and retry time together");
  }
  if (
    record.phase === "sent_copy_pending" &&
    (record.sentCopyLease === null) === (record.sentCopyRetryAt === null)
  ) {
    throw new Error("Sent copy pending state requires exactly one runnable marker");
  }

  const acceptedPhase = [
    "sent_copy_pending",
    "sent_copy_unknown",
    "sent_copy_failed",
    "sent",
    "partially_sent",
  ].includes(record.phase);
  if (
    acceptedPhase
      ? record.acceptedAt === null || record.smtpAcceptance === null
      : record.acceptedAt !== null || record.smtpAcceptance !== null
  ) {
    throw new Error("submission acceptance metadata does not match its phase");
  }
  if (record.smtpAcceptance) {
    if (record.smtpAcceptance.responseCode !== 250) {
      throw new Error("stored SMTP acceptance must use response code 250");
    }
    validateSmtpAcceptance(
      { kind: "accepted", ...record.smtpAcceptance },
      record.submission.envelope,
    );
  }
  if (record.sentCopy) {
    assertSafeIdentifier(record.sentCopy.mailboxId, "Sent mailbox id");
    validateUidValidity(record.sentCopy.uidValidity);
    assertUid(record.sentCopy.uid);
  }
  if (
    (record.phase === "sent" || record.phase === "partially_sent") !==
    (record.sentCopy !== null)
  ) {
    throw new Error("final sent state does not match Sent copy metadata");
  }
  if (record.phase === "sent" && smtpDeliveryWasPartial(record)) {
    throw new Error("fully sent state contains rejected recipients");
  }
  if (record.phase === "partially_sent" && !smtpDeliveryWasPartial(record)) {
    throw new Error("partially sent state has no rejected recipients");
  }
}

function validateWorkLease(
  lease: SubmissionLease | SentCopyLease,
  label: string,
): void {
  assertSafeIdentifier(lease.attemptId, `${label} attempt id`);
  assertTimestamp(lease.startedAt, `${label} lease start time`);
  assertTimestamp(lease.expiresAt, `${label} lease expiry time`);
  if (
    lease.expiresAt <= lease.startedAt ||
    lease.expiresAt - lease.startedAt > MAIL_RESOURCE_LIMITS.workerLeaseMs
  ) {
    throw new Error(`${label} lease duration is invalid`);
  }
  assertDeliveryRisk(lease.deliveryRisk, `${label} lease`);
  if (lease.deliveryRisk === "possible") {
    if ("dataStartedAt" in lease && lease.dataStartedAt === null) {
      throw new Error("SMTP risk-marked lease is missing DATA start time");
    }
    if ("appendStartedAt" in lease && lease.appendStartedAt === null) {
      throw new Error("Sent copy risk-marked lease is missing APPEND start time");
    }
  } else if (
    ("dataStartedAt" in lease && lease.dataStartedAt !== null) ||
    ("appendStartedAt" in lease && lease.appendStartedAt !== null)
  ) {
    throw new Error(`${label} lease has a start time without a risk mark`);
  }
  const started = "dataStartedAt" in lease ? lease.dataStartedAt : lease.appendStartedAt;
  if (started !== null) assertTimestampWithinLease(started, lease, `${label} literal start time`);
}

function assertWorkerLease(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1_000 ||
    value > MAIL_RESOURCE_LIMITS.workerLeaseMs
  ) {
    throw new Error(
      `${label} lease must be between 1000 and ${MAIL_RESOURCE_LIMITS.workerLeaseMs} milliseconds`,
    );
  }
}

function validateUidValidity(value: string): void {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) {
    throw new Error("Sent copy UIDVALIDITY is invalid");
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric > 0xffff_ffff) {
    throw new Error("Sent copy UIDVALIDITY exceeds the unsigned 32-bit range");
  }
}

function assertUid(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new Error("Sent copy UID is invalid");
  }
}

function assertSmtpResponse(value: number, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("SMTP response code is inconsistent with the outcome");
  }
}

function assertTimestampWithinLease(
  value: number,
  lease: SubmissionLease | SentCopyLease,
  label: string,
): void {
  assertTimestamp(value, label);
  if (value < lease.startedAt || value > lease.expiresAt) {
    throw new Error(`${label} is outside the active lease`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

function assertDeliveryRisk(value: unknown, label: string): asserts value is "none" | "possible" {
  if (value !== "none" && value !== "possible") {
    throw new Error(`${label} delivery risk is invalid`);
  }
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertErrorCode(value: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new Error("mail error code is invalid");
}

function restoreSubmission(value: unknown): ImmutableSubmission {
  if (
    !isExactRecord(value, [
      "accountId",
      "createdAt",
      "envelope",
      "idempotencyKey",
      "messageId",
      "operationId",
      "rawMimeBytes",
      "rawMimeSha256",
    ]) ||
    typeof value.operationId !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.accountId !== "string" ||
    typeof value.messageId !== "string" ||
    typeof value.rawMimeSha256 !== "string" ||
    !Number.isSafeInteger(value.rawMimeBytes) ||
    !Number.isSafeInteger(value.createdAt)
  ) {
    throw persistedStateInvalid();
  }
  return validateSubmission({
    operationId: value.operationId,
    idempotencyKey: value.idempotencyKey,
    accountId: value.accountId,
    messageId: value.messageId,
    envelope: restoreEnvelope(value.envelope),
    rawMimeSha256: value.rawMimeSha256,
    rawMimeBytes: value.rawMimeBytes as number,
    createdAt: value.createdAt as number,
  });
}

function restoreEnvelope(value: unknown): MailEnvelope {
  if (
    !isExactRecord(value, ["bcc", "cc", "from", "to"]) ||
    typeof value.from !== "string"
  ) {
    throw persistedStateInvalid();
  }
  return Object.freeze({
    from: value.from,
    to: restoreStringArray(value.to),
    cc: restoreStringArray(value.cc),
    bcc: restoreStringArray(value.bcc),
  });
}

function restoreSubmissionLease(value: unknown): SubmissionLease | null {
  if (value === null) return null;
  if (
    !isExactRecord(value, [
      "attemptId",
      "dataStartedAt",
      "deliveryRisk",
      "expiresAt",
      "startedAt",
    ]) ||
    typeof value.attemptId !== "string" ||
    !Number.isSafeInteger(value.startedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.deliveryRisk !== "none" && value.deliveryRisk !== "possible") ||
    !isOptionalTimestamp(value.dataStartedAt)
  ) {
    throw persistedStateInvalid();
  }
  return Object.freeze({
    attemptId: value.attemptId,
    startedAt: value.startedAt as number,
    expiresAt: value.expiresAt as number,
    deliveryRisk: value.deliveryRisk,
    dataStartedAt: value.dataStartedAt as number | null,
  });
}

function restoreSentCopyLease(value: unknown): SentCopyLease | null {
  if (value === null) return null;
  if (
    !isExactRecord(value, [
      "appendStartedAt",
      "attemptId",
      "deliveryRisk",
      "expiresAt",
      "startedAt",
    ]) ||
    typeof value.attemptId !== "string" ||
    !Number.isSafeInteger(value.startedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.deliveryRisk !== "none" && value.deliveryRisk !== "possible") ||
    !isOptionalTimestamp(value.appendStartedAt)
  ) {
    throw persistedStateInvalid();
  }
  return Object.freeze({
    attemptId: value.attemptId,
    startedAt: value.startedAt as number,
    expiresAt: value.expiresAt as number,
    deliveryRisk: value.deliveryRisk,
    appendStartedAt: value.appendStartedAt as number | null,
  });
}

function restoreSmtpAcceptance(value: unknown): StoredSmtpAcceptance | null {
  if (value === null) return null;
  if (
    !isExactRecord(value, [
      "acceptedRecipients",
      "rejectedRecipients",
      "responseCode",
    ]) ||
    !Number.isInteger(value.responseCode) ||
    !Array.isArray(value.rejectedRecipients)
  ) {
    throw persistedStateInvalid();
  }
  return Object.freeze({
    responseCode: value.responseCode as number,
    acceptedRecipients: restoreStringArray(value.acceptedRecipients),
    rejectedRecipients: Object.freeze(
      value.rejectedRecipients.map(restoreRecipientRejection),
    ),
  });
}

function restoreRecipientRejection(value: unknown): SmtpRecipientRejection {
  if (
    !isExactRecord(value, [
      "address",
      "errorCode",
      "responseCode",
      "retryable",
    ]) ||
    typeof value.address !== "string" ||
    typeof value.errorCode !== "string" ||
    !Number.isInteger(value.responseCode) ||
    typeof value.retryable !== "boolean"
  ) {
    throw persistedStateInvalid();
  }
  return Object.freeze({
    address: value.address,
    responseCode: value.responseCode as number,
    retryable: value.retryable,
    errorCode: value.errorCode,
  });
}

function restoreSentCopy(value: unknown): StoredSentCopy | null {
  if (value === null) return null;
  if (
    !isExactRecord(value, ["mailboxId", "uid", "uidValidity"]) ||
    typeof value.mailboxId !== "string" ||
    typeof value.uidValidity !== "string" ||
    !Number.isSafeInteger(value.uid)
  ) {
    throw persistedStateInvalid();
  }
  return Object.freeze({
    mailboxId: value.mailboxId,
    uidValidity: value.uidValidity,
    uid: value.uid as number,
  });
}

function restoreStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw persistedStateInvalid();
  }
  return Object.freeze([...value]);
}

function isOptionalTimestamp(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isOptionalErrorCode(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value));
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}

function persistedStateInvalid(): Error {
  return new Error("persisted mail submission state is invalid");
}

function freezeSubmission(submission: ImmutableSubmission): ImmutableSubmission {
  Object.freeze(submission.envelope.to);
  Object.freeze(submission.envelope.cc);
  Object.freeze(submission.envelope.bcc);
  Object.freeze(submission.envelope);
  return Object.freeze(submission);
}

function freezeRecord(record: SubmissionRecord): SubmissionRecord {
  validateRecord(record);
  const submission = freezeSubmission(validateSubmission(record.submission));
  const smtpAcceptance = record.smtpAcceptance
    ? validateSmtpAcceptance(
        { kind: "accepted", ...record.smtpAcceptance },
        submission.envelope,
      )
    : null;
  return Object.freeze({
    ...record,
    submission,
    lease: record.lease ? Object.freeze({ ...record.lease }) : null,
    smtpAcceptance,
    sentCopyLease: record.sentCopyLease
      ? Object.freeze({ ...record.sentCopyLease })
      : null,
    sentCopy: record.sentCopy ? Object.freeze({ ...record.sentCopy }) : null,
  });
}
