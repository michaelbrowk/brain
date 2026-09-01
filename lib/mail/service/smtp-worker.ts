import { randomUUID } from "node:crypto";

import type {
  ImapAppendHooks,
  ImapAppendOutcome,
  MailEnvelope,
  SmtpSubmissionHooks,
  SmtpSubmissionOutcome,
} from "../ports";
import {
  claimSentCopy,
  claimSubmission,
  markSentCopyDeliveryRisk,
  markSubmissionDeliveryRisk,
  reconcileDeliveryUnknownFound,
  reconcileSentCopyAbsent,
  reconcileSentCopyFound,
  recordSentCopyOutcome,
  recordSmtpOutcome,
  recoverExpiredSentCopy,
  recoverExpiredSubmission,
  submissionRunnableAt,
  type SubmissionRecord,
} from "../send-state";
import { MAIL_RESOURCE_LIMITS } from "../security";
import type {
  MailSmtpSubmissionIdentity,
  MailSmtpSubmissionWorkStore,
} from "./smtp-state-store";

const DEFAULT_INITIAL_DELAY_MS = 0;
const DEFAULT_CONTINUATION_DELAY_MS = 250;
const DEFAULT_IDLE_RETRY_MS = 5_000;
const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;
const MAX_DELAY_MS = 24 * 60 * 60 * 1_000;
const SUBMIT_LEASE_MS = 2 * 60_000;
const SENT_COPY_LEASE_MS = 2 * 60_000;
const SESSION_MARGIN_MS = 5_000;
const MAX_RECONCILES_PER_PASS = 5;
const RECONCILE_BASE_MS = 60_000;
const RECONCILE_CAP_MS = 60 * 60_000;
const MAX_RECONCILE_BACKOFF_ENTRIES = 512;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;

