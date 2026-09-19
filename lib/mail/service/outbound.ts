import { createHash, randomUUID } from "node:crypto";

import type {
  MailSendInput,
  MailSendOperation,
  MailSendResult,
  MailSendStatus,
} from "../message-types";
import {
  validateMailSendAttachments,
  type MailSendAttachment,
} from "../send-attachment-codec";
import type { MailEnvelope } from "../ports";
import {
  buildOutboundRfc2822,
  type OutboundReplyHeaders,
} from "./outbound-message";

const ACCOUNT_ID_PATTERN = /^account-a[0-9a-f]{32}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_ID_PATTERN = /^send-[0-9a-f-]{36}$/;
const CACHE_MESSAGE_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const PROVIDER_RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const RFC_MESSAGE_ID_PATTERN = /^<[^<>\s\u0000-\u001f\u007f]+>$/u;
const MAX_SUBJECT_BYTES = 998;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ADDRESS_BYTES = 254;
const MAX_RECIPIENTS = 100;
const MAX_REPLY_REFERENCES = 50;
const MAX_REPLY_REFERENCES_BYTES = 32 * 1024;
const MAX_RFC_MESSAGE_ID_BYTES = 998;
const SEND_LEASE_MS = 60_000;
const MIN_SEND_RETRY_MS = 5_000;
const MAX_SEND_RETRY_MS = 30 * 60_000;

export type MailSendErrorCode =
  | "mail_send_request_invalid"
  | "mail_send_account_not_found"
  | "mail_send_account_reauth_required"
  | "mail_send_reply_target_not_found"
  | "mail_send_idempotency_conflict"
  | "mail_send_operation_not_found"
  | "mail_send_rate_limited"
  | "mail_send_service_unavailable";

export class MailSendError extends Error {
  /** WHETHER THE MESSAGE WAS ALREADY DURABLE WHEN THIS FAILED.
   *
   *  `send` enqueues the proposal and only then delivers, so a failure on
   *  either side of that line means something different to the caller: before
   *  it, nothing happened and a fresh idempotency key is safe; after it, the
   *  outbox holds the message and will deliver it, so a fresh key sends the
   *  recipient two copies. The socket is fine in both cases, so nothing above
   *  this service can tell them apart. False unless the throw sits after the
   *  enqueue, which is the safe reading of a failure nobody marked. */
  readonly enqueued: boolean;

  /** What the code alone cannot say, for the log and for the thrown error.
   *  A size refusal names the size; the wire still carries only the code. */
  readonly detail: string | null;

  constructor(
    readonly code: MailSendErrorCode,
    options: { readonly enqueued?: boolean; readonly detail?: string } = {},
  ) {
    super(options.detail === undefined ? code : `${code}: ${options.detail}`);
    this.name = "MailSendError";
    this.enqueued = options.enqueued === true;
    this.detail = options.detail ?? null;
  }
}

/** The same failure, told from after the durable enqueue. Anything that is not
 *  this service's own error is an outage as far as the caller is concerned,
 *  and it is no less enqueued for being untyped. */
function afterEnqueue(error: unknown): MailSendError {
  if (error instanceof MailSendError && error.enqueued) return error;
  return new MailSendError(
    error instanceof MailSendError ? error.code : "mail_send_service_unavailable",
    { enqueued: true },
  );
}

export interface MailSendRequestContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface MailSendService {
  send(input: unknown, request: MailSendRequestContext): Promise<MailSendResult>;
  status(operationId: string): Promise<MailSendOperation>;
}

export interface MailSendAccount {
  readonly accountId: string;
  readonly providerKind: "gmail" | "imap";
  readonly emailAddress: string;
  readonly status: "connected" | "reauth_required";
  /** True only when this concrete account has an active send transport. */
  readonly sendConfigured?: boolean;
}

export interface MailSendAccountResolver {
  readSendAccount(accountId: string): Promise<MailSendAccount | null>;
}

export interface MailReplyContext {
  /** Provider thread handle. Gmail requires it in messages.send. */
  readonly providerThreadId: string | null;
  readonly rfcMessageId: string;
  readonly references: readonly string[];
}

export interface MailReplyContextResolver {
  /**
   * Must return only a cached message belonging to accountId. A missing target,
   * or a cached message without a trustworthy RFC Message-ID, must resolve to
   * null. The client-supplied reply id is never used as an RFC header value.
   */
  resolveReplyContext(
    accountId: string,
    cachedMessageId: string,
  ): Promise<MailReplyContext | null>;
}

