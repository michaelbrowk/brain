import { describe, expect, it } from "vitest";
import {
  claimSentCopy,
  claimSubmission,
  createQueuedSubmission,
  markSentCopyDeliveryRisk,
  markSubmissionDeliveryRisk,
  reconcileDeliveryUnknownFound,
  reconcileSentCopyAbsent,
  reconcileSentCopyFound,
  recoverExpiredSentCopy,
  recordSentCopyOutcome,
  recordSmtpOutcome,
  recoverExpiredSubmission,
  restoreSubmissionRecord,
  SMTP_MAX_ATTEMPTS,
  submissionRunnableAt,
} from "./send-state";
import { MAIL_RESOURCE_LIMITS } from "./security";

const now = Date.parse("2026-07-12T12:00:00.000Z");

function queued() {
  return createQueuedSubmission({
    operationId: "send-operation-1",
    idempotencyKey: "compose-action-1",
    accountId: "account-1",
    messageId: "<brain-send-1@example.com>",
    envelope: {
      from: "me@example.com",
      to: ["friend@example.net"],
      cc: [],
      bcc: [],
    },
    rawMimeSha256: "a".repeat(64),
    rawMimeBytes: 512,
    createdAt: now,
  });
}

function recordAccepted(
  send: ReturnType<typeof queued>,
  attemptId: string,
  acceptedAt: number,
) {
  send = markSubmissionDeliveryRisk(send, {
    attemptId,
    now: acceptedAt - 1,
  });
  return recordSmtpOutcome(send, {
    attemptId,
    now: acceptedAt,
    outcome: {
      kind: "accepted",
      responseCode: 250,
      acceptedRecipients: ["friend@example.net"],
      rejectedRecipients: [],
    },
  });
}