/** One claimed SMTP attempt handed to the wire transport. */
export interface MailSmtpSubmissionAttempt {
  readonly accountId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly messageId: string;
  readonly envelope: MailEnvelope;
  /** Worker-owned raw RFC 2822 bytes, wiped by the worker after the attempt. */
  readonly raw: Buffer;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

/**
 * Wire boundary for one SMTP submission. The implementation must await
 * hooks.beforeData() after the 354 continuation and before the first DATA
 * byte, and must never emit an accepted outcome without that barrier.
 */
export interface MailSmtpSubmissionTransport {
  submit(
    attempt: MailSmtpSubmissionAttempt,
    hooks: SmtpSubmissionHooks,
  ): Promise<SmtpSubmissionOutcome>;
}

export interface MailSmtpAccountLifecyclePort {
  markSmtpReauthRequired(accountId: string): Promise<void>;
}

export type MailSentCopyLookup =
  | {
      readonly kind: "found";
      readonly mailboxId: string;
      readonly uidValidity: string;
      readonly uid: number;
    }
  | { readonly kind: "absent"; readonly mailboxId: string }
  | { readonly kind: "unavailable"; readonly errorCode: string };

export interface MailSentCopyFindRequest {
  readonly accountId: string;
  readonly messageId: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface MailSentCopyAppendRequest {
  readonly accountId: string;
  readonly operationId: string;
  readonly messageId: string;
  /** Worker-owned raw RFC 2822 bytes, wiped by the worker after the attempt. */
  readonly raw: Buffer;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface MailSentCopyAppendResult {
  readonly mailboxId: string;
  readonly outcome: ImapAppendOutcome;
}

/**
 * IMAP boundary for the Sent copy. findByMessageId is the duplicate-avoidance
 * and reconciliation probe; append must await hooks.beforeLiteral() before the
 * first literal byte reaches the connection.
 */
export interface MailSentCopyPort {
  findByMessageId(request: MailSentCopyFindRequest): Promise<MailSentCopyLookup>;
  append(
    request: MailSentCopyAppendRequest,
    hooks: ImapAppendHooks,
  ): Promise<MailSentCopyAppendResult>;
}

export type MailSmtpWorkerEvent =
  | Readonly<{
      event: "mail_smtp_worker_failed";
      errorCode: "operation_failed" | "queue_unavailable";
    }>
  | Readonly<{ event: "mail_smtp_worker_recovered" }>
  | Readonly<{
      event: "mail_smtp_operation_settled";
      accountId: string;
      operationId: string;
      phase: string;
    }>;

interface PassResult {
  readonly listed: number;
  readonly failures: number;
}

/**
 * Serialized durable SMTP submission worker. It owns every IMAP-provider
 * operation: claims are optimistic compare-and-swap transitions on the
 * persisted submission state, so a restarted process, a concurrent worker, or
 * the legacy outbox worker can never run the same attempt twice. Recovery of
 * an expired lease is itself a compare-and-swap transition, and an operation
 * that reached the DATA barrier is never retried without reconciliation.
 */
export class MailSmtpSubmissionWorker {
  private readonly store: MailSmtpSubmissionWorkStore;
  private readonly transport: MailSmtpSubmissionTransport;
  private readonly sentCopy: MailSentCopyPort;
  private readonly accountLifecycle: MailSmtpAccountLifecyclePort | undefined;
  private readonly now: () => number;
  private readonly initialDelayMs: number;
  private readonly continuationDelayMs: number;
  private readonly idleRetryMs: number;
  private readonly batchSize: number;
  private readonly onEvent: (event: MailSmtpWorkerEvent) => void;
  private readonly invalidatedAccounts = new Set<string>();
  private readonly reconcileBackoff = new Map<
    string,
    { attempts: number; nextAt: number }
  >();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private activeAccountOperation: {
    readonly accountId: string;
    readonly controller: AbortController;
    readonly done: Promise<void>;
    finish(): void;
  } | null = null;
  private commandTail: Promise<void> = Promise.resolve();
  private started = false;
  private unhealthy = false;

  constructor(options: {
    readonly store: MailSmtpSubmissionWorkStore;
    readonly transport: MailSmtpSubmissionTransport;
    readonly sentCopy: MailSentCopyPort;
    readonly accountLifecycle?: MailSmtpAccountLifecyclePort;
    readonly now?: () => number;
    readonly initialDelayMs?: number;
    readonly continuationDelayMs?: number;
    readonly idleRetryMs?: number;
    readonly batchSize?: number;
    readonly onEvent?: (event: MailSmtpWorkerEvent) => void;
  }) {
    this.store = options.store;
    this.transport = options.transport;
    this.sentCopy = options.sentCopy;
    this.accountLifecycle = options.accountLifecycle;
    this.now = options.now ?? Date.now;
    this.initialDelayMs = validateDelay(
      options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
      0,
    );
    this.continuationDelayMs = validateDelay(
      options.continuationDelayMs ?? DEFAULT_CONTINUATION_DELAY_MS,
      1,
    );
    this.idleRetryMs = validateDelay(
      options.idleRetryMs ?? DEFAULT_IDLE_RETRY_MS,
      1,
    );
    this.batchSize = validateBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  /** Starts recovery of durable queued and expired-lease operations. */
  async start(): Promise<void> {
    await this.serialize(() => {
      if (this.started) return;
      this.started = true;
      this.schedule(this.initialDelayMs);
    });
  }

  /** Live admission signal used by capabilities and the send boundary. */
  isReady(): boolean {
    return this.started && !this.unhealthy;
  }

  /** Runs one pass now, joining an already-running pass instead of overlapping. */
  async runNow(): Promise<void> {
    const holder = await this.serialize(() => {
      this.clearTimer();
      return Object.freeze({ pass: this.inFlight ?? this.beginPass() });
    });
    await holder.pass;
  }

  /** Aborts the in-flight attempt and resolves only after it has drained. */
  async stop(): Promise<void> {
    await this.serialize(async () => {
      this.started = false;
      this.clearTimer();
      this.controller?.abort();
      await this.inFlight?.catch(() => undefined);
    });
  }

  /** Account-removal barrier: block new work, abort it, then drain it. */
  async invalidateAccount(accountIdInput: string): Promise<void> {
    const accountId = validateAccountId(accountIdInput);
    this.invalidatedAccounts.add(accountId);
    for (const key of [...this.reconcileBackoff.keys()]) {
      if (key.startsWith(`${accountId}:`)) this.reconcileBackoff.delete(key);
    }
    const active = this.activeAccountOperation;
    if (active?.accountId === accountId) {
      active.controller.abort();
      await active.done;
    }
  }

  /** Rollback hook when the authoritative account deletion did not commit. */
  async restoreInvalidatedAccount(accountIdInput: string): Promise<void> {
    const accountId = validateAccountId(accountIdInput);
    this.invalidatedAccounts.delete(accountId);
    await this.serialize(() => {
      if (this.started) {
        this.clearTimer();
        this.schedule(0);
      }
    });
  }

  private beginPass(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let nextDelayMs: number | null = null;
    const task = (async () => {
      let result: PassResult;
      let failureCode:
        | Extract<
            MailSmtpWorkerEvent,
            { readonly event: "mail_smtp_worker_failed" }
          >["errorCode"]
        | null = null;
      try {
        result = await this.runPass(controller.signal);
      } catch {
        failureCode = "queue_unavailable";
        result = Object.freeze({ listed: 0, failures: 1 });
      }
      if (result.failures > 0 && failureCode === null) {
        failureCode = "operation_failed";
      }
      if (!controller.signal.aborted && this.started) {
        try {
          nextDelayMs = await this.nextDelay(result);
        } catch {
          failureCode = "queue_unavailable";
          nextDelayMs = this.idleRetryMs;
        }
      }
      if (failureCode === null) {
        this.observeRecovery();
      } else {
        this.observeFailure(failureCode);
      }
    })().finally(() => {
      if (this.controller === controller) this.controller = null;
      if (this.inFlight === task) this.inFlight = null;
      if (this.started && !controller.signal.aborted && nextDelayMs !== null) {
        this.schedule(nextDelayMs);
      }
    });
    this.inFlight = task;
    return task;
  }

  private async runPass(signal: AbortSignal): Promise<PassResult> {
    const runnable = await this.store.listRunnableSmtpSubmissions(
      this.readNow(),
      this.batchSize,
    );
    let failures = 0;
    for (const identity of runnable) {
      if (signal.aborted) break;
      if (this.invalidatedAccounts.has(identity.accountId)) continue;
      try {
        await this.runAccountOperation(identity, signal, (accountSignal) =>
          this.processOne(identity, accountSignal),
        );
      } catch {
        failures += 1;
      }
    }
    if (!signal.aborted) {
      failures += await this.runReconciliationSlice(signal);
    }
    return Object.freeze({ listed: runnable.length, failures });
  }

  private async runReconciliationSlice(signal: AbortSignal): Promise<number> {
    const reconcilable = await this.store.listReconcilableSmtpSubmissions(
      this.batchSize,
    );
    let failures = 0;
    let attempted = 0;
    for (const identity of reconcilable) {
      if (signal.aborted || attempted >= MAX_RECONCILES_PER_PASS) break;
      if (this.invalidatedAccounts.has(identity.accountId)) continue;
      const key = `${identity.accountId}:${identity.operationId}`;
      const backoff = this.reconcileBackoff.get(key);
      if (backoff !== undefined && this.readNow() < backoff.nextAt) continue;
      attempted += 1;
      try {
        await this.runAccountOperation(identity, signal, (accountSignal) =>
          this.reconcileOne(identity, key, accountSignal),
        );
      } catch {
        failures += 1;
        this.deferReconcile(key);
      }
    }
    return failures;
  }

  private async runAccountOperation<T>(
    identity: MailSmtpSubmissionIdentity,
    passSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.invalidatedAccounts.has(identity.accountId)) {
      throw new Error("mail smtp account is invalidated");
    }
    const controller = new AbortController();
    const onPassAbort = () => controller.abort();
    if (passSignal.aborted) controller.abort();
    else passSignal.addEventListener("abort", onPassAbort, { once: true });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active = Object.freeze({
      accountId: identity.accountId,
      controller,
      done,
      finish,
    });
    this.activeAccountOperation = active;
    try {
      return await operation(controller.signal);
    } finally {
      passSignal.removeEventListener("abort", onPassAbort);
      if (this.activeAccountOperation === active) {
        this.activeAccountOperation = null;
      }
      finish();
    }
  }

  private async processOne(
    identity: MailSmtpSubmissionIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const state = await this.store.readSmtpSubmissionState(
      identity.accountId,
      identity.operationId,
    );
    if (state === null) return;
    const now = this.readNow();
    const runnableAt = submissionRunnableAt(state);
    if (runnableAt === null || runnableAt > now) return;

    if (state.phase === "submitting") {
      await this.settle(state, recoverExpiredSubmission(state, { now }));
      return;
    }
    if (state.phase === "queued" || state.phase === "retry_wait") {
      await this.submitOnce(identity, state, signal);
      return;
    }
    if (state.phase === "sent_copy_pending") {
      if (state.sentCopyLease !== null) {
        await this.settle(state, recoverExpiredSentCopy(state, { now }));
        return;
      }
      await this.appendOnce(identity, state, signal);
    }
  }

  private async submitOnce(
    identity: MailSmtpSubmissionIdentity,
    state: SubmissionRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const attemptId = `attempt-${randomUUID()}`;
    const claimed = claimSubmission(state, {
      attemptId,
      now: this.readNow(),
      leaseMs: SUBMIT_LEASE_MS,
    });
    if (!(await this.cas(state, claimed))) return;
    let current = claimed;
    const lease = claimed.lease!;
    const raw = await this.store.readSmtpSubmissionRaw(
      identity.accountId,
      identity.operationId,
    );
    try {
      if (raw === null) {
        await this.settle(
          current,
          recordSmtpOutcome(current, {
            attemptId,
            now: this.readNow(),
            outcome: {
              kind: "transport_error",
              deliveryRisk: "none",
              errorCode: "smtp_raw_unavailable",
            },
          }),
        );
        return;
      }
      const deadlineAt = Math.min(
        this.readNow() + MAIL_RESOURCE_LIMITS.egressTunnelSessionMs,
        lease.expiresAt - SESSION_MARGIN_MS,
      );
      let outcome: SmtpSubmissionOutcome;
      try {
        outcome = await this.transport.submit(
          {
            accountId: identity.accountId,
            operationId: identity.operationId,
            attemptId,
            messageId: current.submission.messageId,
            envelope: current.submission.envelope,
            raw,
            deadlineAt,
            signal,
          },
          {
            deadlineAt,
            beforeData: async () => {
              // Durable barrier: risk is persisted with compare-and-swap
              // before the first DATA byte may leave the process.
              const marked = markSubmissionDeliveryRisk(current, {
                attemptId,
                now: this.readNow(),
              });
              if (marked !== current && !(await this.cas(current, marked))) {
                throw new Error("smtp delivery-risk barrier lost its lease");
              }
              current = marked;
            },
          },
        );
      } catch {
        outcome = Object.freeze({
          kind: "transport_error" as const,
          deliveryRisk: current.lease?.deliveryRisk ?? "none",
          errorCode: "smtp_attempt_failed",
        });
      }
      if (
        outcome.kind === "rejected" &&
        outcome.errorCode === "smtp_auth_failed" &&
        this.accountLifecycle
      ) {
        // The durable phase is still `submitting`, so account protocol edits
        // remain blocked until this lifecycle transition finishes.
        await this.accountLifecycle.markSmtpReauthRequired(identity.accountId);
      }
      // A late outcome outside the lease is rejected here and settled by
      // expired-lease recovery instead; that path never risks a duplicate.
      await this.settle(
        current,
        recordSmtpOutcome(current, {
          attemptId,
          now: this.readNow(),
          outcome,
        }),
      );
    } finally {
      raw?.fill(0);
    }
  }

  private async appendOnce(
    identity: MailSmtpSubmissionIdentity,
    state: SubmissionRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const attemptId = `attempt-${randomUUID()}`;
    const claimed = claimSentCopy(state, {
      attemptId,
      now: this.readNow(),
      leaseMs: SENT_COPY_LEASE_MS,
    });
    if (!(await this.cas(state, claimed))) return;
    let current = claimed;
    const lease = claimed.sentCopyLease!;
    const deadlineAt = Math.min(
      this.readNow() + MAIL_RESOURCE_LIMITS.egressTunnelSessionMs,
      lease.expiresAt - SESSION_MARGIN_MS,
    );

    // Duplicate avoidance: the server may already hold the immutable
    // Message-ID (auto-saved copy or an earlier lost APPEND response).
    let lookup: MailSentCopyLookup;
    try {
      lookup = await this.sentCopy.findByMessageId({
        accountId: identity.accountId,
        messageId: current.submission.messageId,
        deadlineAt,
        signal,
      });
    } catch {
      lookup = Object.freeze({
        kind: "unavailable" as const,
        errorCode: "sent_copy_lookup_failed",
      });
    }
    if (lookup.kind === "found") {
      const marked = markSentCopyDeliveryRisk(current, {
        attemptId,
        now: this.readNow(),
      });
      if (!(await this.cas(current, marked))) return;
      current = marked;
      await this.settle(
        current,
        recordSentCopyOutcome(current, {
          attemptId,
          now: this.readNow(),
          mailboxId: lookup.mailboxId,
          outcome: {
            kind: "stored",
            uidValidity: lookup.uidValidity,
            uid: lookup.uid,
          },
        }),
      );
      return;
    }
    if (lookup.kind === "unavailable") {
      await this.settle(
        current,
        recordSentCopyOutcome(current, {
          attemptId,
          now: this.readNow(),
          mailboxId: "sent",
          outcome: {
            kind: "transport_error",
            deliveryRisk: "none",
            errorCode: lookup.errorCode,
          },
        }),
      );
      return;
    }

    const raw = await this.store.readSmtpSubmissionRaw(
      identity.accountId,
      identity.operationId,
    );
    try {
      if (raw === null) {
        await this.settle(
          current,
          recordSentCopyOutcome(current, {
            attemptId,
            now: this.readNow(),
            mailboxId: lookup.mailboxId,
            outcome: {
              kind: "transport_error",
              deliveryRisk: "none",
              errorCode: "sent_copy_raw_unavailable",
            },
          }),
        );
        return;
      }
      let result: MailSentCopyAppendResult;
      try {
        result = await this.sentCopy.append(
          {
            accountId: identity.accountId,
            operationId: identity.operationId,
            messageId: current.submission.messageId,
            raw,
            deadlineAt,
            signal,
          },
          {
            deadlineAt,
            beforeLiteral: async () => {
              const marked = markSentCopyDeliveryRisk(current, {
                attemptId,
                now: this.readNow(),
              });
              if (marked !== current && !(await this.cas(current, marked))) {
                throw new Error("sent copy barrier lost its lease");
              }
              current = marked;
            },
          },
        );
      } catch {
        result = Object.freeze({
          mailboxId: lookup.mailboxId,
          outcome: Object.freeze({
            kind: "transport_error" as const,
            deliveryRisk: current.sentCopyLease?.deliveryRisk ?? "none",
            errorCode: "sent_copy_attempt_failed",
          }),
        });
      }
      await this.settle(
        current,
        recordSentCopyOutcome(current, {
          attemptId,
          now: this.readNow(),
          mailboxId: result.mailboxId,
          outcome: result.outcome,
        }),
      );
    } finally {
      raw?.fill(0);
    }
  }

  private async reconcileOne(
    identity: MailSmtpSubmissionIdentity,
    backoffKey: string,
    signal: AbortSignal,
  ): Promise<void> {
    const state = await this.store.readSmtpSubmissionState(
      identity.accountId,
      identity.operationId,
    );
    if (
      state === null ||
      (state.phase !== "sent_copy_unknown" && state.phase !== "delivery_unknown")
    ) {
      this.reconcileBackoff.delete(backoffKey);
      return;
    }
    const deadlineAt =
      this.readNow() + MAIL_RESOURCE_LIMITS.egressTunnelSessionMs;
    const lookup = await this.sentCopy.findByMessageId({
      accountId: identity.accountId,
      messageId: state.submission.messageId,
      deadlineAt,
      signal,
    });
    if (lookup.kind === "unavailable") {
      this.deferReconcile(backoffKey);
      return;
    }
    const now = this.readNow();
    if (state.phase === "sent_copy_unknown") {
      const next =
        lookup.kind === "found"
          ? reconcileSentCopyFound(state, {
              now,
              mailboxId: lookup.mailboxId,
              uidValidity: lookup.uidValidity,
              uid: lookup.uid,
            })
          : reconcileSentCopyAbsent(state, { now });
      if (await this.cas(state, next)) {
        this.reconcileBackoff.delete(backoffKey);
        this.emitSettled(identity, next);
      }
      return;
    }
    if (lookup.kind === "found") {
      const next = reconcileDeliveryUnknownFound(state, {
        now,
        mailboxId: lookup.mailboxId,
        uidValidity: lookup.uidValidity,
        uid: lookup.uid,
      });
      if (await this.cas(state, next)) {
        this.reconcileBackoff.delete(backoffKey);
        this.emitSettled(identity, next);
      }
      return;
    }
    // Absence proves nothing about delivery. The operation stays
    // delivery_unknown for manual reconciliation; only probing backs off.
    this.deferReconcile(backoffKey);
  }

  private deferReconcile(key: string): void {
    const previous = this.reconcileBackoff.get(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = Math.min(
      RECONCILE_CAP_MS,
      RECONCILE_BASE_MS * 2 ** Math.min(attempts - 1, 10),
    );
    if (
      previous === undefined &&
      this.reconcileBackoff.size >= MAX_RECONCILE_BACKOFF_ENTRIES
    ) {
      const oldest = this.reconcileBackoff.keys().next().value;
      if (oldest !== undefined) this.reconcileBackoff.delete(oldest);
    }
    this.reconcileBackoff.set(key, {
      attempts,
      nextAt: this.readNow() + delay,
    });
  }

  private async settle(
    current: SubmissionRecord,
    next: SubmissionRecord,
  ): Promise<void> {
    if (await this.cas(current, next)) {
      this.emitSettled(
        {
          accountId: next.submission.accountId,
          operationId: next.submission.operationId,
        },
        next,
      );
    }
  }

  private async cas(
    current: SubmissionRecord,
    next: SubmissionRecord,
  ): Promise<boolean> {
    return this.store.compareAndSwapSmtpSubmissionState(
      current.submission.accountId,
      current.submission.operationId,
      current.version,
      next,
    );
  }

  private emitSettled(
    identity: MailSmtpSubmissionIdentity,
    next: SubmissionRecord,
  ): void {
    this.emit(
      Object.freeze({
        event: "mail_smtp_operation_settled" as const,
        accountId: identity.accountId,
        operationId: identity.operationId,
        phase: next.phase,
      }),
    );
  }

  private async nextDelay(result: PassResult): Promise<number | null> {
    const nextRunnableAt = await this.store.nextRunnableSmtpAt();
    if (result.failures > 0) return this.idleRetryMs;
    if (nextRunnableAt === null) return this.idleRetryMs;
    if (!Number.isSafeInteger(nextRunnableAt) || nextRunnableAt < 0) {
      throw new Error("mail smtp worker retry time is invalid");
    }
    const delay = nextRunnableAt - this.readNow();
    if (delay > 0) return Math.min(delay, this.idleRetryMs);
    return this.continuationDelayMs;
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.timer !== null) return;
    const timer = setTimeout(() => {
      if (this.timer === timer) this.timer = null;
      void this.runNow().catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    this.timer = timer;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private observeFailure(
    errorCode: Extract<
      MailSmtpWorkerEvent,
      { readonly event: "mail_smtp_worker_failed" }
    >["errorCode"],
  ): void {
    if (this.unhealthy) return;
    this.unhealthy = true;
    this.emit(Object.freeze({ event: "mail_smtp_worker_failed", errorCode }));
  }

  private observeRecovery(): void {
    if (!this.unhealthy) return;
    this.unhealthy = false;
    this.emit(Object.freeze({ event: "mail_smtp_worker_recovered" }));
  }

  private emit(event: MailSmtpWorkerEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Observability must never change delivery semantics.
    }
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("mail smtp worker clock is invalid");
    }
    return now;
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.commandTail.then(operation, operation);
    this.commandTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function validateAccountId(value: string): string {
  if (!SAFE_ACCOUNT_ID.test(value)) {
    throw new Error("mail smtp worker account is invalid");
  }
  return value;
}

function validateDelay(value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_DELAY_MS) {
    throw new Error("mail smtp worker delay is invalid");
  }
  return value;
}

function validateBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new Error("mail smtp worker batch size is invalid");
  }
  return value;
}