export interface MailSendProviderMessage {
  readonly operationId: string;
  readonly accountId: string;
  readonly messageId: string;
  readonly envelope: MailEnvelope;
  readonly rawRfc2822: Buffer;
  readonly providerThreadId: string | null;
}

export interface MailSendProviderHooks {
  /** Persist delivery risk before the first request byte can leave the process. */
  beforeDelivery(): Promise<void>;
}

export type MailSendProviderOutcome =
  | {
      readonly kind: "accepted";
      readonly providerMessageId: string;
      readonly providerThreadId: string;
    }
  | {
      readonly kind: "rejected";
      readonly errorCode: MailSendErrorCode;
    }
  | {
      readonly kind: "retryable_rejection";
      readonly errorCode:
        | "mail_send_rate_limited"
        | "mail_send_service_unavailable";
      readonly retryAfterMs: number | null;
    }
  | {
      readonly kind: "delivery_unknown";
      readonly errorCode: "mail_send_service_unavailable";
    };

export interface MailSendProvider {
  readonly providerKind: MailSendAccount["providerKind"];
  send(
    message: MailSendProviderMessage,
    hooks: MailSendProviderHooks,
    request: MailSendRequestContext,
  ): Promise<MailSendProviderOutcome>;
}

export interface StoredMailSendMessage {
  readonly messageId: string;
  readonly envelope: MailEnvelope;
  readonly providerThreadId: string | null;
  /**
   * The finished message as bytes, not as base64url.
   *
   * It used to be a string, and that string was the whole reason the outgoing
   * attachment cap came down to 5 MiB: the record held the message base64url'd,
   * the outbox row held `JSON.stringify` of that string, and the enqueue peaked
   * at 278 MiB with 10 MiB of files against `MemoryHigh=192M`. The row carries
   * a BLOB now (`raw_rfc2822`, schema 3) and the record carries the same bytes,
   * so the message exists once per turn on either side of the store, and the
   * same 10 MiB peaks at 190.7 MiB. The cap is 8 MiB.
   *
   * The two digests below stay beside it and are still what a read verifies:
   * they are what `smtp_submission_state` pins its identity on, and a BLOB can
   * be corrupted as easily as a string could.
   */
  readonly rawRfc2822: Buffer;
  readonly rawRfc2822Bytes: number;
  readonly rawRfc2822Sha256: string;
}

export interface MailSendLease {
  readonly attemptId: string;
  readonly expiresAt: number;
  readonly deliveryRisk: boolean;
}

export interface StoredMailSendSubmission {
  readonly version: number;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly accountId: string;
  readonly providerKind: MailSendAccount["providerKind"];
  readonly status: MailSendStatus;
  readonly attemptCount: number;
  readonly lease: MailSendLease | null;
  readonly message: StoredMailSendMessage;
  readonly providerMessageId: string | null;
  readonly providerThreadId: string | null;
  readonly lastErrorCode: MailSendErrorCode | null;
  /** Earliest safe retry time. Present only while status is queued. */
  readonly nextAttemptAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MailSendEnqueueResult {
  readonly created: boolean;
  readonly submission: StoredMailSendSubmission;
}

/**
 * enqueue must atomically enforce uniqueness of (accountId, idempotencyKey).
 * Reuse with a different requestFingerprint must throw
 * MailSendError("mail_send_idempotency_conflict").
 */
export interface MailSendStore {
  enqueue(submission: StoredMailSendSubmission): Promise<MailSendEnqueueResult>;
  readByOperationId(operationId: string): Promise<StoredMailSendSubmission | null>;
  compareAndSwap(
    operationId: string,
    expectedVersion: number,
    next: StoredMailSendSubmission,
  ): Promise<boolean>;
}

/** Which operation, in which account.
 *
 *  What a queue listing carries, and all it carries. A listing that returned
 *  whole submissions would hold every message in the batch for the length of
 *  the pass, while the worker delivers them one at a time — twenty at the
 *  attachment cap is 219 MiB of message against `MemoryMax=256M`. */
export interface MailSendSubmissionIdentity {
  readonly accountId: string;
  readonly operationId: string;
}

export interface MailSendQueueStore {
  listRunnable(
    now: number,
    limit: number,
  ): Promise<readonly MailSendSubmissionIdentity[]>;
  nextRunnableAt(): Promise<number | null>;
  countActive(): Promise<number>;
}

export class ProviderNeutralMailSendService implements MailSendService {
  private readonly store: MailSendStore;
  private readonly accounts: MailSendAccountResolver;
  private readonly replies: MailReplyContextResolver;
  private readonly providers: ReadonlyMap<MailSendAccount["providerKind"], MailSendProvider>;
  private readonly now: () => number;
  private readonly createOperationId: () => string;