describe("mail submission state", () => {
  it("separates SMTP acceptance from storing the Sent copy", () => {
    let send = claimSubmission(queued(), {
      attemptId: "smtp-attempt-1",
      now,
      leaseMs: 60_000,
    });
    send = recordAccepted(send, "smtp-attempt-1", now + 1_000);

    expect(send.phase).toBe("sent_copy_pending");
    expect(send.acceptedAt).toBe(now + 1_000);

    send = claimSentCopy(send, {
      attemptId: "append-attempt-1",
      now: now + 1_500,
      leaseMs: 60_000,
    });
    send = recordSentCopyOutcome(send, {
      attemptId: "append-attempt-1",
      now: now + 2_000,
      mailboxId: "sent",
      outcome: {
        kind: "transport_error",
        deliveryRisk: "none",
        errorCode: "imap_append_unavailable",
      },
    });
    expect(send.phase).toBe("sent_copy_pending");
    expect(send.sentCopyRetryAt).toBeGreaterThan(now + 2_000);
    expect(() =>
      claimSubmission(send, {
        attemptId: "must-not-resend",
        now: now + 60_000,
        leaseMs: 60_000,
      }),
    ).toThrow(/smtp/i);

    send = claimSentCopy(send, {
      attemptId: "append-attempt-2",
      now: send.sentCopyRetryAt!,
      leaseMs: 60_000,
    });
    send = markSentCopyDeliveryRisk(send, {
      attemptId: "append-attempt-2",
      now: send.sentCopyLease!.startedAt + 1,
    });
    send = recordSentCopyOutcome(send, {
      attemptId: "append-attempt-2",
      now: send.sentCopyLease!.startedAt + 2,
      mailboxId: "sent",
      outcome: { kind: "stored", uidValidity: "55", uid: 901 },
    });
    expect(send.phase).toBe("sent");
    expect(send.sentCopy).toEqual({
      mailboxId: "sent",
      uidValidity: "55",
      uid: 901,
    });
  });

  it("serializes Sent APPEND and recovers its worker lease without resending SMTP", () => {
    let send = claimSubmission(queued(), {
      attemptId: "smtp-attempt-1",
      now,
      leaseMs: 60_000,
    });
    send = recordAccepted(send, "smtp-attempt-1", now + 1_000);
    send = claimSentCopy(send, {
      attemptId: "append-attempt-1",
      now: now + 2_000,
      leaseMs: 1_000,
    });

    expect(() =>
      claimSentCopy(send, {
        attemptId: "parallel-append",
        now: now + 2_500,
        leaseMs: 1_000,
      }),
    ).toThrow(/active/i);

    send = recoverExpiredSentCopy(send, { now: now + 3_000 });
    expect(send.phase).toBe("sent_copy_pending");
    expect(send.sentCopyRetryAt).toBeGreaterThan(now + 3_000);
    expect(() =>
      claimSubmission(send, {
        attemptId: "must-not-resend",
        now: send.sentCopyRetryAt!,
        leaseMs: 60_000,
      }),
    ).toThrow(/smtp/i);
  });

  it("does not retry an ambiguous Sent APPEND after its literal may be accepted", () => {
    let send = claimSubmission(queued(), {
      attemptId: "smtp-attempt-1",
      now,
      leaseMs: 60_000,
    });
    send = recordAccepted(send, "smtp-attempt-1", now + 1_000);
    send = claimSentCopy(send, {
      attemptId: "append-attempt-1",
      now: now + 2_000,
      leaseMs: 1_000,
    });
    send = markSentCopyDeliveryRisk(send, {
      attemptId: "append-attempt-1",
      now: now + 2_500,
    });
    send = recoverExpiredSentCopy(send, { now: now + 3_000 });

    expect(send.phase).toBe("sent_copy_unknown");
    expect(() =>
      claimSentCopy(send, {
        attemptId: "unsafe-append-retry",
        now: now + 60_000,
        leaseMs: 60_000,
      }),
    ).toThrow(/reconciliation/i);
    expect(() =>
      claimSubmission(send, {
        attemptId: "must-not-resend-smtp",
        now: now + 60_000,
        leaseMs: 60_000,
      }),
    ).toThrow(/smtp/i);
  });

  it("retries only failures known to occur before delivery risk", () => {
    const original = queued();
    let send = claimSubmission(original, {
      attemptId: "smtp-attempt-1",
      now,
      leaseMs: 60_000,
    });
    send = recordSmtpOutcome(send, {
      attemptId: "smtp-attempt-1",
      now: now + 1_000,
      outcome: {
        kind: "transport_error",
        deliveryRisk: "none",
        errorCode: "connect_timeout",
      },
    });
    expect(send.phase).toBe("retry_wait");
    expect(() =>
      claimSubmission(send, {
        attemptId: "too-early",
        now: send.retryAt! - 1,
        leaseMs: 60_000,
      }),
    ).toThrow(/retry/i);

    send = claimSubmission(send, {
      attemptId: "smtp-attempt-2",
      now: send.retryAt!,
      leaseMs: 60_000,
    });
    expect(send.submission).toEqual(original.submission);
    expect(send.attemptCount).toBe(2);
  });

  it("makes a possible post-DATA handoff terminal for automatic retry", () => {
    let send = claimSubmission(queued(), {
      attemptId: "smtp-attempt-1",
      now,
      leaseMs: 60_000,
    });
    send = recordSmtpOutcome(send, {
      attemptId: "smtp-attempt-1",
      now: now + 1_000,
      outcome: {
        kind: "transport_error",
        deliveryRisk: "possible",
        errorCode: "connection_lost_after_data",
      },
    });

    expect(send.phase).toBe("delivery_unknown");
    expect(() =>
      claimSubmission(send, {
        attemptId: "unsafe-retry",
        now: now + 60_000,
        leaseMs: 60_000,
      }),
    ).toThrow(/delivery unknown/i);
  });

  it("recovers an expired worker lease without risking a duplicate", () => {
    let beforeData = claimSubmission(queued(), {
      attemptId: "before-data",
      now,
      leaseMs: 1_000,
    });
    beforeData = recoverExpiredSubmission(beforeData, { now: now + 1_000 });
    expect(beforeData.phase).toBe("retry_wait");

    let afterData = claimSubmission(queued(), {
      attemptId: "after-data",
      now,
      leaseMs: 1_000,
    });
    afterData = markSubmissionDeliveryRisk(afterData, {
      attemptId: "after-data",
      now: now + 500,
    });
    afterData = recoverExpiredSubmission(afterData, { now: now + 1_000 });
    expect(afterData.phase).toBe("delivery_unknown");
  });

  it("does not retry permanent SMTP rejection", () => {
    let send = claimSubmission(queued(), {
      attemptId: "smtp-attempt-1",
      now,
      leaseMs: 60_000,
    });
    send = recordSmtpOutcome(send, {
      attemptId: "smtp-attempt-1",
      now: now + 1_000,
      outcome: {
        kind: "rejected",
        responseCode: 550,
        retryable: false,
        errorCode: "mailbox_unavailable",
      },
    });
    expect(send.phase).toBe("failed");
  });

  it("rejects an adapter that classifies a transient SMTP response as permanent", () => {
    const send = claimSubmission(queued(), {
      attemptId: "smtp-attempt-1",
      now,
      leaseMs: 60_000,
    });
    expect(() =>
      recordSmtpOutcome(send, {
        attemptId: "smtp-attempt-1",
        now: now + 1_000,
        outcome: {
          kind: "rejected",
          responseCode: 450,
          retryable: false,
          errorCode: "mailbox_busy",
        },
      }),
    ).toThrow(/transient/i);
  });

  it("rejects SMTP or APPEND success unless the durable literal barrier ran", () => {
    let send = claimSubmission(queued(), {
      attemptId: "unmarked-smtp",
      now,
      leaseMs: 60_000,
    });
    expect(() =>
      recordSmtpOutcome(send, {
        attemptId: "unmarked-smtp",
        now: now + 1,
        outcome: {
          kind: "accepted",
          responseCode: 250,
          acceptedRecipients: ["friend@example.net"],
          rejectedRecipients: [],
        },
      }),
    ).toThrow(/risk mark/i);

    send = recordAccepted(send, "unmarked-smtp", now + 2);
    send = claimSentCopy(send, {
      attemptId: "unmarked-append",
      now: now + 3,
      leaseMs: 60_000,
    });
    expect(() =>
      recordSentCopyOutcome(send, {
        attemptId: "unmarked-append",
        now: now + 4,
        mailboxId: "sent",
        outcome: { kind: "stored", uidValidity: "55", uid: 1 },
      }),
    ).toThrow(/risk mark/i);
  });

  it("rejects a late SMTP outcome and recovers it as delivery unknown", () => {
    let send = claimSubmission(queued(), {
      attemptId: "late-smtp",
      now,
      leaseMs: 1_000,
    });
    send = markSubmissionDeliveryRisk(send, {
      attemptId: "late-smtp",
      now: now + 500,
    });
    expect(() =>
      recordSmtpOutcome(send, {
        attemptId: "late-smtp",
        now: now + 1_001,
        outcome: {
          kind: "accepted",
          responseCode: 250,
          acceptedRecipients: ["friend@example.net"],
          rejectedRecipients: [],
        },
      }),
    ).toThrow(/outside/i);
    expect(recoverExpiredSubmission(send, { now: now + 1_000 }).phase).toBe(
      "delivery_unknown",
    );
  });

  it("stores partial recipient acceptance without making the original envelope retryable", () => {
    let send = createQueuedSubmission({
      ...queued().submission,
      envelope: {
        from: "me@example.com",
        to: ["accepted@example.net", "rejected@example.net"],
        cc: [],
        bcc: [],
      },
    });
    send = claimSubmission(send, {
      attemptId: "partial-smtp",
      now,
      leaseMs: 60_000,
    });
    send = markSubmissionDeliveryRisk(send, {
      attemptId: "partial-smtp",
      now: now + 1,
    });
    send = recordSmtpOutcome(send, {
      attemptId: "partial-smtp",
      now: now + 2,
      outcome: {
        kind: "accepted",
        responseCode: 250,
        acceptedRecipients: ["accepted@example.net"],
        rejectedRecipients: [
          {
            address: "rejected@example.net",
            responseCode: 550,
            retryable: false,
            errorCode: "mailbox_unavailable",
          },
        ],
      },
    });
    expect(send.smtpAcceptance?.rejectedRecipients).toHaveLength(1);
    expect(() =>
      claimSubmission(send, {
        attemptId: "must-not-resend-partial",
        now: now + 3,
        leaseMs: 60_000,
      }),
    ).toThrow(/accepted/i);

    send = claimSentCopy(send, {
      attemptId: "partial-append",
      now: now + 3,
      leaseMs: 60_000,
    });
    send = markSentCopyDeliveryRisk(send, {
      attemptId: "partial-append",
      now: now + 4,
    });
    send = recordSentCopyOutcome(send, {
      attemptId: "partial-append",
      now: now + 5,
      mailboxId: "sent",
      outcome: { kind: "stored", uidValidity: "55", uid: 902 },
    });
    expect(send.phase).toBe("partially_sent");
  });

  it("makes UID-less success and permanent APPEND rejection non-retryable", () => {
    let uidless = claimSubmission(queued(), {
      attemptId: "uidless-smtp",
      now,
      leaseMs: 60_000,
    });
    uidless = recordAccepted(uidless, "uidless-smtp", now + 1);
    uidless = claimSentCopy(uidless, {
      attemptId: "uidless-append",
      now: now + 2,
      leaseMs: 60_000,
    });
    uidless = markSentCopyDeliveryRisk(uidless, {
      attemptId: "uidless-append",
      now: now + 3,
    });
    uidless = recordSentCopyOutcome(uidless, {
      attemptId: "uidless-append",
      now: now + 4,
      mailboxId: "sent",
      outcome: { kind: "stored_without_uid" },
    });
    expect(uidless.phase).toBe("sent_copy_unknown");
    expect(() =>
      claimSentCopy(uidless, {
        attemptId: "unsafe-uidless-retry",
        now: now + 5,
        leaseMs: 60_000,
      }),
    ).toThrow(/reconciliation/i);

    let permanent = claimSubmission(queued(), {
      attemptId: "permanent-smtp",
      now,
      leaseMs: 60_000,
    });
    permanent = recordAccepted(permanent, "permanent-smtp", now + 1);
    permanent = claimSentCopy(permanent, {
      attemptId: "permanent-append",
      now: now + 2,
      leaseMs: 60_000,
    });
    permanent = recordSentCopyOutcome(permanent, {
      attemptId: "permanent-append",
      now: now + 3,
      mailboxId: "sent",
      outcome: {
        kind: "rejected",
        retryable: false,
        errorCode: "append_permission_denied",
      },
    });
    expect(permanent.phase).toBe("sent_copy_failed");
    expect(permanent.sentCopyRetryAt).toBeNull();
  });

  it("accepts only a final SMTP 250 response and fails closed on corrupt state", () => {
    let send = claimSubmission(queued(), {
      attemptId: "wrong-success-code",
      now,
      leaseMs: 60_000,
    });
    send = markSubmissionDeliveryRisk(send, {
      attemptId: "wrong-success-code",
      now: now + 1,
    });
    expect(() =>
      recordSmtpOutcome(send, {
        attemptId: "wrong-success-code",
        now: now + 2,
        outcome: {
          kind: "accepted",
          responseCode: 220,
          acceptedRecipients: ["friend@example.net"],
          rejectedRecipients: [],
        },
      }),
    ).toThrow(/250/i);
    expect(() =>
      recordSmtpOutcome(send, {
        attemptId: "wrong-success-code",
        now: now + 2,
        outcome: {
          kind: "transport_error",
          deliveryRisk: "invalid" as "none",
          errorCode: "connection_lost",
        },
      }),
    ).toThrow(/delivery risk/i);

    const corrupt = {
      ...queued(),
      phase: "sent" as const,
      attemptCount: 1,
      sentCopyAttemptCount: 1,
      sentCopy: { mailboxId: "sent", uidValidity: "55", uid: 1 },
    };
    expect(() =>
      claimSubmission(corrupt, {
        attemptId: "must-not-run",
        now,
        leaseMs: 60_000,
      }),
    ).toThrow(/acceptance metadata/i);
  });

  it("stops transient SMTP retries permanently at the attempt cap", () => {
    let send = queued();
    let clock = now;
    for (let attempt = 1; attempt <= SMTP_MAX_ATTEMPTS; attempt += 1) {
      send = claimSubmission(send, {
        attemptId: `capped-attempt-${attempt}`,
        now: clock,
        leaseMs: 60_000,
      });
      send = recordSmtpOutcome(send, {
        attemptId: `capped-attempt-${attempt}`,
        now: clock + 1,
        outcome: {
          kind: "transport_error",
          deliveryRisk: "none",
          errorCode: "connect_timeout",
        },
      });
      if (attempt < SMTP_MAX_ATTEMPTS) {
        expect(send.phase).toBe("retry_wait");
        clock = send.retryAt!;
      }
    }
    expect(send.attemptCount).toBe(SMTP_MAX_ATTEMPTS);
    expect(send.phase).toBe("failed");
    expect(send.lastErrorCode).toBe("smtp_attempts_exhausted");
    expect(submissionRunnableAt(send)).toBeNull();
  });

  it("resolves an ambiguous Sent copy through Message-ID reconciliation", () => {
    let send = claimSubmission(queued(), {
      attemptId: "reconcile-smtp",
      now,
      leaseMs: 60_000,
    });
    send = recordAccepted(send, "reconcile-smtp", now + 1);
    send = claimSentCopy(send, {
      attemptId: "reconcile-append",
      now: now + 2,
      leaseMs: 1_000,
    });
    send = markSentCopyDeliveryRisk(send, {
      attemptId: "reconcile-append",
      now: now + 3,
    });
    const unknown = recoverExpiredSentCopy(send, { now: now + 2_000 });
    expect(unknown.phase).toBe("sent_copy_unknown");

    const found = reconcileSentCopyFound(unknown, {
      now: now + 3_000,
      mailboxId: "sent",
      uidValidity: "77",
      uid: 4321,
    });
    expect(found.phase).toBe("sent");
    expect(found.sentCopy).toEqual({
      mailboxId: "sent",
      uidValidity: "77",
      uid: 4321,
    });

    const absent = reconcileSentCopyAbsent(unknown, { now: now + 3_000 });
    expect(absent.phase).toBe("sent_copy_pending");
    expect(absent.sentCopyRetryAt).toBeGreaterThan(now + 3_000);
    expect(absent.lastErrorCode).toBe("sent_copy_reconciled_absent");
    expect(() =>
      claimSentCopy(absent, {
        attemptId: "safe-append-retry",
        now: absent.sentCopyRetryAt!,
        leaseMs: 60_000,
      }),
    ).not.toThrow();

    expect(() =>
      reconcileSentCopyFound(found, {
        now: now + 4_000,
        mailboxId: "sent",
        uidValidity: "77",
        uid: 4321,
      }),
    ).toThrow(/ambiguous/i);
  });

  it("resolves delivery_unknown only through a located Sent Message-ID", () => {
    let send = claimSubmission(queued(), {
      attemptId: "unknown-smtp",
      now,
      leaseMs: 60_000,
    });
    send = markSubmissionDeliveryRisk(send, {
      attemptId: "unknown-smtp",
      now: now + 1,
    });
    send = recordSmtpOutcome(send, {
      attemptId: "unknown-smtp",
      now: now + 2,
      outcome: {
        kind: "transport_error",
        deliveryRisk: "possible",
        errorCode: "connection_lost_after_data",
      },
    });
    expect(send.phase).toBe("delivery_unknown");

    const reconciled = reconcileDeliveryUnknownFound(send, {
      now: now + 5_000,
      mailboxId: "sent",
      uidValidity: "88",
      uid: 12,
    });
    expect(reconciled.phase).toBe("sent");
    expect(reconciled.acceptedAt).toBe(now + 5_000);
    expect(reconciled.smtpAcceptance).toEqual({
      responseCode: 250,
      acceptedRecipients: ["friend@example.net"],
      rejectedRecipients: [],
    });
    expect(reconciled.sentCopy).toEqual({
      mailboxId: "sent",
      uidValidity: "88",
      uid: 12,
    });
    expect(() =>
      claimSubmission(reconciled, {
        attemptId: "must-not-resend",
        now: now + 6_000,
        leaseMs: 60_000,
      }),
    ).toThrow(/accepted/i);
    expect(() =>
      reconcileDeliveryUnknownFound(reconciled, {
        now: now + 6_000,
        mailboxId: "sent",
        uidValidity: "88",
        uid: 12,
      }),
    ).toThrow(/unknown delivery/i);
  });

  it("rejects mutable or header-injection-prone submission identities", () => {
    expect(() =>
      createQueuedSubmission({
        ...queued().submission,
        messageId: "<ok@example.com>\r\nBcc: hidden@example.com",
      }),
    ).toThrow(/message id/i);
    expect(() =>
      createQueuedSubmission({
        ...queued().submission,
        rawMimeSha256: "not-a-hash",
      }),
    ).toThrow(/sha256/i);
    expect(() =>
      createQueuedSubmission({
        ...queued().submission,
        envelope: {
          ...queued().submission.envelope,
          to: ["friend@example.net", "friend@example.net"],
        },
      }),
    ).toThrow(/duplicate recipient/i);
  });

  it("enforces the outgoing MIME limit at the durable queue boundary", () => {
    expect(() =>
      createQueuedSubmission({
        ...queued().submission,
        rawMimeBytes: MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes,
      }),
    ).not.toThrow();
    expect(() =>
      createQueuedSubmission({
        ...queued().submission,
        rawMimeBytes: MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes + 1,
      }),
    ).toThrow(/outgoing raw message/i);
  });

  it("returns a deeply immutable state without mutating a deserialized input", () => {
    const persisted = structuredClone(queued());
    expect(Object.isFrozen(persisted.submission)).toBe(false);
    const claimed = claimSubmission(persisted, {
      attemptId: "immutable-attempt",
      now,
      leaseMs: 60_000,
    });
    expect(Object.isFrozen(persisted.submission)).toBe(false);
    (persisted.submission.envelope.to as string[])[0] = "changed@example.net";
    expect(claimed.submission.envelope.to).toEqual(["friend@example.net"]);
    expect(Object.isFrozen(claimed.submission.envelope.to)).toBe(true);
  });

  it("strictly restores persisted records and derives only safe runnable times", () => {
    const initial = queued();
    const submitting = claimSubmission(initial, {
      attemptId: "smtp-attempt-runnable",
      now,
      leaseMs: 60_000,
    });
    const retrying = recordSmtpOutcome(submitting, {
      attemptId: "smtp-attempt-runnable",
      now: now + 1,
      outcome: {
        kind: "transport_error",
        deliveryRisk: "none",
        errorCode: "connect_timeout",
      },
    });
    const accepted = recordAccepted(
      claimSubmission(initial, {
        attemptId: "smtp-attempt-accepted",
        now,
        leaseMs: 60_000,
      }),
      "smtp-attempt-accepted",
      now + 1,
    );
    const appending = claimSentCopy(accepted, {
      attemptId: "append-attempt-runnable",
      now: now + 2,
      leaseMs: 60_000,
    });
    const sent = recordSentCopyOutcome(
      markSentCopyDeliveryRisk(appending, {
        attemptId: "append-attempt-runnable",
        now: now + 3,
      }),
      {
        attemptId: "append-attempt-runnable",
        now: now + 4,
        mailboxId: "sent",
        outcome: { kind: "stored", uidValidity: "55", uid: 1 },
      },
    );

    const cases = [
      [initial, now],
      [submitting, submitting.lease!.expiresAt],
      [retrying, retrying.retryAt],
      [accepted, accepted.sentCopyRetryAt],
      [appending, appending.sentCopyLease!.expiresAt],
      [sent, null],
    ] as const;
    for (const [state, runnableAt] of cases) {
      const restored = restoreSubmissionRecord(
        JSON.parse(JSON.stringify(state)),
      );
      expect(restored).toEqual(state);
      expect(Object.isFrozen(restored)).toBe(true);
      expect(Object.isFrozen(restored.submission.envelope.to)).toBe(true);
      expect(submissionRunnableAt(restored)).toBe(runnableAt);
    }
  });

  it("fails closed on extra, missing, or internally inconsistent persisted fields", () => {
    const extraTopLevel = { ...queued(), unexpected: true };
    expect(() => restoreSubmissionRecord(extraTopLevel)).toThrow(/persisted/i);

    const missingField = { ...queued() } as Record<string, unknown>;
    delete missingField.lastErrorCode;
    expect(() => restoreSubmissionRecord(missingField)).toThrow(/persisted/i);

    const extraEnvelope = structuredClone(queued()) as unknown as Record<
      string,
      unknown
    >;
    const submission = extraEnvelope.submission as Record<string, unknown>;
    submission.envelope = {
      ...(submission.envelope as Record<string, unknown>),
      unexpected: true,
    };
    expect(() => restoreSubmissionRecord(extraEnvelope)).toThrow(/persisted/i);

    const stalledSentCopy = {
      ...recordAccepted(
        claimSubmission(queued(), {
          attemptId: "smtp-attempt-stalled",
          now,
          leaseMs: 60_000,
        }),
        "smtp-attempt-stalled",
        now + 1,
      ),
      sentCopyRetryAt: null,
    };
    expect(() => restoreSubmissionRecord(stalledSentCopy)).toThrow(/persisted/i);
  });
});