  constructor(options: {
    readonly store: MailSendStore;
    readonly accounts: MailSendAccountResolver;
    readonly replies: MailReplyContextResolver;
    readonly providers: readonly MailSendProvider[];
    readonly now?: () => number;
    readonly createOperationId?: () => string;
  }) {
    this.store = options.store;
    this.accounts = options.accounts;
    this.replies = options.replies;
    const providers = new Map<MailSendAccount["providerKind"], MailSendProvider>();
    for (const provider of options.providers) {
      if (providers.has(provider.providerKind)) {
        throw new Error("duplicate mail send provider");
      }
      providers.set(provider.providerKind, provider);
    }
    this.providers = providers;
    this.now = options.now ?? Date.now;
    this.createOperationId = options.createOperationId ?? (() => `send-${randomUUID()}`);
  }

  async send(rawInput: unknown, request: MailSendRequestContext): Promise<MailSendResult> {
    const input = validateMailSendInput(rawInput);
    this.assertRequestActive(request);
    const account = await this.accounts.readSendAccount(input.accountId);
    this.assertRequestActive(request);
    if (account === null || account.accountId !== input.accountId) {
      throw new MailSendError("mail_send_account_not_found");
    }
    if (account.status === "reauth_required") {
      throw new MailSendError("mail_send_account_reauth_required");
    }
    const provider = this.providers.get(account.providerKind);
    if (!provider && account.providerKind !== "imap") {
      throw new MailSendError("mail_send_service_unavailable");
    }
    if (account.providerKind === "imap" && account.sendConfigured !== true) {
      throw new MailSendError("mail_send_service_unavailable");
    }

    const reply = await this.resolveReply(input);
    this.assertRequestActive(request);
    const createdAt = this.now();
    const operationId = validateMailSendOperationId(this.createOperationId());
    // Build and enqueue are one held turn. The built message stays in memory
    // until the row is written, so releasing the gate at the end of the build
    // let two requests hold two messages at the attachment cap at once — the
    // exact overlap the gate exists to refuse.
    const held = await runExclusiveOutboundBuild(async () => {
      let built: StoredMailSendSubmission;
      try {
        built = createMailSendSubmissionProposal({
          account,
          input,
          reply,
          operationId,
          createdAt,
        });
      } catch (error) {
        if (error instanceof MailSendError) throw error;
        throw new MailSendError("mail_send_request_invalid");
      }
      try {
        return Object.freeze({
          proposal: built,
          enqueued: await this.store.enqueue(built),
        });
      } catch (error) {
        if (error instanceof MailSendError) throw error;
        throw new MailSendError("mail_send_service_unavailable");
      }
    });
    const proposal: StoredMailSendSubmission = held.proposal;
    const enqueued: MailSendEnqueueResult = held.enqueued;
    if (
      enqueued.submission.accountId !== input.accountId ||
      enqueued.submission.providerKind !== account.providerKind ||
      enqueued.submission.idempotencyKey !== input.idempotencyKey ||
      enqueued.submission.requestFingerprint !== proposal.requestFingerprint
    ) {
      // The store answered with a submission this request does not recognise.
      // Something is durable under this key, and this is the wrong side of the
      // enqueue to tell the caller nothing happened.
      throw new MailSendError("mail_send_service_unavailable", {
        enqueued: true,
      });
    }

    // EVERYTHING BELOW RUNS AFTER THE MESSAGE IS DURABLE. The lease, the
    // provider call, the state writes around it: each of them can fail, and
    // each failure leaves the outbox holding a message it will deliver. The
    // caller is told that much rather than being handed a bare 503 it reads
    // as "nothing happened, send it again".
    let final: StoredMailSendSubmission;
    try {
      final = provider
        ? await this.deliverIfAvailable(enqueued.submission, provider, request)
        : enqueued.submission;
    } catch (error) {
      throw afterEnqueue(error);
    }
    return Object.freeze({
      apiVersion: 1,
      operationId: final.operationId,
      created: enqueued.created,
      status: final.status,
    });
  }

  /** Runs one already-durable operation. Used only by the background outbox. */
  async processOperation(
    rawOperationId: string,
    request: MailSendRequestContext,
  ): Promise<MailSendOperation> {
    const operationId = validateMailSendOperationId(rawOperationId);
    this.assertRequestActive(request);
    let current = await this.readRequired(operationId);
    current = await this.recoverExpiredLease(current);
    if (current.status !== "queued") return toPublicOperation(current);
    if (current.nextAttemptAt === null || current.nextAttemptAt > this.now()) {
      return toPublicOperation(current);
    }

    let account: MailSendAccount | null;
    try {
      account = await this.accounts.readSendAccount(current.accountId);
    } catch {
      return toPublicOperation(
        await this.deferQueuedOperation(
          current,
          "mail_send_service_unavailable",
          null,
        ),
      );
    }
    this.assertRequestActive(request);
    if (account === null || account.accountId !== current.accountId) {
      return toPublicOperation(
        await this.failQueuedOperation(current, "mail_send_account_not_found"),
      );
    }
    if (account.status === "reauth_required") {
      return toPublicOperation(
        await this.failQueuedOperation(
          current,
          "mail_send_account_reauth_required",
        ),
      );
    }
    if (account.providerKind !== current.providerKind) {
      return toPublicOperation(
        await this.failQueuedOperation(
          current,
          "mail_send_service_unavailable",
        ),
      );
    }
    if (account.providerKind === "imap") {
      // The atomic smtp_submission_state row owns this operation. The legacy
      // provider worker must leave it untouched even if called directly.
      return toPublicOperation(current);
    }
    const provider = this.providers.get(account.providerKind);
    if (!provider) {
      return toPublicOperation(
        await this.failQueuedOperation(
          current,
          "mail_send_service_unavailable",
        ),
      );
    }
    return toPublicOperation(
      await this.deliverIfAvailable(current, provider, request),
    );
  }

  async status(rawOperationId: string): Promise<MailSendOperation> {
    const operationId = validateMailSendOperationId(rawOperationId);
    let submission: StoredMailSendSubmission | null;
    try {
      submission = await this.store.readByOperationId(operationId);
    } catch {
      throw new MailSendError("mail_send_service_unavailable");
    }
    if (submission === null) {
      throw new MailSendError("mail_send_operation_not_found");
    }
    return toPublicOperation(submission);
  }

  private async resolveReply(input: MailSendInput): Promise<MailReplyContext | null> {
    if (input.mode === "compose") return null;
    const reply = await this.replies.resolveReplyContext(
      input.accountId,
      input.replyToMessageId!,
    );
    if (reply === null) {
      throw new MailSendError("mail_send_reply_target_not_found");
    }
    return validateReplyContext(reply);
  }

  private async deliverIfAvailable(
    initial: StoredMailSendSubmission,
    provider: MailSendProvider,
    request: MailSendRequestContext,
  ): Promise<StoredMailSendSubmission> {
    let current = await this.recoverExpiredLease(initial);
    if (current.status !== "queued") return current;
    if (current.nextAttemptAt === null || current.nextAttemptAt > this.now()) {
      return current;
    }
    this.assertRequestActive(request);

    const now = this.now();
    const claimed = transition(current, {
      status: "sending",
      attemptCount: current.attemptCount + 1,
      lease: {
        attemptId: `attempt-${randomUUID()}`,
        expiresAt: now + SEND_LEASE_MS,
        deliveryRisk: false,
      },
      lastErrorCode: null,
      nextAttemptAt: null,
      updatedAt: now,
    });
    if (!(await this.cas(current, claimed))) {
      return await this.readRequired(current.operationId);
    }
    current = claimed;

    let riskMarked = false;
    try {
      // The record's own bytes, verified against its digests. Nothing wipes
      // them on the way out: the record every transition below carries points
      // at this same buffer, and zeroing it would hand the compare-and-swap a
      // message that no longer matches the row it is swapping.
      const raw = verifyStoredRaw(current.message);
      const outcome = await provider.send(
        {
          operationId: current.operationId,
          accountId: current.accountId,
          messageId: current.message.messageId,
          envelope: current.message.envelope,
          rawRfc2822: raw,
          providerThreadId: current.message.providerThreadId,
        },
        {
          beforeDelivery: async () => {
            if (riskMarked || current.lease === null) {
              throw new MailSendError("mail_send_service_unavailable");
            }
            const marked = transition(current, {
              lease: { ...current.lease, deliveryRisk: true },
              updatedAt: this.now(),
            });
            if (!(await this.cas(current, marked))) {
              throw new MailSendError("mail_send_service_unavailable");
            }
            current = marked;
            riskMarked = true;
          },
        },
        request,
      );

      if (outcome.kind === "accepted") {
        if (!riskMarked) {
          throw new MailSendError("mail_send_service_unavailable");
        }
        const sent = transition(current, {
          status: "sent",
          lease: null,
          providerMessageId: validateProviderResourceId(outcome.providerMessageId),
          providerThreadId: validateProviderResourceId(outcome.providerThreadId),
          lastErrorCode: null,
          nextAttemptAt: null,
          updatedAt: this.now(),
        });
        if (!(await this.cas(current, sent))) {
          throw new MailSendError("mail_send_service_unavailable");
        }
        return sent;
      }
      if (outcome.kind === "delivery_unknown") {
        const unknown = transition(current, {
          status: "delivery_unknown",
          lease: null,
          lastErrorCode: outcome.errorCode,
          nextAttemptAt: null,
          updatedAt: this.now(),
        });
        if (!(await this.cas(current, unknown))) {
          throw new MailSendError("mail_send_service_unavailable");
        }
        return unknown;
      }
      if (outcome.kind === "retryable_rejection") {
        const retryNow = this.now();
        const retrying = transition(current, {
          status: "queued",
          lease: null,
          lastErrorCode: outcome.errorCode,
          nextAttemptAt: nextRetryAt(
            retryNow,
            current.attemptCount,
            outcome.retryAfterMs,
          ),
          updatedAt: retryNow,
        });
        if (!(await this.cas(current, retrying))) {
          return await this.readRequired(current.operationId);
        }
        return retrying;
      }
      const failed = transition(current, {
        status: "failed",
        lease: null,
        lastErrorCode: outcome.errorCode,
        nextAttemptAt: null,
        updatedAt: this.now(),
      });
      if (!(await this.cas(current, failed))) {
        throw new MailSendError("mail_send_service_unavailable");
      }
      // A definite provider rejection is a completed, durable send operation,
      // not an exceptional transport failure. Returning the persisted failed
      // state lets callers render the operation honestly and prevents the
      // catch path from accidentally rewriting it as queued/unknown.
      return failed;
    } catch (error) {
      if (error instanceof MailSendError && current.status !== "sending") throw error;
      const deliveryRisk = current.lease?.deliveryRisk === true;
      const retryNow = this.now();
      const safe = transition(current, {
        status: deliveryRisk ? "delivery_unknown" : "queued",
        lease: null,
        lastErrorCode: "mail_send_service_unavailable",
        nextAttemptAt: deliveryRisk
          ? null
          : nextRetryAt(retryNow, current.attemptCount, null),
        updatedAt: retryNow,
      });
      if (!(await this.cas(current, safe).catch(() => false))) {
        return await this.readRequired(current.operationId);
      }
      return safe;
    }
  }

  private async recoverExpiredLease(
    initial: StoredMailSendSubmission,
  ): Promise<StoredMailSendSubmission> {
    if (initial.status !== "sending") return initial;
    if (initial.lease === null) {
      throw new MailSendError("mail_send_service_unavailable");
    }
    if (this.now() < initial.lease.expiresAt) return initial;
    const deliveryRisk = initial.lease.deliveryRisk;
    const recoveredAt = this.now();
    const recovered = transition(initial, {
      status: deliveryRisk ? "delivery_unknown" : "queued",
      lease: null,
      lastErrorCode: "mail_send_service_unavailable",
      nextAttemptAt: deliveryRisk ? null : recoveredAt,
      updatedAt: recoveredAt,
    });
    if (await this.cas(initial, recovered)) return recovered;
    return await this.readRequired(initial.operationId);
  }

  private async failQueuedOperation(
    current: StoredMailSendSubmission,
    errorCode: MailSendErrorCode,
  ): Promise<StoredMailSendSubmission> {
    if (current.status !== "queued") return current;
    const failed = transition(current, {
      status: "failed",
      lease: null,
      lastErrorCode: errorCode,
      nextAttemptAt: null,
      updatedAt: this.now(),
    });
    if (await this.cas(current, failed)) return failed;
    return await this.readRequired(current.operationId);
  }

  private async deferQueuedOperation(
    current: StoredMailSendSubmission,
    errorCode:
      | "mail_send_rate_limited"
      | "mail_send_service_unavailable",
    retryAfterMs: number | null,
  ): Promise<StoredMailSendSubmission> {
    if (current.status !== "queued") return current;
    const now = this.now();
    const deferred = transition(current, {
      lastErrorCode: errorCode,
      nextAttemptAt: nextRetryAt(now, current.attemptCount, retryAfterMs),
      updatedAt: now,
    });
    if (await this.cas(current, deferred)) return deferred;
    return await this.readRequired(current.operationId);
  }

  private async cas(
    current: StoredMailSendSubmission,
    next: StoredMailSendSubmission,
  ): Promise<boolean> {
    try {
      return await this.store.compareAndSwap(
        current.operationId,
        current.version,
        next,
      );
    } catch {
      throw new MailSendError("mail_send_service_unavailable");
    }
  }

  private async readRequired(operationId: string): Promise<StoredMailSendSubmission> {
    const value = await this.store.readByOperationId(operationId);
    if (value === null) throw new MailSendError("mail_send_service_unavailable");
    return value;
  }

  private assertRequestActive(request: MailSendRequestContext): void {
    if (
      request.signal.aborted ||
      !Number.isSafeInteger(request.deadlineAt) ||
      this.now() >= request.deadlineAt
    ) {
      throw new MailSendError("mail_send_service_unavailable");
    }
  }
}

export function validateMailSendInput(value: unknown): MailSendInput {
  if (
    !isExactRecord(value, [
      "accountId",
      "agentLine",
      "attachments",
      "bcc",
      "cc",
      "idempotencyKey",
      "mode",
      "origin",
      "replyToMessageId",
      "subject",
      "text",
      "to",
    ]) ||
    (value.origin !== "app" && value.origin !== "mcp") ||
    typeof value.agentLine !== "boolean" ||
    typeof value.accountId !== "string" ||
    !ACCOUNT_ID_PATTERN.test(value.accountId) ||
    typeof value.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    (value.mode !== "compose" && value.mode !== "reply") ||
    typeof value.subject !== "string" ||
    Buffer.byteLength(value.subject) > MAX_SUBJECT_BYTES ||
    /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value.subject) ||
    typeof value.text !== "string" ||
    Buffer.byteLength(value.text) > MAX_TEXT_BYTES ||
    value.text.includes("\u0000")
  ) {
    throw new MailSendError("mail_send_request_invalid");
  }
  const to = validateRecipientList(value.to);
  const cc = validateRecipientList(value.cc);
  const bcc = validateRecipientList(value.bcc);
  const recipients = [...to, ...cc, ...bcc];
  if (recipients.length === 0 || recipients.length > MAX_RECIPIENTS) {
    throw new MailSendError("mail_send_request_invalid");
  }
  const seen = new Set<string>();
  for (const address of recipients) {
    const normalized = address.toLowerCase();
    if (seen.has(normalized)) {
      throw new MailSendError("mail_send_request_invalid");
    }
    seen.add(normalized);
  }
  const replyToMessageId = validateReplyTarget(value.replyToMessageId, value.mode);
  const attachments = validateSendAttachments(value.attachments);
  return Object.freeze({
    accountId: value.accountId,
    idempotencyKey: value.idempotencyKey,
    mode: value.mode,
    to: Object.freeze(to),
    cc: Object.freeze(cc),
    bcc: Object.freeze(bcc),
    subject: value.subject,
    text: value.text,
    replyToMessageId,
    attachments,
    origin: value.origin,
    agentLine: value.agentLine,
  });
}

function validateSendAttachments(
  value: unknown,
): readonly MailSendAttachment[] {
  try {
    return validateMailSendAttachments(value);
  } catch {
    throw new MailSendError("mail_send_request_invalid");
  }
}

export function validateMailSendOperationId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    throw new MailSendError("mail_send_request_invalid");
  }
  return value;
}

function validateRecipientList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_RECIPIENTS) {
    throw new MailSendError("mail_send_request_invalid");
  }
  return value.map((address) => {
    if (
      typeof address !== "string" ||
      Buffer.byteLength(address) === 0 ||
      Buffer.byteLength(address) > MAX_ADDRESS_BYTES ||
      address.includes("\r") ||
      address.includes("\n") ||
      !/^[^<>\s@]+@[^<>\s@]+$/.test(address)
    ) {
      throw new MailSendError("mail_send_request_invalid");
    }
    return address;
  });
}

function validateReplyTarget(value: unknown, mode: MailSendInput["mode"]): string | null {
  if (mode === "compose") {
    if (value !== null) throw new MailSendError("mail_send_request_invalid");
    return null;
  }
  if (typeof value !== "string" || !CACHE_MESSAGE_ID_PATTERN.test(value)) {
    throw new MailSendError("mail_send_request_invalid");
  }
  return value;
}

function validateReplyContext(value: MailReplyContext): MailReplyContext {
  if (
    !isExactRecord(value, ["providerThreadId", "references", "rfcMessageId"]) ||
    (value.providerThreadId !== null &&
      (typeof value.providerThreadId !== "string" ||
        !PROVIDER_RESOURCE_ID_PATTERN.test(value.providerThreadId))) ||
    !isRfcMessageId(value.rfcMessageId) ||
    !Array.isArray(value.references) ||
    value.references.length > MAX_REPLY_REFERENCES ||
    value.references.some((reference) => !isRfcMessageId(reference)) ||
    Buffer.byteLength(value.references.join(" ")) > MAX_REPLY_REFERENCES_BYTES
  ) {
    throw new MailSendError("mail_send_reply_target_not_found");
  }
  return Object.freeze({
    providerThreadId: value.providerThreadId,
    rfcMessageId: value.rfcMessageId,
    references: Object.freeze([...value.references]),
  });
}

function isRfcMessageId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_RFC_MESSAGE_ID_BYTES &&
    RFC_MESSAGE_ID_PATTERN.test(value)
  );
}

function toReplyHeaders(value: MailReplyContext): OutboundReplyHeaders {
  return Object.freeze({
    inReplyTo: value.rfcMessageId,
    references: value.references,
  });
}

function createMessageId(account: MailSendAccount, idempotencyKey: string): string {
  const domain = account.emailAddress.slice(account.emailAddress.lastIndexOf("@") + 1);
  if (!/^[^<>\s@]+$/.test(domain)) {
    throw new MailSendError("mail_send_request_invalid");
  }
  const digest = createHash("sha256")
    .update(account.accountId)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 40);
  return `<brain.${digest}@${domain}>`;
}

export function fingerprintMailSendInput(input: MailSendInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.accountId,
        input.mode,
        input.to,
        input.cc,
        input.bcc,
        input.subject,
        input.text,
        input.replyToMessageId,
        // Appended, never reordered: an existing stored fingerprint must keep
        // meaning what it meant. Each file is its own digest rather than the
        // whole base64, so the stringify above stays small; it used to be the
        // base64 LENGTH, which made two different files of the same size one
        // message, and a second send under the first key replayed the first
        // message instead of being refused as a conflict.
        input.origin,
        input.agentLine,
        input.attachments.map((attachment) => [
          attachment.filename,
          attachment.mimeType,
          createHash("sha256").update(attachment.dataBase64).digest("hex"),
        ]),
      ]),
    )
    .digest("hex");
}

export interface MailSendSubmissionProposalOptions {
  readonly account: MailSendAccount;
  readonly input: MailSendInput;
  readonly reply: MailReplyContext | null;
  readonly operationId: string;
  readonly createdAt: number;
}

/**
 * One outbound message in memory at a time, for the whole process. A send at
 * the attachment cap holds the decoded files and the finished message at once,
 * and the service runs under `MemoryHigh=192M`, so two of them overlapping is
 * the difference between a send and a killed process.
 *
 * The turn runs from the build to the end of the write that makes the message
 * durable, because the built message is in memory for all of it: `/v1/send`
 * holds it across `store.enqueue`, and the draft lane across
 * `commitDraftSend`. Every lane stands in this queue: a person's, an agent's,
 * and a draft's.
 */
let outboundBuildQueue: Promise<unknown> = Promise.resolve();

export function runExclusiveOutboundBuild<T>(
  build: () => T | Promise<T>,
): Promise<T> {
  const result = outboundBuildQueue.then(build, build);
  // A failed build releases the queue like any other, and the rejection
  // belongs to its own caller rather than to the send that comes next.
  outboundBuildQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function createMailSendSubmissionProposal(
  options: MailSendSubmissionProposalOptions,
): StoredMailSendSubmission {
  const messageId = createMessageId(options.account, options.input.idempotencyKey);
  const reply =
    options.reply === null ? null : validateReplyContext(options.reply);
  const attachments: {
    readonly filename: string;
    readonly mimeType: string;
    readonly bytes: Buffer;
  }[] = [];
  try {
    // Decoded inside the try, so a throw part way down the list still leaves
    // nothing decoded behind for the wipe below to miss.
    for (const attachment of options.input.attachments) {
      attachments.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        bytes: Buffer.from(attachment.dataBase64, "base64"),
      });
    }
    const built = buildOutboundRfc2822({
      from: options.account.emailAddress,
      to: options.input.to,
      cc: options.input.cc,
      bcc: options.input.bcc,
      subject: options.input.subject,
      text: options.input.text,
      messageId,
      createdAt: options.createdAt,
      reply: reply === null ? null : toReplyHeaders(reply),
      attachments,
      origin: options.input.origin,
      agentLine: options.input.agentLine,
    });
    return freezeSubmission({
      version: 0,
      operationId: options.operationId,
      idempotencyKey: options.input.idempotencyKey,
      requestFingerprint: fingerprintMailSendInput(options.input),
      accountId: options.account.accountId,
      providerKind: options.account.providerKind,
      status: "queued",
      attemptCount: 0,
      lease: null,
      message: {
        messageId,
        envelope: built.envelope,
        providerThreadId: reply?.providerThreadId ?? null,
        rawRfc2822: built.rawRfc2822,
        rawRfc2822Bytes: built.rawRfc2822.byteLength,
        rawRfc2822Sha256: createHash("sha256")
          .update(built.rawRfc2822)
          .digest("hex"),
      },
      providerMessageId: null,
      providerThreadId: null,
      lastErrorCode: null,
      nextAttemptAt: options.createdAt,
      createdAt: options.createdAt,
      updatedAt: options.createdAt,
    });
  } finally {
    // The attachments were decoded here and nothing else holds them, so they
    // go. The finished message stays: it is the record's own `rawRfc2822`, the
    // bytes the outbox row is written from and the transport sends. It lives
    // until the queued submission is written and collected, which is one turn,
    // the same lifetime the base64url string had before it.
    for (const attachment of attachments) attachment.bytes.fill(0);
  }
}

/** Rebuilds the immutable version-zero proposal needed to verify a replay. */
export function mailSendSubmissionReplayProposal(
  current: StoredMailSendSubmission,
): StoredMailSendSubmission {
  return freezeSubmission({
    ...current,
    version: 0,
    status: "queued",
    attemptCount: 0,
    lease: null,
    providerMessageId: null,
    providerThreadId: null,
    lastErrorCode: null,
    nextAttemptAt: current.createdAt,
    updatedAt: current.createdAt,
  });
}

/**
 * The stored message, checked against the digests stored beside it.
 *
 * No decode any more: the store read the BLOB and the record carries those
 * bytes, so this verifies rather than converts, and what it returns is the
 * record's own buffer rather than a second copy of the message.
 */
function verifyStoredRaw(message: StoredMailSendMessage): Buffer {
  if (
    !Buffer.isBuffer(message.rawRfc2822) ||
    !Number.isSafeInteger(message.rawRfc2822Bytes) ||
    message.rawRfc2822Bytes < 1 ||
    !/^[a-f0-9]{64}$/.test(message.rawRfc2822Sha256)
  ) {
    throw new MailSendError("mail_send_service_unavailable");
  }
  const raw = message.rawRfc2822;
  if (
    raw.byteLength !== message.rawRfc2822Bytes ||
    createHash("sha256").update(raw).digest("hex") !== message.rawRfc2822Sha256
  ) {
    throw new MailSendError("mail_send_service_unavailable");
  }
  return raw;
}

function validateProviderResourceId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_RESOURCE_ID_PATTERN.test(value)) {
    throw new MailSendError("mail_send_service_unavailable");
  }
  return value;
}

function transition(
  current: StoredMailSendSubmission,
  patch: Partial<StoredMailSendSubmission>,
): StoredMailSendSubmission {
  return freezeSubmission({
    ...current,
    ...patch,
    version: current.version + 1,
  });
}

function nextRetryAt(
  now: number,
  attemptCount: number,
  retryAfterMs: number | null,
): number {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(attemptCount) ||
    attemptCount < 0 ||
    (retryAfterMs !== null &&
      (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0))
  ) {
    throw new MailSendError("mail_send_service_unavailable");
  }
  const exponent = Math.min(Math.max(0, attemptCount - 1), 12);
  const exponential = Math.min(
    MAX_SEND_RETRY_MS,
    MIN_SEND_RETRY_MS * 2 ** exponent,
  );
  const delay = Math.min(
    MAX_SEND_RETRY_MS,
    Math.max(exponential, retryAfterMs ?? 0),
  );
  const value = now + delay;
  if (!Number.isSafeInteger(value)) {
    throw new MailSendError("mail_send_service_unavailable");
  }
  return value;
}

function freezeSubmission(value: StoredMailSendSubmission): StoredMailSendSubmission {
  return Object.freeze({
    ...value,
    lease: value.lease === null ? null : Object.freeze({ ...value.lease }),
    message: Object.freeze({
      ...value.message,
      envelope: Object.freeze({
        ...value.message.envelope,
        to: Object.freeze([...value.message.envelope.to]),
        cc: Object.freeze([...value.message.envelope.cc]),
        bcc: Object.freeze([...value.message.envelope.bcc]),
      }),
    }),
  });
}

function toPublicOperation(value: StoredMailSendSubmission): MailSendOperation {
  return Object.freeze({
    apiVersion: 1,
    operationId: value.operationId,
    // The account the row lives in, so a caller writing anything against this
    // operation names the account the operation has rather than one it typed.
    accountId: value.accountId,
    status: value.status,
    // The provider's own thread for the Sent copy. First-party SMTP acceptance
    // issues no ids, so an IMAP account answers null and a caller that wants
    // the thread has to find it after the next sync.
    threadId: value.providerThreadId,
  });
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
